"""Temperature departures: daily interpolation of monthly normals and the per-location table."""
from datetime import date
from pathlib import Path

import numpy as np

from briefing import normals, tempdep


def test_mid_month_interpolation():
    months = {10: np.array([10.0]), 11: np.array([4.0]), 12: np.array([1.0])}
    assert normals._mid_month(months, date(2026, 11, 15))[0] == 4.0
    v = normals._mid_month(months, date(2026, 11, 30))[0]           # halfway to Dec 15
    assert 2.4 < v < 2.6
    assert normals._mid_month(months, date(2026, 11, 1))[0] > 4.0    # still warmer, closer to October


def test_summarize_departures(monkeypatch):
    dates = [date(2026, 11, 4) + __import__("datetime").timedelta(days=d) for d in range(3)]
    lat, lon = np.arange(46.0, 49.0, 0.1), np.arange(-124.0, -121.0, 0.1)
    grid = np.full((3, lat.size, lon.size), 50.0)
    monkeypatch.setattr(normals, "daily_temp_normals", lambda *a, **k: (lat, lon, {"tmax": grid, "tmin": grid - 12}))
    cfg = {"points": [{"name": "Seattle", "lat": 47.6, "lon": -122.3, "region": "wwa"},
                      {"name": "Far", "lat": 30.0, "lon": -100.0, "region": "wwa"}],
           "regions": {"wwa": {}}, "windows": [{"days": 2, "label": "Next 48 hours"}], "days": 3}
    mk = lambda hi: {"dates": dates, "data": {"Seattle": {"temperature_2m_max": hi, "temperature_2m_min": [40, 41, None]}}}
    models = [mk([52, 54, 49]), mk([56, 50, 47]), mk([60, None, 45])]
    import briefing.analysis as an
    monkeypatch.setattr(an, "windows", lambda cfg: cfg["windows"])
    s, g = tempdep.summarize(models, cfg, Path("."))
    sea = s["points"]["Seattle"]
    assert sea["tmax"]["departure"] == [6.0, 2.0, -3.0]              # medians 56, 52, 47 against 50
    assert sea["tmax"]["models"] == [3, 2, 3]
    assert sea["tmin"]["departure"][:2] == [2.0, 3.0] and sea["tmin"]["departure"][2] is None
    assert s["points"]["Far"]["tmax"]["departure"] == [None] * 3      # no normal there
    assert s["windows"][0]["points"]["Seattle"]["tmax"] == 4.0
    assert s["regions"]["wwa"]["tmax"] == [6.0, 2.0, -3.0]
