from datetime import datetime
from herbie import Herbie
from briefing import volume
H = Herbie(datetime(2026, 11, 13, 18), model="hrrr", product="prs", fxx=6, verbose=False)
pat = r":(HGT|TMP|RH|UGRD|VGRD|VVEL|CLMR|CIMIXR|RWMR|SNMR|GRLE):(850|500) mb:"
ds = H.xarray(pat, remove_grib=True)
ds = ds if isinstance(ds, list) else [ds]
for d in ds:
    for n in d.data_vars:
        a = d[n].attrs
        print(n, d[n].dims, "->", volume._key(n, d[n]), {k: a.get(k) for k in ("GRIB_shortName", "GRIB_name", "GRIB_cfVarName", "GRIB_paramId", "GRIB_discipline", "GRIB_parameterCategory", "GRIB_parameterNumber")})
