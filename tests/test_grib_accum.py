"""Offline checks of the GRIB layer using a fake Herbie.

    PYTHONPATH=. python tests/test_grib_accum.py
"""
import re
import sys
import types

import numpy as np
import pandas as pd
import xarray as xr

DOM = {"lat_min": 44, "lat_max": 48, "lon_min": -125, "lon_max": -121}
RATE = 1.0  # mm per hour everywhere


def _regular(hours):
    lat = np.arange(43.0, 49.5, 0.25)[::-1]          # descending, like GFS
    lon = np.arange(234.0, 240.25, 0.25)             # 0..360
    return xr.Dataset({"v": (("latitude", "longitude"), np.full((lat.size, lon.size), RATE * hours))},
                      coords={"latitude": lat, "longitude": lon})


def _projected(hours):
    y, x = np.meshgrid(np.arange(40, 52, 0.05), np.arange(-128, -116, 0.06), indexing="ij")
    lat2, lon2 = y + 0.1 * (x + 122), x + 360          # skewed 2-D coords, 0..360 longitudes
    return xr.Dataset({"v": (("y", "x"), np.full(y.shape, RATE * hours))},
                      coords={"latitude": (("y", "x"), lat2), "longitude": (("y", "x"), lon2)})


def make_fake(style, grid):
    class FakeHerbie:
        def __init__(self, run, fxx, verbose=False, **kw):
            self.fxx, self.grib, self.idx = fxx, "x", "x"

        def _rows(self):
            f = self.fxx
            rows = []
            if style == "running":
                rows.append(f":APCP:surface:0-{f // 24} day acc fcst:" if f % 24 == 0 else f":APCP:surface:0-{f} hour acc fcst:")
            if style == "hourly":
                rows.append(f":APCP:surface:{f - 1}-{f} hour acc fcst:")
            else:
                rows.append(f":APCP:surface:{f - 6}-{f} hour acc fcst:")
            # NBM-style statistic records that must never be read as amounts
            rows.append(f":APCP:surface:0-{f} hour acc fcst:prob >0.254:prob fcst 0/1:")
            rows.append(f":APCP:surface:0-{f} hour acc fcst:ens std dev:")
            return rows

        def inventory(self, search):
            return pd.DataFrame({"search_this": [r for r in self._rows() if "APCP" in search]})

        def xarray(self, search, remove_grib=True):
            s = search.replace("\\", "")
            assert "prob" not in s and "std" not in s, "statistic record was read"
            m = re.search(r"(\d+)-(\d+) (hour|day)", s)
            a, b = int(m[1]), int(m[2])
            if m[3] == "day":
                a, b = a * 24, b * 24
            return (_regular if grid == "regular" else _projected)(b - a)

    mod = types.ModuleType("herbie")
    mod.Herbie = FakeHerbie
    return mod


def run(style, grid="regular", chain_step=6, targets=(12, 36, 60)):
    sys.modules["herbie"] = make_fake(style, grid)
    from briefing import grib
    spec = {"label": "fake", "herbie": {"model": "x"}, "chain_step": chain_step}
    lat, lon, cum = grib._accum_ncep(spec, None, "APCP", list(targets), DOM)
    assert lon.min() >= -125 and lon.max() <= -121, "longitudes normalised and cropped"
    if grid == "regular":
        assert lat[0] < lat[-1], "latitude ascending"
        cell = cum[:, 0, 0]
    else:
        assert lat.ndim == 2, "projected grid keeps 2-D coords"
        cell = cum[:, lat.shape[0] // 2, lat.shape[1] // 2]
    np.testing.assert_allclose(cell, list(targets))
    # point sampling works on both grid kinds
    idx = grib.nearest_index(lat, lon, [{"lat": 46.0, "lon": -123.0}])
    assert len(idx[0]) == 2
    return cum.shape


def test_running_total():
    run("running")


def test_six_hour_buckets():
    run("buckets")


def test_hourly_buckets_on_projected_grid():
    run("hourly", grid="projected", chain_step=1, targets=(12, 36))


if __name__ == "__main__":
    print("running totals:", run("running"))
    print("6-h buckets:", run("buckets"))
    print("hourly buckets, 2-D grid:", run("hourly", grid="projected", chain_step=1, targets=(12, 36)))
    print("ok")
