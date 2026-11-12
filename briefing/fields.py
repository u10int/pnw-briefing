"""Time-stepped gridded fields for the interactive map: temperature, gusts, 10 m wind, sea-level
pressure, freezing level, simulated composite reflectivity and precipitation type.

Temperature and gusts reuse the samples fetch_model already downloads for daily highs, lows and
peak gusts (an `hourly` request adds only the hours those lack). Accumulated precipitation and
snowfall come from the same accumulation reads as the daily totals (grib.fetch_model). The rest are fetched here, one GRIB message at a time (anchored regex, as elsewhere),
in parallel over forecast hours.

Each model's fields are exported as one multi-band Cloud-Optimized GeoTIFF per variable, one
band per valid time, stored as int16 with a scale factor. Regional projected grids are resampled
to a regular 0.03° lat/lon grid; global models keep their native grid. A manifest is written to
data/fields.json for the page.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta, timezone
from pathlib import Path

import numpy as np

from . import analysis, cogs

log = logging.getLogger(__name__)
M_S_TO_MPH = 2.23694
REGIONAL_RES = 0.03
WORKERS = 8

# Stored as round(value / scale) in int16. Units are what the page shows.
VARS = {
    "t2m":   {"label": "Temperature",               "units": "°F",  "scale": 0.1},
    "gust":  {"label": "Wind gust",                 "units": "mph", "scale": 0.1},
    "u10":   {"label": "Wind (east component)",     "units": "mph", "scale": 0.1},
    "v10":   {"label": "Wind (north component)",    "units": "mph", "scale": 0.1},
    "mslp":  {"label": "Sea-level pressure",        "units": "hPa", "scale": 0.1},
    "frz":   {"label": "Freezing level",            "units": "ft",  "scale": 1.0},
    "refc":  {"label": "Composite reflectivity",    "units": "dBZ", "scale": 0.1},
    # instantaneous precipitation rate: the 3D view's falling precipitation and the radar readout
    "prate": {"label": "Precipitation rate",        "units": "in/h", "scale": 0.001},
    # water vapour transport (from the AR computation), kg m-1 s-1; the magnitude is drawn from these
    "ivtu":  {"label": "Water vapor transport (east component)",  "units": "kg/m/s", "scale": 0.1},
    "ivtv":  {"label": "Water vapor transport (north component)", "units": "kg/m/s", "scale": 0.1},
    # running totals from the start of the briefing (today's 12Z), from the model's own accumulations
    "apcp":  {"label": "Accumulated precipitation", "units": "in",  "scale": 0.01},
    "asnow": {"label": "Accumulated snowfall",      "units": "in",  "scale": 0.01},
    # fire weather: 2 m relative humidity, and HRRR/RRFS near-surface smoke (MASSDEN at 8 m)
    "rh":    {"label": "Relative humidity",         "units": "%",   "scale": 0.1},
    "smoke": {"label": "Near-surface smoke",        "units": "µg/m³", "scale": 0.1},
    "ptype": {"label": "Precipitation type",        "units": "",    "scale": 1.0,
              "categories": {0: "none", 1: "rain", 2: "snow", 3: "freezing rain", 4: "sleet", 5: "mix"}},
}

PATTERNS = {
    "ncep": {
        # NAM packs both components in one message whose index entry for UGRD is empty, so each
        # component also tries the other's record and picks its own variable by name.
        "u10": [":UGRD:10 m above ground:", ":VGRD:10 m above ground:"],
        "v10": [":VGRD:10 m above ground:", ":UGRD:10 m above ground:"],
        "mslp": [":MSLMA:mean sea level:", ":PRMSL:mean sea level:", ":MSLET:mean sea level:"],
        "frz": [":HGT:0C isotherm:"], "refc": [":REFC:entire atmosphere"],
        "t2m": [":TMP:2 m above ground:"], "gust": [":GUST:surface:", ":GUST:10 m above ground:"],
        "crain": [":CRAIN:surface:"], "csnow": [":CSNOW:surface:"],
        "cfrzr": [":CFRZR:surface:"], "cicep": [":CICEP:surface:"],
        "rh": [":RH:2 m above ground:"], "smoke": [":MASSDEN:8 m above ground:"],
        "prate": [":PRATE:surface:"],          # instantaneous first (GFS also has period averages)
    },
    "ecmwf": {"u10": [":10u:"], "v10": [":10v:"], "mslp": [":msl:"], "ptype": [":ptype:"],
              "t2m": [":2t:"], "gust": [":10fg:", ":10fg3:", ":10fg6:"],
              "d2m": [":2d:"], "prate": [":tprate:"]},      # 2 m dewpoint: humidity comes from it and the temperature
}

CONVERT = {
    "t2m": lambda k: (k - 273.15) * 9 / 5 + 32,
    "gust": lambda v: v * M_S_TO_MPH,
    "u10": lambda v: v * M_S_TO_MPH,
    "v10": lambda v: v * M_S_TO_MPH,
    "mslp": lambda p: p / 100.0,
    "frz": lambda m: m * 3.28084,
    "refc": lambda d: d,
    "prate": lambda r: np.clip(r, 0, None) * 3600 / 25.4,  # kg m-2 s-1 (mm/s) -> in/h
    "rh": lambda r: np.clip(r, 0, 100),
    "smoke": lambda m: np.clip(m, 0, None) * 1e9,       # kg/m³ -> µg/m³
}


def rh_from_dewpoint(t_f, td_k):
    """Relative humidity (%) from temperature (°F) and dewpoint (K), Magnus over water."""
    t, td = (np.asarray(t_f) - 32) * 5 / 9, np.asarray(td_k) - 273.15
    e = lambda x: np.exp(17.625 * x / (243.04 + x))
    return np.clip(100 * e(td) / e(t), 0, 100)

# ECMWF precipitation type code table -> our categories
ECMWF_PTYPE = {0: 0, 1: 1, 3: 3, 5: 2, 6: 2, 7: 5, 8: 4, 12: 3}


def _instant_first(rows):
    """Prefer instantaneous records over period averages/extremes (GFS carries both for CRAIN etc.)."""
    def rank(r):
        r = r.lower()
        return any(k in r for k in (" ave ", " acc ", " max ", " min ")), r
    return sorted(rows, key=rank)


# cfgrib variable names, so a message carrying several fields yields the right one
PREFER = {"u10": ["u10"], "v10": ["v10"]}


def _read_var(grib, H, patterns, dom, name=None, sites=None):
    """First record that reads and holds the wanted variable; later patterns are fallbacks. With
    `sites`, returns (values, values at those sites before cropping)."""
    last = None
    for p in patterns:
        for row in _instant_first(grib._rows(H, p)):
            try:
                if sites:
                    return grib._read_with_sites(H, row, dom, sites, prefer=PREFER.get(name))
                return grib._read(H, row, dom, prefer=PREFER.get(name))[2]
            except Exception as e:      # empty byte range, or the wrong variable in this message
                last = e
                break
    if last:
        raise last
    return None


def _wanted(spec):
    f = spec.get("fields") or {}
    stepped = list(f.get("stepped", []))
    hourly = list(f.get("hourly", []))
    expand = lambda vs: [x for v in vs for x in (("u10", "v10") if v == "wind" else (v,))]
    return expand(stepped), expand(hourly), int(f.get("hourly_hours", 48))


def field_hours(spec, lead0, last_hour, stepped_hours):
    """Every forecast hour on this model's map time axis after the briefing start: the stepped
    hours plus the hourly ones. Empty for a model with no map fields."""
    if not spec.get("fields"):
        return []
    _, hourly, hourly_hours = _wanted(spec)
    hrs = set(stepped_hours)
    if hourly:
        hrs |= set(range(lead0 + 1, min(last_hour, lead0 + hourly_hours) + 1))
    return sorted(h for h in hrs if lead0 < h <= last_hour)


def fetch(spec, run, lead0, last_hour, stepped_hours, samples, dom, sites=None):
    """{var: {"hours": [fxx...], "data": ndarray[t, y, x]}} in display units. Sea-level pressure
    also carries "sites": values at places outside the map area (`sites`), read before cropping."""
    from . import grib

    fam = spec["family"]
    out = {}
    # Temperature and gusts start from the samples already downloaded for the daily values; an
    # `hourly` request for either adds only the hours those samples don't have.
    for var in ("t2m", "gust"):
        s = samples.get(var) or {}
        if s:
            hrs = sorted(s)
            out[var] = {"hours": hrs, "data": CONVERT[var](np.stack([s[h] for h in hrs]))}

    stepped, hourly, hourly_hours = _wanted(spec)
    stepped = [v for v in stepped if v not in ("t2m", "gust")]      # always from the samples
    if not stepped and not hourly:
        return out
    hourly_hours_list = list(range(lead0 + 1, min(last_hour, lead0 + hourly_hours) + 1)) if hourly else []

    def raw_names(v):
        if v == "ptype" and fam == "ncep":
            return ["crain", "csnow", "cfrzr", "cicep"]
        if v == "rh" and fam == "ecmwf":
            return ["d2m"]
        return [v]

    plan: dict[int, list[str]] = {}
    for h in stepped_hours:
        plan.setdefault(h, []).extend(n for v in stepped for n in raw_names(v))
    for h in hourly_hours_list:
        plan.setdefault(h, []).extend(n for v in hourly for n in raw_names(v)
                                      if not (v in ("t2m", "gust") and h in (samples.get(v) or {})))
    if 0 in plan:          # analysis hour: accumulations/categoricals are absent; skip it
        plan.pop(0)

    def one(h):
        got = {}
        try:
            H = grib._H(spec, run, h)
        except Exception:
            return h, got
        for name in dict.fromkeys(plan[h]):
            pats = PATTERNS.get(fam, {}).get(name)
            if not pats:
                continue
            try:
                v = _read_var(grib, H, pats, dom, name, sites if name == "mslp" else None)
                if v is not None and name == "mslp" and sites:
                    got[name], got["mslp@sites"] = v
                elif v is not None:
                    got[name] = v
            except Exception as e:
                log.debug("%s %s f%03d: %s", spec["label"], name, h, e)
        return h, got

    with ThreadPoolExecutor(WORKERS) as ex:
        results = dict(ex.map(one, sorted(plan)))

    def collect(name):
        hrs = [h for h in sorted(results) if name in results[h]]
        return hrs, (np.stack([results[h][name] for h in hrs]) if hrs else None)

    if fam == "ecmwf" and "rh" in stepped + hourly:
        # ECMWF open data has dewpoint, not humidity: pair it with the temperature at the same hour
        hrs, arr = collect("d2m")
        temps = {h: out["t2m"]["data"][i] for i, h in enumerate(out.get("t2m", {}).get("hours", []))}
        keep = [k for k, h in enumerate(hrs) if h in temps]
        if arr is not None and keep:
            out["rh"] = {"hours": [hrs[k] for k in keep],
                         "data": np.stack([rh_from_dewpoint(temps[hrs[k]], arr[k]) for k in keep]).astype("float32")}
        else:
            log.info("%s: no humidity (dewpoint or temperature missing)", spec["label"])

    for var in [v for v in dict.fromkeys(stepped + hourly) if v != "ptype" and not (v == "rh" and fam == "ecmwf")]:
        hrs, arr = collect(var)
        if arr is not None and var in out:
            # hourly reads merged into the samples (t2m, gust)
            merged = {h: out[var]["data"][i] for i, h in enumerate(out[var]["hours"])}
            merged.update({h: CONVERT[var](arr[i]) for i, h in enumerate(hrs)})
            hs = sorted(merged)
            out[var] = {"hours": hs, "data": np.stack([merged[h] for h in hs])}
        elif arr is not None:
            out[var] = {"hours": hrs, "data": CONVERT[var](arr)}
        elif var not in out:
            log.info("%s: no %s field", spec["label"], var)

    if sites and "mslp" in out:
        hrs = out["mslp"]["hours"]
        sv = [results[h].get("mslp@sites") for h in hrs]
        if all(x is not None for x in sv):
            data = CONVERT["mslp"](np.stack(sv))                          # [t, site]
            out["mslp"]["sites"] = {"names": [p["name"] for p in sites], "data": data}
            reach = [p["name"] for k, p in enumerate(sites) if np.isfinite(data[:, k]).any()]
            log.info("%s: pressure outside the map at %s", spec["label"], ", ".join(reach) or "none (grid too small)")

    if "ptype" in stepped + hourly:
        if fam == "ncep":
            hrs = [h for h in sorted(results) if "crain" in results[h]]
            if hrs:
                cat = []
                for h in hrs:
                    r = results[h]
                    z = np.zeros_like(r["crain"])
                    rain, snow = r["crain"] >= 0.5, r.get("csnow", z) >= 0.5
                    frz, sleet = r.get("cfrzr", z) >= 0.5, r.get("cicep", z) >= 0.5
                    c = np.zeros(z.shape, dtype="float32")
                    c[rain] = 1
                    c[snow] = 2
                    c[rain & snow] = 5
                    c[sleet] = 4
                    c[frz] = 3          # freezing rain wins: it's the highest-impact type
                    cat.append(c)
                out["ptype"] = {"hours": hrs, "data": np.stack(cat)}
        else:
            hrs, arr = collect("ptype")
            if arr is not None:
                lut = np.zeros(256, dtype="float32")
                for k, v in ECMWF_PTYPE.items():
                    lut[k] = v
                out["ptype"] = {"hours": hrs, "data": lut[np.clip(np.nan_to_num(arr), 0, 255).astype(int)]}
        if "ptype" not in out:
            log.info("%s: no precipitation type field", spec["label"])

    got = ", ".join(f"{k} ({len(v['hours'])})" for k, v in out.items())
    log.info("%s fields: %s", spec["label"], got or "none")
    return out


def _export_ivt(m, out_dir: Path, manifest: list):
    """IVT components as time-stepped fields, on the IVT grid (regular lat/lon)."""
    ivt = m.get("ivt")
    if not ivt or not len(ivt.get("hours", [])):
        return
    lat, lon = np.asarray(ivt["lat"]), np.asarray(ivt["lon"])
    if lat.ndim != 1:
        return
    times = [(m["run"] + timedelta(hours=int(h))).replace(tzinfo=timezone.utc).isoformat() for h in ivt["hours"]]
    oi = np.argsort(lat)
    for var, key in (("ivtu", "u"), ("ivtv", "v")):
        meta = VARS[var]
        data = np.asarray(ivt[key], dtype="float32")[:, oi, :]
        rel = f"{m['id']}_{var}.tif"
        cogs.write_cog(out_dir / rel, lat[oi], lon, data, meta["units"], f"{m['label']} {meta['label'].lower()}",
                       dtype="int16", nodata=-32768, scale=meta["scale"], band_names=times)
        manifest.append({"path": f"fields/{rel}", "model": m["label"], "tier": m.get("tier", "global"), "var": var,
                         "units": meta["units"], "scale": meta["scale"], "nodata": -32768, "times": times,
                         "run": m["run"].strftime("%HZ %a %-m/%-d"),
                         "init": m["run"].replace(tzinfo=timezone.utc).isoformat()})


def export(grib_models, cfg, out_dir: Path):
    """Write one multi-band COG per model and variable; return the manifest."""
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    for m in grib_models:
        _export_ivt(m, out_dir, manifest)
        fl = m.get("fields") or {}
        if not fl:
            continue
        if m["lat"].ndim == 1:
            glat, glon, regrid = m["lat"], m["lon"], None
        else:
            la, lo = m["lat"], m["lon"]
            dom = cfg["domain"]
            glat = np.arange(max(np.nanmin(la), dom["lat_min"]), min(np.nanmax(la), dom["lat_max"]), REGIONAL_RES)
            glon = np.arange(max(np.nanmin(lo), dom["lon_min"]), min(np.nanmax(lo), dom["lon_max"]), REGIONAL_RES)
            regrid = analysis.Regridder(la, lo, glat, glon)
        for var, f in fl.items():
            data = regrid(f["data"]) if regrid else np.asarray(f["data"], dtype="float32")
            times = [(m["run"] + timedelta(hours=h)).replace(tzinfo=timezone.utc).isoformat() for h in f["hours"]]
            meta = VARS[var]
            rel = f"{m['id']}_{var}.tif"
            cogs.write_cog(out_dir / rel, glat, glon, data, meta["units"], f"{m['label']} {meta['label'].lower()}",
                           dtype="int16", nodata=-32768, scale=meta["scale"], band_names=times)
            entry = {"path": f"fields/{rel}", "model": m["label"], "tier": m.get("tier", "global"), "var": var,
                     "units": meta["units"], "scale": meta["scale"], "nodata": -32768, "times": times,
                     "run": m["run"].strftime("%HZ %a %-m/%-d"),
                     "init": m["run"].replace(tzinfo=timezone.utc).isoformat()}
            if "categories" in meta:
                entry["categories"] = meta["categories"]
            manifest.append(entry)
        m.pop("fields", None)        # free the arrays
    total = sum((out_dir / Path(e["path"]).name).stat().st_size for e in manifest)
    log.info("wrote %d time-stepped field files (%.1f MB)", len(manifest), total / 1e6)
    return manifest
