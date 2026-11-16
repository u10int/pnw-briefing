import json, re
from datetime import datetime, timedelta, timezone
import requests
from herbie import Herbie
now = datetime.now(timezone.utc) - timedelta(hours=7)
run = now.replace(hour=now.hour // 6 * 6, minute=0, second=0, microsecond=0)
out = {"run": run.isoformat()}
for prod in ("wcoast.0p16", "epacif.0p16", "global.0p16"):
    H = Herbie(run.replace(tzinfo=None), model="gfs_wave", product=prod, fxx=12, priority=["aws"])
    idx = requests.get(H.grib + ".idx", timeout=30).text
    out[prod] = {"url": H.grib, "idx": idx.splitlines()[:40]}
    try:
        ds = H.xarray(":HTSGW:", remove_grib=True)
        ds = ds if not isinstance(ds, list) else ds[0]
        v = list(ds.data_vars)[0]
        da = ds[v]
        out[prod]["grid"] = {"var": v, "lat": [float(da.latitude.min()), float(da.latitude.max()), int(da.latitude.size)],
                             "lon": [float(da.longitude.min()), float(da.longitude.max()), int(da.longitude.size)],
                             "max": float(da.max())}
    except Exception as e:
        out[prod]["err"] = repr(e)
    # hours available
    hs = []
    for f in (120, 180, 240, 384):
        try:
            r = requests.head(Herbie(run.replace(tzinfo=None), model="gfs_wave", product=prod, fxx=f, priority=["aws"]).grib, timeout=20)
            hs.append((f, r.status_code))
        except Exception as e:
            hs.append((f, str(e)[:60]))
    out[prod]["hours"] = hs
json.dump(out, open("probe-out/waves.json", "w"), indent=1)
