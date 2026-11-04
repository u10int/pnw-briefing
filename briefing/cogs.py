"""Export gridded products as Cloud-Optimized GeoTIFFs (EPSG:4326, float32, inches or percent).

One file per model, window and variable, plus the multi-model mean, spread and percent of
normal. Global models keep their native 0.25° grid; projected regional grids (HRRR, RRFS,
NAM, NBM) are resampled by nearest neighbour onto a regular 0.03° grid so every file is a
plain lat/lon raster any GIS, rio-tiler or geotiff.js can read.

The manifest returned here is written into briefing.json and drives the interactive map.
"""
from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from . import analysis

log = logging.getLogger(__name__)
REGIONAL_RES = 0.03


def write_cog(path: Path, lat, lon, data, units: str, description: str, *, dtype="float32",
              nodata=np.nan, scale=None, band_names=None):
    """Write a north-up COG from 1-D ascending lat/lon cell centres.

    `data` is [y, x] for one band or [band, y, x] for several (e.g. one band per forecast hour).
    With `scale`, values are stored as round(value / scale) in `dtype` and the scale is recorded
    in the file, so GIS tools read physical units back.
    """
    import rasterio
    import rasterio.shutil
    from rasterio.io import MemoryFile
    from rasterio.transform import from_origin

    arr = np.asarray(data, dtype="float32")
    arr = arr[None] if arr.ndim == 2 else arr
    arr = arr[:, ::-1]                                     # north-up
    if scale is not None:
        info = np.iinfo(dtype)
        q = np.round(arr / scale)
        q = np.where(np.isfinite(q), np.clip(q, info.min + 1, info.max), nodata)
        arr = q.astype(dtype)
    dx, dy = float(np.median(np.diff(lon))), float(np.median(np.diff(lat)))
    transform = from_origin(float(lon[0]) - dx / 2, float(lat[-1]) + dy / 2, dx, dy)
    profile = dict(driver="GTiff", height=arr.shape[1], width=arr.shape[2], count=arr.shape[0], dtype=dtype,
                   crs="EPSG:4326", transform=transform, nodata=nodata)
    with MemoryFile() as mem:
        with mem.open(**profile) as tmp:
            tmp.write(arr)
            tmp.update_tags(units=units, description=description)
            for b in range(arr.shape[0]):
                tmp.set_band_description(b + 1, band_names[b] if band_names else description)
            if scale is not None:
                tmp.scales = (scale,) * arr.shape[0]
                tmp.offsets = (0.0,) * arr.shape[0]
        with mem.open() as tmp:
            path.parent.mkdir(parents=True, exist_ok=True)
            rasterio.shutil.copy(tmp, str(path), driver="COG", compress="DEFLATE",
                                 predictor=3 if dtype == "float32" else 2,
                                 blocksize=256, overview_resampling="nearest" if scale else "average")
    return path


def _regular(m, field):
    """Field on a regular lat/lon grid: native for 1-D models, resampled for projected ones."""
    if m["lat"].ndim == 1:
        return m["lat"], m["lon"], field
    la, lo = m["lat"], m["lon"]
    glat = np.arange(np.nanmin(la), np.nanmax(la), REGIONAL_RES)
    glon = np.arange(np.nanmin(lo), np.nanmax(lo), REGIONAL_RES)
    return glat, glon, analysis.regrid(la, lo, field, glat, glon)


def export(grib_models, cfg, out_dir: Path, normals_grid=None):
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = []

    def add(rel, **meta):
        manifest.append({"path": f"cogs/{rel}", **meta})

    for w in analysis.windows(cfg):
        n = w["days"]
        covering = [m for m in grib_models if m["range_days"] >= n]
        for m in covering:
            run = m["run"].strftime("%HZ %-d %b") if m.get("run") else None
            lat, lon, f = _regular(m, m["precip_mm"][n] / 25.4)
            rel = f"{m['id']}_precip_{n}d.tif"
            write_cog(out_dir / rel, lat, lon, f, "in", f"{m['label']} precipitation, {w['label'].lower()}")
            add(rel, model=m["label"], tier=m.get("tier"), var="precip", days=n, units="in", run=run)
            if m.get("snow_in") is not None:
                lat, lon, f = _regular(m, m["snow_in"][n])
                rel = f"{m['id']}_snow_{n}d.tif"
                write_cog(out_dir / rel, lat, lon, f, "in", f"{m['label']} snowfall, {w['label'].lower()}")
                add(rel, model=m["label"], tier=m.get("tier"), var="snow", days=n, units="in", run=run)

        if len(covering) > 1:
            glat, glon = analysis.common_grid(cfg)
            stack = np.stack([analysis.regrid(m["lat"], m["lon"], m["precip_mm"][n] / 25.4, glat, glon) for m in covering])
            with np.errstate(all="ignore"):
                mean, spread = np.nanmean(stack, 0), np.nanmax(stack, 0) - np.nanmin(stack, 0)
            members = [m["label"] for m in covering]
            write_cog(out_dir / f"mean_precip_{n}d.tif", glat, glon, mean, "in", f"Multi-model mean precipitation, {w['label'].lower()}")
            add(f"mean_precip_{n}d.tif", model="Model mean", tier="consensus", var="precip", days=n, units="in", members=members)
            write_cog(out_dir / f"spread_precip_{n}d.tif", glat, glon, spread, "in", f"Model spread (max − min), {w['label'].lower()}")
            add(f"spread_precip_{n}d.tif", model="Model spread", tier="consensus", var="spread", days=n, units="in", members=members)
            if normals_grid is not None:
                normal = analysis.regrid(normals_grid["lat"], normals_grid["lon"],
                                         normals_grid["daily"][:n].sum(0), glat, glon)
                with np.errstate(all="ignore"):
                    pct = np.where(normal > 0.05, 100 * mean / normal, np.nan)
                write_cog(out_dir / f"pctnormal_precip_{n}d.tif", glat, glon, pct, "%",
                          f"Model mean as percent of 1991–2020 normal, {w['label'].lower()}")
                add(f"pctnormal_precip_{n}d.tif", model="Percent of normal", tier="consensus", var="pct", days=n,
                    units="%", members=members)
    total = sum((out_dir / Path(m["path"]).name).stat().st_size for m in manifest)
    log.info("wrote %d COGs (%.1f MB)", len(manifest), total / 1e6)
    return manifest
