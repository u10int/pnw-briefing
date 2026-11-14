import time, re
from datetime import datetime, timedelta, timezone
from herbie import Herbie
now = datetime.now(timezone.utc).replace(tzinfo=None)
for model, kw in [("hrrr", {"product": "prs"}), ("rrfs", {"product": "prslev", "domain": "conus"})]:
    for back in range(3, 30):
        run = (now - timedelta(hours=back)).replace(minute=0, second=0, microsecond=0)
        if run.hour % 6: continue
        try:
            H = Herbie(run, model=model, fxx=6, verbose=False, **kw)
            inv = H.inventory()
            break
        except Exception as e:
            print(model, run, "no", str(e)[:100]); continue
    print("=====", model, run, H.grib)
    iso = inv[inv["search_this"].str.contains(" mb:")]
    vars_ = sorted(set(iso["variable"]))
    print("isobaric vars:", vars_)
    print("levels:", sorted(set(int(m.group(1)) for s in iso["search_this"] for m in [re.search(r":(\d+) mb:", s)] if m)))
    sizes = (iso["end_byte"] - iso["start_byte"]).astype(float)
    print("records", len(iso), "mean size MB", round(sizes.mean() / 1e6, 2))
    pat = r":(HGT|TMP|RH|UGRD|VGRD|DZDT|VVEL|CLMR|CIMIXR|ICMR|RWMR|SNMR|GRLE|TCDC|SPFH):(1000|950|900|850|800|750|700|600|500|400|300|250|200) mb:"
    sel = iso[iso["search_this"].str.contains(pat)]
    print("selected", len(sel), "MB", round(((sel["end_byte"] - sel["start_byte"]).astype(float)).sum() / 1e6, 1))
    t = time.time()
    ds = H.xarray(pat, remove_grib=True)
    ds = ds if isinstance(ds, list) else [ds]
    print("download+decode s", round(time.time() - t, 1), [list(d.data_vars) for d in ds][:6])
    for d in ds[:1]:
        v = d[list(d.data_vars)[0]]
        print("dims", v.dims, v.shape, "lat ndim", d["latitude"].ndim)
