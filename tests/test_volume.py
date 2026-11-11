import gzip
from datetime import datetime
from unittest import mock

import numpy as np
import xarray as xr

from briefing import volume

DOM = {"lat_min": 47.0, "lat_max": 47.5, "lon_min": -123.0, "lon_max": -122.5}


def test_to_heights_linear_and_held_at_ends():
    h = np.array([100.0, 1500.0, 3000.0])[:, None, None] * np.ones((3, 2, 2))
    v = np.array([10.0, 0.0, -15.0])[:, None, None] * np.ones((3, 2, 2))
    out = volume.to_heights(v[::-1], h[::-1], targets=[0, 100, 800, 1500, 2250, 5000])   # level order doesn't matter
    assert np.allclose(out[:, 0, 0], [10, 10, 5, 0, -7.5, -15])


def test_pack_round_trip_and_missing():
    x = np.array([0.0, 0.02, 0.5, 2.0, 5.0, np.nan], dtype="float32")
    b = volume.pack(x, "water")
    assert b[-1] == volume.MISSING and b[-2] == 254 and b[0] == 0
    back = volume.unpack(b, "water")
    assert np.allclose(back[:4], [0, 0.02, 0.5, 2.0], atol=0.004) and np.isnan(back[-1])
    t = volume.unpack(volume.pack(np.array([32.0]), "temp"), "temp")
    assert abs(t[0] - 32) < 0.4


def test_cloud_from_rh():
    assert np.allclose(volume.cloud_from_rh(np.array([50, 80, 95, 100])), [0, 0, 50, 100])


def test_derive_units_and_ecmwf_cloud_estimate():
    got = {"t": np.full((2, 1, 1), 273.15), "u": np.full((2, 1, 1), 3.0), "v": np.full((2, 1, 1), 4.0), "r": np.full((2, 1, 1), 95.0)}
    d = volume.derive(got, "ecmwf")
    assert np.allclose(d["temp"], 32) and np.allclose(d["wind"], 5 * 2.23694) and np.allclose(d["cloud"], 50)
    assert "water" not in d
    d = volume.derive({**got, "tcc": np.full((2, 1, 1), 70.0), "clwmr": np.full((2, 1, 1), 1e-4), "rwmr": np.full((2, 1, 1), 2e-4),
                       "icmr": np.full((2, 1, 1), 1e-4), "snmr": np.full((2, 1, 1), 1e-4)}, "ncep")
    assert np.allclose(d["cloud"], 70) and np.allclose(d["water"], 0.3) and np.allclose(d["ice"], 0.2)


def _ds(levels):
    lat, lon = np.array([47.5, 47.25, 47.0]), np.array([237.0, 237.25, 237.5])
    shape = (len(levels), 3, 3)
    hgt = np.array([{1000: 100, 850: 1500, 700: 3000, 500: 5600}[p] for p in levels], dtype="float32")[:, None, None] * np.ones(shape)
    mk = lambda v, name: xr.DataArray(v.astype("float32"), dims=("isobaricInhPa", "latitude", "longitude"),
                                      coords={"isobaricInhPa": levels, "latitude": lat, "longitude": lon}, attrs={"GRIB_shortName": name})
    return xr.Dataset({"gh": mk(hgt, "gh"), "t": mk(np.full(shape, 270.0), "t"), "r": mk(np.full(shape, 90.0), "r"),
                       "u": mk(np.full(shape, 10.0), "u"), "v": mk(np.zeros(shape), "v")})


def test_fetch_reads_levels_and_writes_manifest(tmp_path):
    spec = {"label": "ECMWF IFS", "family": "ecmwf", "max_hours": 240}
    H = mock.Mock()
    H.xarray.return_value = [_ds([1000, 850, 700, 500])]
    with mock.patch("briefing.grib._H", return_value=H):
        vol = volume.fetch(spec, datetime(2026, 11, 11, 0), 12, DOM, hours=6, step=3)
    assert vol["hours"] == [12, 15, 18] and sorted(vol["vars"]) == ["cloud", "rh", "temp", "wind"]
    assert vol["vars"]["temp"].shape == (3, len(volume.HEIGHTS_M), 3, 3)
    assert list(vol["lat"]) == [47.0, 47.25, 47.5] and list(vol["lon"]) == [-123.0, -122.75, -122.5]
    m = {"id": "ifs", "label": "ECMWF IFS", "run": datetime(2026, 11, 11, 0), "volume": vol}
    man = volume.export([m], tmp_path / "volume")
    e = man[0]
    assert e["times"][0] == "2026-11-11T12:00:00+00:00" and e["nz"] == 25 and e["levels"][0] == {"hPa": 1000, "km": 0.1}
    assert "note" in e["vars"]["cloud"] and "note" not in e["vars"]["temp"]
    raw = gzip.decompress((tmp_path / e["vars"]["temp"]["path"]).read_bytes())
    assert len(raw) == 3 * 25 * 3 * 3
    assert abs(volume.unpack(np.frombuffer(raw, "uint8"), "temp")[0] - 26.33) < 0.5


def test_demo_has_gfs_only_fields():
    g = volume.demo({}, None, {"lat_min": 43, "lat_max": 51, "lon_min": -128.3, "lon_max": -118.5}, "ncep")
    e = volume.demo({}, None, {"lat_min": 43, "lat_max": 51, "lon_min": -128.3, "lon_max": -118.5}, "ecmwf")
    assert {"water", "ice"} <= set(g["vars"]) and "water" not in e["vars"]
    assert g["vars"]["temp"].shape == (16, 25, 33, 40)
