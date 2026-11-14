"""3-D fields through the depth of the atmosphere, for the interactive map's 3D view.

This runs on its own (`python -m briefing.volume`), in a workflow that starts once the briefing
is published, so the edition never waits on these downloads; the page keeps the previous volumes
until the new ones land.

GFS and ECMWF IFS publish their forecasts on pressure levels. For each model with `volume` in
its config, every `step` hours over the first `hours` of the briefing, this reads the levels from
1000 to 200 hPa (one byte-ranged request per forecast hour, as for IVT) and builds:

- temp:  temperature (°F)
- wind:  wind speed (mph); u, v: its eastward and northward components (m/s), for the page's
         wind particles at each height
- rh:    relative humidity (%)
- cloud: cloud fraction (%): GFS's own (TCDC on pressure levels); ECMWF publishes none on levels,
         so it's estimated from relative humidity (Sundqvist: cloud forms above 80%)
- water: liquid water (g/kg): cloud water plus rain (GFS only)
- ice:   ice and snow (g/kg): cloud ice, snow and graupel (GFS only)
- mflux: moisture flow ((g/kg)(m/s)): specific humidity times wind speed, the plume an
         atmospheric river carries (its sum through the column is IVT)
- w:     rising (+) and sinking (-) air (m/s): GFS's geometric vertical velocity; ECMWF's pressure
         velocity converted with the air's density
- pv:    potential vorticity (PVU), Ertel's on pressure levels from the wind and temperature;
         the 2 PVU surface is the dynamic tropopause, which dips toward the ground under upper lows
- hgt:   the pressure levels' own heights (m, as departures from each level's mean), for height
         contours on a level; stored per level rather than per height

Each column is resampled from its pressure levels onto a fixed height grid (0 – 12 km every
500 m) using the levels' geopotential heights, so the page can draw the volume to scale. Heights
below a column's lowest level take that level's value. Values are packed into one byte (255 =
missing) over a fixed range per variable (square-root spaced for the water and ice amounts, which
span orders of magnitude), one gzip file per model and variable holding every time step
[time, height, lat (south to north), lon (west to east)], with a manifest in data/volume.json.
"""
from __future__ import annotations

import argparse
import gzip
import json
import logging
import warnings
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta, timezone
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

TOP_KM, DZ_KM = 12.0, 0.5
HEIGHTS_M = np.arange(0, TOP_KM * 1000 + 1, DZ_KM * 1000)
# GFS has 25 – 50 hPa spacing; these keep the lower atmosphere (where cloud and the freezing level
# are) at about 500 m and cut the download to 143 records a step
LEVELS = {"ncep": [1000, 950, 900, 850, 800, 750, 700, 600, 500, 400, 300, 250, 200],
          "ecmwf": [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200]}
MISSING = 255

# value range, spacing, units and label for each variable (the page reads these from the manifest)
VARS = {
    "cloud": {"min": 0, "max": 100, "scale": "linear", "units": "%", "label": "Clouds"},
    "rh":    {"min": 0, "max": 100, "scale": "linear", "units": "%", "label": "Humidity"},
    "temp":  {"min": -80, "max": 90, "scale": "linear", "units": "°F", "label": "Temperature"},
    "wind":  {"min": 0, "max": 200, "scale": "linear", "units": "mph", "label": "Wind speed"},
    "u":     {"min": -100, "max": 100, "scale": "linear", "units": "m/s", "label": "Wind, eastward"},
    "v":     {"min": -100, "max": 100, "scale": "linear", "units": "m/s", "label": "Wind, northward"},
    "water": {"min": 0, "max": 2.0, "scale": "sqrt", "units": "g/kg", "label": "Liquid water"},
    "ice":   {"min": 0, "max": 2.0, "scale": "sqrt", "units": "g/kg", "label": "Ice and snow"},
    "mflux": {"min": 0, "max": 500, "scale": "sqrt", "units": "g/kg·m/s", "label": "Moisture flow"},
    "w":     {"min": -2, "max": 2, "scale": "linear", "units": "m/s", "label": "Rising and sinking air"},
    "pv":    {"min": -2, "max": 10, "scale": "linear", "units": "PVU", "label": "Potential vorticity"},
    "hgt":   {"min": -900, "max": 900, "scale": "linear", "units": "m", "label": "Height of pressure levels"},
}
# drawn on the page as contours on these levels (when the model has them)
HGT_LEVELS = (850, 700, 500, 300)
NOTES = {"cloud": {"ecmwf": "Estimated from relative humidity (ECMWF publishes no cloud on pressure levels).",
                   "condensate": "From the model's own cloud water and ice (it publishes no cloud cover on pressure levels), so it lines up with its simulated radar."}}

# GRIB records to read, and the cfgrib names (or GRIB names) each lands under
PATTERN = {"ncep": r":(HGT|TMP|RH|UGRD|VGRD|SPFH|DZDT|CLMR|ICMR|RWMR|SNMR|GRLE|TCDC):({levels}) mb:",
           "ecmwf": r":(gh|t|r|u|v|q|w):({levels}):pl:"}
NAMES = {
    "gh": ["gh", "geopotential height"], "t": ["t", "temperature"], "r": ["r", "relative humidity"],
    "u": ["u", "u component of wind"], "v": ["v", "v component of wind"],
    "q": ["q", "specific humidity"],
    # vertical motion: GFS's geometric velocity (m/s, DZDT); ECMWF's is pressure velocity (Pa/s)
    "wz": ["wz", "dzdt", "geometric vertical velocity"], "omega": ["w", "vertical velocity"],
    "clwmr": ["clwmr", "clmr", "cloud mixing ratio"], "icmr": ["icmr", "cimixr", "ice water mixing ratio", "ice mixing ratio", "cloud ice mixing ratio"],
    "rwmr": ["rwmr", "rain mixing ratio"], "snmr": ["snmr", "snow mixing ratio"],
    "grle": ["grle", "graupel", "graupel (snow pellets)"], "tcc": ["tcc", "tcdc", "total cloud cover", "cloud cover"],
}


def _key(name, da):
    """Which of NAMES a cfgrib variable is, by its name or its GRIB name."""
    cands = {name.lower(), str(da.attrs.get("GRIB_shortName", "")).lower(), str(da.attrs.get("GRIB_name", "")).lower(),
             str(da.attrs.get("GRIB_cfVarName", "")).lower()}
    for k, aliases in NAMES.items():
        if cands & set(aliases):
            return k
    return None


def to_heights(values, heights, targets=HEIGHTS_M):
    """Resample [level, y, x] values (levels in any order) onto fixed heights using each column's
    level heights [level, y, x]: linear in height, held at the ends."""
    order = np.argsort(np.nanmean(heights.reshape(len(heights), -1), axis=1))
    h, v = heights[order], values[order]
    L = len(h)
    k = (h[None] <= np.asarray(targets, dtype="float64")[:, None, None, None]).sum(axis=1)     # [z, y, x]
    lo = np.clip(k - 1, 0, L - 2)
    hi = lo + 1
    take = lambda a, i: np.take_along_axis(a[None].repeat(len(targets), 0), i[:, None], axis=1)[:, 0]
    h0, h1, v0, v1 = take(h, lo), take(h, hi), take(v, lo), take(v, hi)
    with np.errstate(invalid="ignore", divide="ignore"):
        w = np.clip((np.asarray(targets)[:, None, None] - h0) / (h1 - h0), 0, 1)
    return (v0 + w * (v1 - v0)).astype("float32")


def cloud_from_condensate(qc, qi):
    """Cloud (%) from cloud water and cloud ice mixing ratios (kg/kg), for models whose pressure
    levels carry no cloud cover (HRRR, RRFS): none below 0.001 g/kg of condensate, full by 0.1 g/kg,
    log-spaced in between, so it follows the same microphysics as the model's radar."""
    q = 1000 * (np.nan_to_num(np.asarray(qc, dtype="float32")) + np.nan_to_num(np.asarray(qi, dtype="float32")))
    with np.errstate(divide="ignore"):
        x = (np.log10(np.maximum(q, 1e-9)) + 3) / 2
    return (100 * np.clip(x, 0, 1)).astype("float32")


def cloud_from_rh(rh, rh_crit=80.0):
    """Cloud fraction (%) from relative humidity (%), Sundqvist et al. (1989)."""
    x = np.clip((100 - np.asarray(rh, dtype="float32")) / (100 - rh_crit), 0, 1)
    return (100 * (1 - np.sqrt(x))).astype("float32")


def potential_vorticity(t, u, v, levels, lat, lon):
    """Ertel's potential vorticity (PVU) on pressure levels [level, y, x]: -g (ζ + f) ∂θ/∂p plus the
    tilting terms, g (∂v/∂p ∂θ/∂x - ∂u/∂p ∂θ/∂y), with derivatives on the sphere."""
    p = np.asarray(levels, dtype="float64") * 100                       # Pa
    theta = t * (100000 / p[:, None, None]) ** 0.2857
    lat = np.asarray(lat, dtype="float64")
    lon = np.asarray(lon, dtype="float64")
    R_E, OMEGA, G = 6.371e6, 7.292e-5, 9.80665
    y = np.radians(lat) * R_E                                            # m north
    coslat = np.cos(np.radians(lat))[None, :, None]
    x = np.radians(lon) * R_E                                            # m east at the equator

    def ddx(a): return np.gradient(a, x, axis=2) / coslat
    def ddy(a): return np.gradient(a, y, axis=1)
    def ddp(a): return np.gradient(a, p, axis=0)
    # relative vorticity on the sphere: ∂v/∂x - ∂(u cos φ)/∂y / cos φ
    zeta = ddx(v) - np.gradient(u * coslat, y, axis=1) / coslat
    f = 2 * OMEGA * np.sin(np.radians(lat))[None, :, None]
    pv = -G * ((zeta + f) * ddp(theta) - ddp(v) * ddx(theta) + ddp(u) * ddy(theta))
    return (pv * 1e6).astype("float32")


def derive(got, family, levels=None, lat=None, lon=None, cloud="auto"):
    """{var: [level, y, x]} in display units from the raw records on pressure levels (`levels`,
    hPa, for turning ECMWF's pressure velocity into m/s and for potential vorticity, which also
    needs the grid's `lat` and `lon`)."""
    out = {}
    if "t" in got:
        out["temp"] = (got["t"] - 273.15) * 9 / 5 + 32
    if "u" in got and "v" in got:
        out["wind"] = np.hypot(got["u"], got["v"]) * 2.23694
        out["u"], out["v"] = got["u"], got["v"]
    if "r" in got:
        out["rh"] = np.clip(got["r"], 0, 100)
    if cloud == "condensate" and "clwmr" in got and "icmr" in got:
        out["cloud"] = cloud_from_condensate(got["clwmr"], got["icmr"])
    elif "tcc" in got:
        out["cloud"] = np.clip(got["tcc"], 0, 100)
    elif "r" in got:
        out["cloud"] = cloud_from_rh(got["r"])
    if "clwmr" in got:
        out["water"] = 1000 * (got["clwmr"] + got.get("rwmr", 0))
    if "icmr" in got:
        out["ice"] = 1000 * (got["icmr"] + got.get("snmr", 0) + got.get("grle", 0))
    # moisture flow: specific humidity times wind speed, (g/kg)(m/s); its sum through the column
    # is what IVT measures
    if "q" in got and "u" in got and "v" in got:
        out["mflux"] = 1000 * np.clip(got["q"], 0, None) * np.hypot(got["u"], got["v"])
    # rising (+) and sinking (-) air, m/s
    if "wz" in got:
        out["w"] = got["wz"]
    elif "omega" in got and "t" in got and levels is not None:
        p = np.asarray(levels, dtype="float32").reshape(-1, *([1] * (got["omega"].ndim - 1))) * 100
        rho = p / (287.05 * got["t"])
        out["w"] = -got["omega"] / (rho * 9.81)
    if all(k in got for k in ("t", "u", "v")) and levels is not None and lat is not None and len(levels) >= 3:
        out["pv"] = potential_vorticity(got["t"], got["u"], got["v"], levels, lat, lon)
    return {k: np.asarray(v, dtype="float32") for k, v in out.items()}


def pack(values, var):
    """Float values -> uint8 over the variable's range (255 where missing)."""
    spec = VARS[var]
    x = (np.asarray(values, dtype="float32") - spec["min"]) / (spec["max"] - spec["min"])
    ok = np.isfinite(x)
    x = np.clip(np.where(ok, x, 0), 0, 1)
    if spec["scale"] == "sqrt":
        x = np.sqrt(x)
    out = np.round(x * 254).astype("uint8")
    out[~ok] = MISSING
    return out


def unpack(b, var):
    spec = VARS[var]
    x = b.astype("float32") / 254
    if spec["scale"] == "sqrt":
        x = x * x
    v = spec["min"] + x * (spec["max"] - spec["min"])
    v[b == MISSING] = np.nan
    return v


def fetch(spec, run, lead0, dom, hours=48, step=3, cloud="auto", res=0.05, unknown=None, vars=None, more=None):
    """{"hours", "lat", "lon", "levels": {hPa: mean height m}, "vars": {var: [t, z, y, x]}}, or None.

    Projected grids (HRRR, RRFS: 2-D latitude and longitude) are put on a regular `res`° grid over
    the domain first (nearest neighbour, missing outside the model's coverage), so every volume is
    a lat/lon box the page can draw. `cloud="condensate"` takes cloud from the model's cloud water
    and ice instead of cloud cover or humidity. `unknown` names the one record eccodes can't (HRRR's
    cloud ice, CIMIXR, arrives as "unknown"); `vars` keeps only those variables (and the heights);
    `more` adds GRIB names to the records read (e.g. "CIMIXR")."""
    import threading

    from .analysis import Regridder
    from .grib import _H, _crop, _retry
    regrid = {}
    lock = threading.Lock()

    def regular(la, lo):
        """A regridder from this projected grid to the regular one, made once."""
        with lock:
            if "r" not in regrid:
                glat = np.arange(dom["lat_min"], dom["lat_max"] + res / 2, res)
                glon = np.arange(dom["lon_min"], dom["lon_max"] + res / 2, res)
                regrid["r"], regrid["lat"], regrid["lon"] = Regridder(la, lo, glat, glon), glat, glon
            return regrid["r"], regrid["lat"], regrid["lon"]
    fam = spec["family"]
    levels = LEVELS[fam]
    pattern = PATTERN[fam].format(levels="|".join(map(str, levels)))
    if more:
        pattern = pattern.replace(":(", f":({more}|", 1)
    want = [h for h in range(lead0, lead0 + hours + 1) if h > 0 and h % step == 0 and h <= spec["max_hours"]]
    why = {}                                    # forecast hour -> why it couldn't be read

    def one(h):
        try:
            ds = _retry(_H(spec, run, h).xarray, pattern, remove_grib=True)
            ds = ds if isinstance(ds, list) else [ds]
            got, levs, lat, lon = {}, None, None, None
            for d in ds:
                for name in d.data_vars:
                    da = d[name]
                    if "isobaricInhPa" not in da.dims:
                        continue
                    k = _key(name, da) or (unknown if name == "unknown" else None)
                    if not k or k in got:
                        continue
                    da = da.sel(isobaricInhPa=[p for p in levels if p in da["isobaricInhPa"].values])
                    la, lo, vals = _crop(da, dom)
                    p = list(da["isobaricInhPa"].values)
                    if levs is None:
                        levs, lat, lon = p, la, lo
                    if p != levs:                  # a field on fewer levels: put it on the full set
                        full = np.full((len(levs), *vals.shape[1:]), np.nan, dtype="float32")
                        for i, x in enumerate(p):
                            if x in levs:
                                full[levs.index(x)] = vals[i]
                        vals = full
                    got[k] = vals
            if lat is not None and np.ndim(lat) == 2:
                rg, lat, lon = regular(lat, lon)
                got = {k: rg(v) for k, v in got.items()}
            if "gh" not in got or "t" not in got:
                seen = sorted({f"{n}{tuple(d[n].dims)}" for d in ds for n in d.data_vars})
                why[h] = f"no heights or temperature among {', '.join(seen) or 'no fields'}"
                return h, None
            heights = got.pop("gh")
            return h, (lat, lon, levs, heights, {k: to_heights(v, heights) for k, v in derive(got, fam, levs, lat, lon, cloud).items()
                                                 if not vars or k in vars})
        except Exception as e:
            why[h] = f"{type(e).__name__}: {e}"
            log.debug("%s volume f%03d: %s", spec["label"], h, e)
            return h, None

    with ThreadPoolExecutor(4) as ex:
        res = [(h, r) for h, r in ex.map(one, want) if r is not None]
    if why:
        first = min(why)
        log.warning("%s volume: %d of %d steps unreadable (f%03d: %s)", spec["label"], len(why), len(want), first, str(why[first])[:300])
    if not res:
        return None
    lat, lon, levs = res[0][1][0], res[0][1][1], res[0][1][2]
    names = sorted(set.intersection(*(set(r[4]) for _, r in res)))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)          # columns outside a regional model's coverage
        mean_h = np.nanmean(np.stack([r[3] for _, r in res]), axis=(0, 2, 3))
    log.info("%s volume: %d steps, %s", spec["label"], len(res), ", ".join(names))
    keep = [i for i, p in enumerate(levs) if p in HGT_LEVELS]
    return {"hours": [h for h, _ in res], "lat": lat, "lon": lon, "family": "condensate" if cloud == "condensate" else fam,
            "levels": {int(p): float(z) for p, z in zip(levs, mean_h)},
            "vars": {k: np.stack([r[4][k] for _, r in res]) for k in names},
            # the chosen levels' heights [t, level, y, x], as departures from each level's mean
            "hgt": {"hPa": [int(levs[i]) for i in keep], "mean": [float(mean_h[i]) for i in keep],
                    "values": np.stack([r[3][keep] for _, r in res]) - mean_h[keep][None, :, None, None]} if keep else None}


def export(models, out_dir: Path):
    """Write each model's volume files; return the manifest for data/volume.json."""
    out = []
    for m in models:
        vol = m.get("volume")
        if not vol:
            continue
        out_dir.mkdir(parents=True, exist_ok=True)
        times = [(m["run"] + timedelta(hours=h)).replace(tzinfo=timezone.utc).isoformat() for h in vol["hours"]]
        lat, lon = np.asarray(vol["lat"]), np.asarray(vol["lon"])
        entry = {"model": m["label"], "run": m["run"].strftime("%HZ %a %-m/%-d"), "times": times,
                 "nx": len(lon), "ny": len(lat), "nz": len(HEIGHTS_M), "topKm": TOP_KM, "dzKm": DZ_KM,
                 "lat": [float(lat[0]), float(lat[-1])], "lon": [float(lon[0]), float(lon[-1])],
                 "levels": [{"hPa": p, "km": round(z / 1000, 2)} for p, z in sorted(vol["levels"].items(), reverse=True)],
                 "vars": {}}
        for var, a in vol["vars"].items():
            if var not in VARS:
                continue
            rel = f"{m['id']}_{var}.bin.gz"
            (out_dir / rel).write_bytes(gzip.compress(pack(a, var).tobytes(), 6))
            note = NOTES.get(var, {}).get(vol.get("family", ""))
            entry["vars"][var] = {"path": f"volume/{rel}", **VARS[var], **({"note": note} if note else {})}
        hg = vol.get("hgt")
        if hg and entry["vars"]:
            rel = f"{m['id']}_hgt.bin.gz"
            (out_dir / rel).write_bytes(gzip.compress(pack(hg["values"], "hgt").tobytes(), 6))
            entry["vars"]["hgt"] = {"path": f"volume/{rel}", **VARS["hgt"], "hPa": hg["hPa"], "meanM": [round(x, 1) for x in hg["mean"]]}
        if entry["vars"]:
            out.append(entry)
        m.pop("volume", None)
    if out:
        mb = sum(f.stat().st_size for f in out_dir.glob("*.gz")) / 1e6
        log.info("wrote %d model volumes (%.1f MB)", len(out), mb)
    return out


# ---------------------------------------------------------------- demo

def demo_volume(spec, run, dom, family, hours=48, step=3, seed=0):
    """A synthetic Pacific storm moving onshore: a comma cloud with a warm conveyor of liquid water,
    ice aloft, a jet near 9 km and a freezing level falling behind the front."""
    rng = np.random.default_rng(seed)
    lat = np.arange(dom["lat_min"], dom["lat_max"] + 1e-6, 0.25)
    lon = np.arange(dom["lon_min"], dom["lon_max"] + 1e-6, 0.25)
    hrs = list(range(step, hours + 1, step))
    Y, X = np.meshgrid(lat, lon, indexing="ij")
    z = HEIGHTS_M[:, None, None] / 1000
    smooth = rng.normal(0, 1, (len(lat), len(lon)))
    for _ in range(4):
        smooth = (smooth + np.roll(smooth, 1, 0) + np.roll(smooth, -1, 0) + np.roll(smooth, 1, 1) + np.roll(smooth, -1, 1)) / 5
    out = {k: [] for k in ("temp", "wind", "rh", "cloud", "water", "ice", "u", "v", "mflux", "w", "pv")}
    levs = LEVELS[family]
    std = {1000: 110, 975: 320, 950: 540, 925: 760, 900: 990, 850: 1460, 800: 1950, 750: 2470, 700: 3010, 650: 3590,
           600: 4210, 550: 4870, 500: 5570, 450: 6330, 400: 7180, 350: 8110, 300: 9160, 250: 10360, 200: 11780}
    hlev = [p for p in levs if p in HGT_LEVELS]
    hgt = []
    for h in hrs:
        cx = dom["lon_min"] + 1.0 + (h / hours) * 7.5               # the front moves east
        band = np.exp(-(((X - cx) - 0.6 * (Y - 47)) / 1.4) ** 2)     # a tilted frontal band
        comma = np.exp(-(((X - cx + 2.5) ** 2) / 6 + ((Y - 49.5) ** 2) / 1.5))
        moist = np.clip(0.55 + 0.45 * np.maximum(band, comma) + 0.08 * smooth, 0, 1)
        behind = 1 / (1 + np.exp((X - cx) * 2))                      # cold air behind the front
        sfc = 52 - 9 * behind - 0.8 * (Y - 47)
        temp = sfc[None] - 3.6 * z * (1 + 0.15 * z / 12) * 3.0
        rh = 100 * np.clip(moist[None] * (1 - 0.05 * z) + 0.05 * np.sin(z * 1.3), 0.05, 1)
        rh = np.where(z > 9.5, rh * 0.5, rh)
        jet = 150 * np.exp(-((z - 9.2) / 1.6) ** 2) * np.exp(-((Y - 46.5 - 0.4 * (X - cx)) / 2.2) ** 2)[None]
        wind = 15 + 6 * z + jet + 45 * band[None] * np.exp(-((z - 1.2) / 1.0) ** 2)     # a low-level jet along the front
        cloud = cloud_from_rh(rh)
        water = np.where(temp > 18, 1.4 * band[None] * np.exp(-((z - 2) / 1.6) ** 2) * (rh / 100) ** 6, 0)
        ice = np.where(temp < 32, 0.9 * np.maximum(band, comma)[None] * np.exp(-((z - 6.5) / 2.2) ** 2) * (rh / 100) ** 4, 0)
        # mostly from the south-west, backing to the west with height
        ang = np.radians(35 + 25 * np.clip(z / 9, 0, 1)) + 0.25 * band[None]
        u, v = wind / 2.23694 * np.cos(ang), wind / 2.23694 * np.sin(ang)
        # moisture: most near the surface, carried fastest in the low-level jet along the front
        q = 9.0 * np.exp(-z / 2.4) * (rh / 100) ** 1.5                        # g/kg
        mflux = q * wind / 2.23694
        # lift along the front and up the windward Cascades and Olympics, sinking in their lee
        oro = np.exp(-((X + 121.75) / 0.3) ** 2) - 0.8 * np.exp(-((X + 121.15) / 0.3) ** 2) \
            + 0.7 * (np.exp(-((X + 123.85) / 0.25) ** 2) - 0.6 * np.exp(-((X + 123.3) / 0.25) ** 2)) * np.exp(-((Y - 47.8) / 0.4) ** 2)
        w = 0.35 * band[None] * np.sin(np.pi * np.clip(z / 10, 0, 1)) + 0.6 * oro[None] * np.exp(-z / 3) - 0.05 * behind[None]
        # an upper trough behind the front: the tropopause (2 PVU) folds down from 10.5 km to about
        # 5 km in a lobe over the cold air, and the levels' heights dip under it
        trough = np.exp(-(((X - cx + 2.2) / 1.6) ** 2 + ((Y - 48.8) / 1.3) ** 2))
        zt = 10.5 - 5.5 * trough - 0.6 * smooth
        pv = 0.4 + 0.25 * z / 12 + 6.5 / (1 + np.exp(-(z - zt[None]) / 0.45))
        hgt.append(np.stack([-(40 + 0.06 * std[p]) * (2.2 * trough + 0.6 * (Y - 47) / 4) + 25 * smooth for p in hlev]))
        for k, v in (("temp", temp), ("wind", wind), ("rh", rh), ("cloud", cloud), ("water", water), ("ice", ice), ("u", u), ("v", v),
                     ("mflux", mflux), ("w", w), ("pv", pv)):
            out[k].append(np.asarray(v, dtype="float32"))
    keep = ("temp", "wind", "u", "v", "rh", "cloud", "mflux", "w", "pv") + (("water", "ice") if family == "ncep" else ())
    return {"hours": hrs, "lat": lat, "lon": lon, "family": family, "levels": {p: float(std[p]) for p in levs},
            "vars": {k: np.stack(out[k]) for k in keep},
            "hgt": {"hPa": hlev, "mean": [float(std[p]) for p in hlev], "values": np.stack(hgt).astype("float32")}}


# ---------------------------------------------------------------- standalone run

def latest_run(spec, start, hours):
    """The newest cycle at or before `start` whose step `hours` past the start is readable."""
    from .grib import _readable
    for back in range(0, 30):
        run = start - timedelta(hours=back)
        if run.hour not in spec.get("cycles", [0, 12]):
            continue
        last = back + hours
        last -= last % 3
        try:
            if _readable(spec, run, min(last, spec["max_hours"])):
                return run, back
        except Exception as e:
            log.info("%s %s: not usable (%s)", spec["label"], run.strftime("%HZ"), e)
    return None, None


def build(cfg, out: Path, demo=False):
    """Fetch (or synthesise) every configured model's volume and write data/volume.json."""
    from .grib import day0
    start = day0(cfg)
    models = []
    for i, spec in enumerate(s for s in cfg["grib_models"] if s.get("volume") and s.get("enabled", True)):
        opts = dict(spec["volume"]) if isinstance(spec["volume"], dict) else {}
        # Herbie options for the pressure levels only (e.g. the IFS's 0.25° file, which holds them)
        if opts.get("herbie"):
            spec = {**spec, "herbie": {**spec["herbie"], **opts.pop("herbie")}}
        if demo:
            run = start - timedelta(hours=6)
            models.append({"id": spec["id"], "label": spec["label"], "run": run,
                           "volume": demo_volume(spec, run, cfg["domain"], spec["family"], seed=i)})
            continue
        run, lead0 = latest_run(spec, start, opts.get("hours", 48))
        if run is None:
            log.warning("%s: no run with pressure levels out to %d h", spec["label"], opts.get("hours", 48))
            continue
        try:
            vol = fetch(spec, run, lead0, cfg["domain"], **opts)
        except Exception as e:
            log.warning("%s: 3D volume failed (%s)", spec["label"], e)
            vol = None
        if vol:
            models.append({"id": spec["id"], "label": spec["label"], "run": run, "volume": vol})
        else:
            log.warning("%s: no 3D volume from the %s run", spec["label"], run.strftime("%HZ %d %b"))
    manifest = export(models, out / "volume")
    (out / "volume.json").write_text(json.dumps({"cycle": start.strftime("%Y-%m-%dT%HZ"), "volumes": manifest}), encoding="utf-8")
    return manifest


def main():
    import os

    import yaml
    ap = argparse.ArgumentParser(description="Pressure-level volumes for the map's 3D view")
    ap.add_argument("--config", default=str(Path(__file__).resolve().parent.parent / "config.yaml"))
    ap.add_argument("--out", default="web/public/data")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--cycle", help="the edition's model cycle, e.g. 2026-11-07T18Z")
    a = ap.parse_args()
    if a.cycle:
        os.environ["BRIEFING_CYCLE"] = a.cycle
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("herbie").setLevel(logging.WARNING)
    cfg = yaml.safe_load(open(a.config))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    got = build(cfg, out, demo=a.demo)
    if not got:
        raise SystemExit("no volumes written")


if __name__ == "__main__":
    main()
