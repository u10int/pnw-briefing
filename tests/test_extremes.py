"""Window extremes from time-stepped fields.

    PYTHONPATH=. python tests/test_extremes.py
"""
import numpy as np

from briefing import extremes


def _model(**fields):
    lat = np.array([45.0, 45.25])
    lon = np.array([-123.0, -122.75])
    return {"label": "fake", "lead0": 6, "range_days": 3, "lat": lat, "lon": lon, "fields": fields}


def _series(hours, values):
    return {"hours": list(hours), "data": np.array(values, dtype="float32")[:, None, None] * np.ones((1, 2, 2), "float32")}


def test_windows_follow_12z_days():
    # samples every 6 h from lead 6 (today 12Z) to lead 78 (three days later)
    hours = list(range(6, 79, 6))
    temps = [40, 52, 45, 38, 41, 60, 44, 30, 42, 55, 47, 35, 39]
    m = _model(t2m=_series(hours, temps))
    e = extremes.compute(m)
    # day 1 = leads (6, 30] for highs, [6, 30) for lows
    assert e["tmax"][0, 0, 0] == 52 and e["tmin"][0, 0, 0] == 38
    # two days: highs through lead 54, lows from lead 6 up to (not including) 54
    assert e["tmax"][1, 0, 0] == 60 and e["tmin"][1, 0, 0] == 30
    assert e["tmax"][2, 0, 0] == 60 and e["tmin"][2, 0, 0] == 30
    assert extremes.window({**m, "extremes": e}, "tmax", 4) is None   # beyond the model's range


def test_wind_speed_from_components_and_fallback():
    hours = [12, 18, 24]
    m = _model(u10=_series(hours, [3, 0, 6]), v10=_series(hours, [4, 10, 8]))
    assert extremes.compute(m)["wind"][0, 0, 0] == 10                 # hypot(6, 8) = 10, hypot(0, 10) = 10
    m2 = _model()
    m2["wind_speed"] = _series(hours, [7, 21, 9])
    assert extremes.compute(m2)["wind"][0, 0, 0] == 21


def test_missing_cells_stay_missing():
    hours = [12, 18]
    d = np.array([[[np.nan, 1], [2, 3]], [[np.nan, 5], [1, 1]]], dtype="float32")
    m = _model(gust={"hours": hours, "data": d})
    g = extremes.compute(m)["gust"][0]
    assert np.isnan(g[0, 0]) and g[0, 1] == 5 and g[1, 0] == 2


if __name__ == "__main__":
    test_windows_follow_12z_days()
    test_wind_speed_from_components_and_fallback()
    test_missing_cells_stay_missing()
    print("ok")
