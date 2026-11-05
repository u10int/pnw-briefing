"""Accumulated precipitation and snowfall map fields from fetch_model's accumulation reads."""
from datetime import datetime

import numpy as np

from briefing import fields, grib

SPEC = {"id": "hrrr", "label": "HRRR", "tier": "regional", "family": "ncep", "sample_hours": 3,
        "fields": {"hourly": ["refc"], "hourly_hours": 6, "stepped": ["mslp"]}}
CFG = {"domain": {"lat_min": 45, "lat_max": 49, "lon_min": -125, "lon_max": -120},
       "timezone": "America/Los_Angeles", "days": 1, "supplement": {}}
LAT, LON = np.array([[47.0, 47.0], [48.0, 48.0]]), np.array([[-123.0, -122.0], [-123.0, -122.0]])


def _run(monkeypatch, fail_hourly=False):
    calls = []

    def accum(spec, run, var, targets, dom):
        calls.append((var, list(targets)))
        if fail_hourly and len(targets) > 2:
            raise LookupError("nothing chainable")
        # 1 mm (APCP) or 1 cm of snow (ASNOW, metres) per hour since init, everywhere
        per = 1.0 if var == "APCP" else 0.01
        return LAT, LON, np.stack([np.full(LAT.shape, per * h) for h in targets])

    monkeypatch.setattr(grib, "_latest_run", lambda spec, start: (datetime(2026, 11, 5, 6), 6, 1))
    monkeypatch.setattr(grib, "_accum_ncep", accum)
    monkeypatch.setattr(grib, "_samples", lambda *a, **k: {})
    monkeypatch.setattr(grib, "extreme_series", lambda *a, **k: {})
    monkeypatch.setattr(grib, "outside_sites", lambda cfg: [])
    monkeypatch.setattr(fields, "fetch", lambda *a, **k: {})
    m = grib.fetch_model(SPEC, CFG, datetime(2026, 11, 5, 12), [{"name": "A", "lat": 47.0, "lon": -123.0}])
    return m, calls


def test_field_hours():
    assert fields.field_hours(SPEC, 6, 30, list(range(6, 31, 3))) == [7, 8, 9, 10, 11, 12, 15, 18, 21, 24, 27, 30]
    assert fields.field_hours({"sample_hours": 6}, 6, 30, [6, 12]) == []


def test_running_totals_from_briefing_start(monkeypatch):
    m, calls = _run(monkeypatch)
    ap, sn = m["fields"]["apcp"], m["fields"]["asnow"]
    assert ap["hours"] == [7, 8, 9, 10, 11, 12, 15, 18, 21, 24, 27, 30]
    # from lead0 (hour 6): 1 mm per hour -> inches
    np.testing.assert_allclose(ap["data"][:, 0, 0], (np.array(ap["hours"]) - 6) / 25.4, rtol=1e-6)
    np.testing.assert_allclose(sn["data"][:, 0, 0], (np.array(sn["hours"]) - 6) * 0.01 * 39.37, rtol=1e-5)
    # daily totals unchanged: one day of 24 mm
    np.testing.assert_allclose(m["data"]["A"]["precipitation_sum"][0], 24 / 25.4, rtol=1e-6)
    assert len(calls) == 2          # one read per variable covers the daily and map hours


def test_falls_back_to_daily_targets(monkeypatch):
    m, calls = _run(monkeypatch, fail_hourly=True)
    assert "apcp" not in m["fields"] and "asnow" not in m["fields"]
    np.testing.assert_allclose(m["data"]["A"]["precipitation_sum"][0], 24 / 25.4, rtol=1e-6)


def test_daily_wind_from_map_fields(monkeypatch):
    """Without an interval wind maximum, the day's strongest 10 m wind comes from the map's u/v samples."""
    def ffetch(*a, **k):
        hrs = [9, 12, 15, 18]
        u = np.stack([np.full(LAT.shape, 10.0 * (i + 1)) for i in range(4)])     # mph
        return {"u10": {"hours": hrs, "data": u}, "v10": {"hours": hrs, "data": np.zeros_like(u)}}
    m, _ = _run(monkeypatch)
    monkeypatch.setattr(fields, "fetch", ffetch)
    m = grib.fetch_model(SPEC, CFG, datetime(2026, 11, 5, 12), [{"name": "A", "lat": 47.0, "lon": -123.0}])
    assert m["data"]["A"]["wind_speed_10m_max"][0] == 40.0


def test_fire_points_from_map_fields(monkeypatch):
    """Daily min humidity, surface HDW and smoke at points from the map fields."""
    hrs = [9, 12, 15, 18]
    full = lambda vals: np.stack([np.full(LAT.shape, x, dtype="float32") for x in vals])

    def ffetch(*a, **k):
        return {"t2m": {"hours": hrs, "data": full([68, 77, 86, 77])},
                "rh": {"hours": hrs, "data": full([60, 40, 20, 35])},
                "u10": {"hours": hrs, "data": full([10, 10, 20, 10])}, "v10": {"hours": hrs, "data": full([0, 0, 0, 0])},
                "smoke": {"hours": hrs, "data": full([5, 40, 12, 3])}}
    _run(monkeypatch)
    monkeypatch.setattr(fields, "fetch", ffetch)
    m = grib.fetch_model(SPEC, CFG, datetime(2026, 11, 5, 12), [{"name": "A", "lat": 47.0, "lon": -123.0}])
    d = m["data"]["A"]
    assert d["relative_humidity_2m_min"][0] == 20
    assert d["smoke_max"][0] == 40
    # hour 15: 30 °C, RH 20 %, 20 mph -> es 42.4 hPa, VPD 33.9 hPa, wind 8.94 m/s
    np.testing.assert_allclose(d["hdw_max"][0], grib.hdw_surface(86, 20, 20), rtol=1e-5)
    assert 290 < d["hdw_max"][0] < 315


def test_rh_from_dewpoint():
    np.testing.assert_allclose(fields.rh_from_dewpoint(68.0, 293.15), 100, rtol=1e-6)   # Td = T
    assert 35 < fields.rh_from_dewpoint(86.0, 287.15) < 40                                # 30 °C, Td 14 °C
