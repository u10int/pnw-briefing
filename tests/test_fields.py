"""Offline checks for time-stepped fields: record choice, precipitation type, units, export.

    PYTHONPATH=. python tests/test_fields.py
"""
import tempfile
from datetime import datetime
from pathlib import Path

import numpy as np

from briefing import fields, grib

LAT = np.arange(45.0, 46.0, 0.25)
LON = np.arange(-123.0, -122.0, 0.25)
SHAPE = (LAT.size, LON.size)


_REAL = (grib._H, grib._rows, grib._read)


def fake_grib(rows_by_name, values):
    """rows_by_name: pattern -> inventory rows; values: row -> 2-D array. Undo with restore()."""
    grib._H = lambda spec, run, h: h
    grib._rows = lambda H, p: rows_by_name.get(p, [])
    def read(H, row, dom, water=False, default=1.0, prefer=None):
        v = values[row]
        if isinstance(v, Exception):
            raise v
        if isinstance(v, dict):          # a message carrying several variables
            name = next((n for n in (prefer or []) if n in v), None)
            if prefer and name is None:
                raise LookupError(f"none of {prefer}")
            v = v[name] if name else next(iter(v.values()))
        return LAT, LON, v
    grib._read = read


def restore():
    grib._H, grib._rows, grib._read = _REAL


def test_ncep_ptype_and_instant_records():
    left = np.zeros(SHAPE); left[:, :2] = 1
    corner = np.zeros(SHAPE); corner[0, 0] = 1
    rows = {
        ":CRAIN:surface:": [":CRAIN:surface:0-6 hour ave fcst:", ":CRAIN:surface:6 hour fcst:"],
        ":CSNOW:surface:": [":CSNOW:surface:6 hour fcst:"],
        ":CFRZR:surface:": [":CFRZR:surface:6 hour fcst:"],
        ":CICEP:surface:": [],
        ":UGRD:10 m above ground:": [":UGRD:10 m above ground:6 hour fcst:"],
        ":VGRD:10 m above ground:": [":VGRD:10 m above ground:6 hour fcst:"],
    }
    vals = {
        ":CRAIN:surface:0-6 hour ave fcst:": np.full(SHAPE, 0.3),   # period average: must be ignored
        ":CRAIN:surface:6 hour fcst:": np.ones(SHAPE),
        ":CSNOW:surface:6 hour fcst:": left,
        ":CFRZR:surface:6 hour fcst:": corner,
        ":UGRD:10 m above ground:6 hour fcst:": np.full(SHAPE, 10.0),   # m/s
        ":VGRD:10 m above ground:6 hour fcst:": np.zeros(SHAPE),
    }
    fake_grib(rows, vals)
    spec = {"label": "GFS", "family": "ncep", "fields": {"stepped": ["wind", "ptype"]}}
    samples = {"t2m": {6: np.full(SHAPE, 273.15)}, "gust": {}}
    out = fields.fetch(spec, datetime(2026, 11, 4, 12), 0, 6, [0, 6], samples, {})
    c = out["ptype"]["data"][0]
    assert c[0, 0] == 3, "freezing rain should win"
    assert c[1, 0] == 5 and c[1, 3] == 1, "rain+snow is mix, rain alone is rain"
    assert abs(out["t2m"]["data"][0][0, 0] - 32.0) < 1e-6
    assert abs(out["u10"]["data"][0][0, 0] - 22.3694) < 1e-3
    assert out["ptype"]["hours"] == [6], "analysis hour is skipped"
    restore()


def test_shared_wind_message():
    """NAM: u and v in one message; the UGRD index entry is empty and its read fails."""
    rows = {":UGRD:10 m above ground:": [":UGRD:10 m above ground:6 hour fcst:"],
            ":VGRD:10 m above ground:": [":VGRD:10 m above ground:6 hour fcst:"]}
    vals = {":UGRD:10 m above ground:6 hour fcst:": FileNotFoundError("empty byte range"),
            ":VGRD:10 m above ground:6 hour fcst:": {"u10": np.full(SHAPE, 4.0), "v10": np.full(SHAPE, -2.0)}}
    fake_grib(rows, vals)
    spec = {"label": "NAM", "family": "ncep", "fields": {"stepped": ["wind"]}}
    out = fields.fetch(spec, datetime(2026, 11, 4, 6), 0, 6, [6], {}, {})
    restore()
    assert abs(out["u10"]["data"][0][0, 0] - 4.0 * 2.23694) < 1e-4, "u read from the shared message"
    assert abs(out["v10"]["data"][0][0, 0] + 2.0 * 2.23694) < 1e-4, "v is v, not the first variable"


def test_ecmwf_ptype_codes():
    rows = {":ptype:": [":ptype:sfc:6:"]}
    vals = {":ptype:sfc:6:": np.array([[0, 1, 3, 5], [6, 7, 8, 12], [0, 0, 0, 0], [0, 0, 0, 0]], dtype=float)}
    fake_grib(rows, vals)
    spec = {"label": "IFS", "family": "ecmwf", "fields": {"stepped": ["ptype"]}}
    out = fields.fetch(spec, datetime(2026, 11, 4, 0), 0, 6, [6], {}, {})
    assert out["ptype"]["data"][0][:2].tolist() == [[0, 1, 3, 2], [2, 5, 4, 3]]
    restore()


def test_export_multiband_roundtrip():
    import rasterio
    run = datetime(2026, 11, 4, 12)
    t = np.stack([np.full(SHAPE, 40.25), np.full(SHAPE, -3.75)])
    t[1, 0, 0] = np.nan
    m = {"id": "gfs", "label": "GFS", "tier": "global", "run": run, "lat": LAT, "lon": LON,
         "fields": {"t2m": {"hours": [6, 12], "data": t}}}
    with tempfile.TemporaryDirectory() as d:
        man = fields.export([m], {"domain": {}}, Path(d))
        e = man[0]
        assert e["times"] == ["2026-11-04T18:00:00+00:00", "2026-11-05T00:00:00+00:00"]
        with rasterio.open(Path(d) / Path(e["path"]).name) as s:
            assert s.count == 2 and s.dtypes[0] == "int16"
            assert s.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") == "COG"
            a = s.read().astype(float)
            a[a == e["nodata"]] = np.nan
            a *= e["scale"]
            r, c = s.index(-122.5, 45.5)
            assert abs(a[0, r, c] - 40.2) < 0.11 and abs(a[1, r, c] + 3.7) < 0.11
            assert np.isnan(a[1]).sum() == 1, "nodata survives quantization"
            assert s.descriptions[1] == e["times"][1]


def test_hourly_temperature_fills_between_samples():
    """t2m/gust listed as hourly: the samples are kept and only the hours between are downloaded."""
    asked = []
    rows = {":TMP:2 m above ground:": [":TMP:2 m above ground:x hour fcst:"]}
    vals = {":TMP:2 m above ground:x hour fcst:": np.full(SHAPE, 283.15)}       # 50 °F
    fake_grib(rows, vals)
    real_rows = grib._rows
    grib._rows = lambda H, p: (asked.append((H, p)), real_rows(H, p))[1]
    try:
        spec = {"label": "fake", "family": "ncep", "fields": {"hourly": ["t2m"], "hourly_hours": 6}}
        samples = {"t2m": {h: np.full(SHAPE, 273.15) for h in (0, 3, 6, 9)}}   # 32 °F every 3 h
        out = fields.fetch(spec, None, 0, 9, [0, 3, 6, 9], samples, {})
    finally:
        restore()
    t = out["t2m"]
    assert t["hours"] == [0, 1, 2, 3, 4, 5, 6, 9]
    by = dict(zip(t["hours"], t["data"][:, 0, 0]))
    assert abs(by[3] - 32) < 1e-4 and abs(by[1] - 50) < 1e-4            # samples kept, gaps filled
    assert sorted({h for h, p in asked if "TMP" in p}) == [1, 2, 4, 5]   # no re-download at 3 and 6


if __name__ == "__main__":
    test_ncep_ptype_and_instant_records()
    test_shared_wind_message()
    test_ecmwf_ptype_codes()
    test_export_multiband_roundtrip()
    print("ok")
