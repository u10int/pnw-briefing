"""3-D fields through the depth of the atmosphere, for the interactive map's 3D view.

This runs on its own (`python -m briefing.volume`), in a workflow that starts once the briefing
is published, so the edition never waits on these downloads; the page keeps the previous volumes
until the new ones land.

GFS and ECMWF IFS publish their forecasts on pressure levels. For each model with `volume` in
its config, every `step` hours over the first `hours` of the briefing, this reads the levels from
1000 to 200 hPa (one byte-ranged request per forecast hour, as for IVT) and builds:

- temp:  temperature (°F)
- wind:  wind speed (mph)
- rh:    relative humidity (%)
- cloud: cloud fraction (%): GFS's own (TCDC on pressure levels); ECMWF publishes none on levels,
         so it's estimated from relative humidity (Sundqvist: cloud forms above 80%)
- water: liquid water (g/kg): cloud water plus rain (GFS only)
- ice:   ice and snow (g/kg): cloud ice, snow and graupel (GFS only)

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
    "water": {"min": 0, "max": 2.0, "scale": "sqrt", "units": "g/kg", "label": "Liquid water"},
    "ice":   {"min": 0, "max": 2.0, "scale": "sqrt", "units": "g/kg", "label": "Ice and snow"},
}
NOTES = {"cloud": {"ecmwf": "Estimated from relative humidity (ECMWF publishes no cloud on pressure levels)."}}

# GRIB records to read, and the cfgrib names (or GRIB names) each lands under
PATTERN = {"ncep": r":(HGT|TMP|RH|UGRD|VGRD|CLMR|ICMR|RWMR|SNMR|GRLE|TCDC):({levels}) mb:",
           "ecmwf": r":(gh|t|r|u|v):({levels}):pl:"}
NAMES = {
    "gh": ["gh", "geopotential height"], "t": ["t", "temperature"], "r": ["r", "relative humidity"],
    "u": ["u", "u component of wind"], "v": ["v", "v component of wind"],
    "clwmr": ["clwmr", "clmr", "cloud mixing ratio"], "icmr": ["icmr", "ice water mixing ratio", "ice mixing ratio"],
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


def cloud_from_rh(rh, rh_crit=80.0):
    """Cloud fraction (%) from relative humidity (%), Sundqvist et al. (1989)."""
    x = np.clip((100 - np.asarray(rh, dtype="float32")) / (100 - rh_crit), 0, 1)
    return (100 * (1 - np.sqrt(x))).astype("float32")


def derive(got, family):
    """{var: [level, y, x]} in display units from the raw records on pressure levels."""
    out = {}
    if "t" in got:
        out["temp"] = (got["t"] - 273.15) * 9 / 5 + 32
    if "u" in got and "v" in got:
        out["wind"] = np.hypot(got["u"], got["v"]) * 2.23694
    if "r" in got:
        out["rh"] = np.clip(got["r"], 0, 100)
    if "tcc" in got:
        out["cloud"] = np.clip(got["tcc"], 0, 100)
    elif "r" in got:
        out["cloud"] = cloud_from_rh(got["r"])
    if "clwmr" in got:
        out["water"] = 1000 * (got["clwmr"] + got.get("rwmr", 0))
    if "icmr" in got:
        out["ice"] = 1000 * (got["icmr"] + got.get("snmr", 0) + got.get("grle", 0))
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


def fetch(spec, run, lead0, dom, hours=48, step=3):
    """{"hours", "lat", "lon", "levels": {hPa: mean height m}, "vars": {var: [t, z, y, x]}}, or None."""
    from .grib import _H, _crop, _retry
    fam = spec["family"]
    levels = LEVELS[fam]
    pattern = PATTERN[fam].format(levels="|".join(map(str, levels)))
    want = [h for h in range(lead0, lead0 + hours + 1) if h > 0 and h % step == 0 and h <= spec["max_hours"]]

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
                    k = _key(name, da)
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
            if "gh" not in got or "t" not in got:
                return h, None
            heights = got.pop("gh")
            return h, (lat, lon, levs, heights, {k: to_heights(v, heights) for k, v in derive(got, fam).items()})
        except Exception as e:
            log.debug("%s volume f%03d: %s", spec["label"], h, e)
            return h, None

    with ThreadPoolExecutor(4) as ex:
        res = [(h, r) for h, r in ex.map(one, want) if r is not None]
    if not res:
        return None
    lat, lon, levs = res[0][1][0], res[0][1][1], res[0][1][2]
    names = sorted(set.intersection(*(set(r[4]) for _, r in res)))
    mean_h = np.nanmean(np.stack([r[3] for _, r in res]), axis=(0, 2, 3))
    log.info("%s volume: %d steps, %s", spec["label"], len(res), ", ".join(names))
    return {"hours": [h for h, _ in res], "lat": lat, "lon": lon, "family": fam,
            "levels": {int(p): float(z) for p, z in zip(levs, mean_h)},
            "vars": {k: np.stack([r[4][k] for _, r in res]) for k in names}}


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
    out = {k: [] for k in ("temp", "wind", "rh", "cloud", "water", "ice")}
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
        wind = 15 + 6 * z + jet + 20 * band[None] * np.exp(-((z - 1.2) / 1.0) ** 2)
        cloud = cloud_from_rh(rh)
        water = np.where(temp > 18, 1.4 * band[None] * np.exp(-((z - 2) / 1.6) ** 2) * (rh / 100) ** 6, 0)
        ice = np.where(temp < 32, 0.9 * np.maximum(band, comma)[None] * np.exp(-((z - 6.5) / 2.2) ** 2) * (rh / 100) ** 4, 0)
        for k, v in (("temp", temp), ("wind", wind), ("rh", rh), ("cloud", cloud), ("water", water), ("ice", ice)):
            out[k].append(np.asarray(v, dtype="float32"))
    keep = ("temp", "wind", "rh", "cloud", "water", "ice") if family == "ncep" else ("temp", "wind", "rh", "cloud")
    levs = LEVELS[family]
    std = {1000: 110, 975: 320, 950: 540, 925: 760, 900: 990, 850: 1460, 800: 1950, 750: 2470, 700: 3010, 650: 3590,
           600: 4210, 550: 4870, 500: 5570, 450: 6330, 400: 7180, 350: 8110, 300: 9160, 250: 10360, 200: 11780}
    return {"hours": hrs, "lat": lat, "lon": lon, "family": family, "levels": {p: float(std[p]) for p in levs},
            "vars": {k: np.stack(out[k]) for k in keep}}


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
        opts = spec["volume"] if isinstance(spec["volume"], dict) else {}
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
