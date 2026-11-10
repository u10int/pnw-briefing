"""Preflight: is the environment able to do a live run? Prints and annotates; never fails the job.

    python -m briefing.check

Checks package versions, that eccodes can build a GRIB message, that each data host answers,
and one real end-to-end GRIB read (latest GFS precipitation through Herbie and cfgrib).
"""
from __future__ import annotations

import importlib
import platform
import sys
from datetime import datetime, timedelta, timezone

import requests

from . import report

HOSTS = {
    "NOAA NODD (AWS)": "https://noaa-gfs-bdp-pds.s3.amazonaws.com/",
    "NOAA NOMADS": "https://nomads.ncep.noaa.gov/",
    "ECMWF open data": "https://data.ecmwf.int/forecasts/",
    "ECMWF open data mirror (Google)": "https://storage.googleapis.com/ecmwf-open-data/",
    "Open-Meteo": "https://api.open-meteo.com/v1/forecast?latitude=47.6&longitude=-122.3&hourly=precipitation&forecast_days=1",
    "NWS API": "https://api.weather.gov/",
    "NOAA river forecasts (NWPS)": "https://api.water.noaa.gov/nwps/v1/gauges/MVEW1",
    "PRISM": "https://services.nacse.org/prism/data/public/normals/4km/ppt/01",
    "ACIS station records": "https://data.rcc-acis.org/StnMeta?sids=USW00024233&meta=name",
}


def line(ok: bool, what: str, detail: str = ""):
    print(f"  [{'ok' if ok else '!!'}] {what}{(': ' + detail) if detail else ''}", flush=True)
    if not ok:
        report.annotate("warning", f"Preflight: {what}", detail or "failed")


def versions():
    print(f"Python {platform.python_version()} on {platform.platform()}")
    for name in ("numpy", "xarray", "herbie", "cfgrib", "eccodes", "rasterio", "cartopy", "scipy", "pandas"):
        try:
            m = importlib.import_module(name)
            v = getattr(m, "__version__", "?")
            if name == "eccodes":
                v = f"{v} (library {m.codes_get_api_version()})"
            if name == "rasterio":
                v = f"{v} (GDAL {m.__gdal_version__})"
            line(True, name, v)
        except Exception as e:
            line(False, name, report.short(e))


def eccodes_works():
    try:
        import eccodes
        h = eccodes.codes_grib_new_from_samples("GRIB2")
        eccodes.codes_release(h)
        line(True, "eccodes can create a GRIB2 message")
    except Exception as e:
        line(False, "eccodes can create a GRIB2 message", report.short(e))


def hosts():
    for name, url in HOSTS.items():
        try:
            r = requests.get(url, timeout=20, stream=True, headers={"User-Agent": "(pnw-briefing preflight)"})
            line(r.status_code < 500, name, f"HTTP {r.status_code}")
            r.close()
        except Exception as e:
            line(False, name, report.short(e))


def gfs_read():
    """Latest GFS f024 precipitation, end to end: index, byte-range download, cfgrib decode."""
    try:
        from herbie import Herbie
        now = datetime.now(timezone.utc).replace(tzinfo=None, minute=0, second=0, microsecond=0)
        for back in range(6, 30, 6):
            run = (now - timedelta(hours=back)).replace(hour=((now - timedelta(hours=back)).hour // 6) * 6)
            H = Herbie(run, model="gfs", product="pgrb2.0p25", fxx=24, verbose=False)
            if H.grib is not None and H.idx is not None:
                break
        else:
            line(False, "GFS end-to-end read", "no recent GFS run found")
            return
        rows = [s for s in H.inventory(":APCP:surface:")["search_this"]]
        ds = H.xarray(":APCP:surface:", remove_grib=True)
        ds = ds[0] if isinstance(ds, list) else ds
        v = ds[list(ds.data_vars)[0]]
        line(True, "GFS end-to-end read", f"{run:%Y-%m-%d %HZ} f024, {len(rows)} APCP records, grid {tuple(v.shape)}")
    except Exception as e:
        line(False, "GFS end-to-end read", report.short(e))


if __name__ == "__main__":
    print("Preflight checks\n")
    versions()
    eccodes_works()
    hosts()
    gfs_read()
    sys.exit(0)
