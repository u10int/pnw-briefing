import json, re, requests, numpy as np, xarray as xr
from datetime import datetime, timedelta, timezone
out = {}
def ls(url):
    r = requests.get(url, timeout=60); r.raise_for_status()
    return sorted(set(re.findall(r'href="([^"?/][^"]*)"', r.text)))
base = "https://dd.weather.gc.ca/today/model_rdwps/national/2.5km/"
cyc = ls(base); out["cycles"] = cyc
c = cyc[-1]
files = ls(base + c); out["n"] = len(files)
out["vars"] = sorted(set(re.sub(r'.*RDWPS_(.*)_RLatLon.*', r'\1', f) for f in files))
out["hours"] = sorted(set(re.sub(r'.*_PT(\d+)H.*', r'\1', f) for f in files))
for var in ("HTSGW_Sfc", "PKPER_Sfc", "PKDIR_Sfc", "PP1D_Sfc", "MWD_Sfc", "WVDIR_Sfc"):
    f = [x for x in files if f"_{var}_" in x and x.endswith("PT012H.grib2")]
    if not f: continue
    r = requests.get(base + c + f[0], timeout=120)
    open("/tmp/x.grib2", "wb").write(r.content)
    ds = xr.open_dataset("/tmp/x.grib2", engine="cfgrib", backend_kwargs={"indexpath": ""})
    v = list(ds.data_vars)[0]; da = ds[v]
    lat, lon = ds.latitude.values, ds.longitude.values
    lon = ((lon + 180) % 360) - 180
    a = da.values
    info = {"file": f[0], "bytes": len(r.content), "cfvar": v, "units": da.attrs.get("units"), "shape": list(a.shape),
            "lat": [float(lat.min()), float(lat.max())], "lon": [float(lon.min()), float(lon.max())], "attrs": {k: str(x) for k, x in da.attrs.items() if k.startswith("GRIB_grid") or k in ("GRIB_gridType",)}}
    # coverage over PNW boxes
    def box(la0, la1, lo0, lo1):
        m = (lat >= la0) & (lat <= la1) & (lon >= lo0) & (lon <= lo1)
        vv = a[m]; return [int(m.sum()), int(np.isfinite(vv).sum()), float(np.nanmax(vv)) if np.isfinite(vv).any() else None]
    info["puget_sound"] = box(47.0, 48.2, -122.7, -122.2)
    info["juan_de_fuca"] = box(48.1, 48.5, -124.6, -123.0)
    info["georgia"] = box(48.9, 49.8, -124.5, -123.2)
    info["outer_coast"] = box(44.0, 48.5, -127.0, -124.5)
    info["domain"] = box(41.5, 51.0, -130.0, -116.5)
    out[var] = info
json.dump(out, open("probe-out/rdwps.json", "w"), indent=1)
