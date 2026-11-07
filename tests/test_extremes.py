"""Window extremes from interval records and time-stepped fields.

    PYTHONPATH=. python tests/test_extremes.py
"""
import numpy as np

from briefing import extremes, grib


def _model(**fields):
    lat = np.array([45.0, 45.25])
    lon = np.array([-123.0, -122.75])
    return {"label": "fake", "lead0": 6, "range_days": 3, "lat": lat, "lon": lon, "fields": fields}


def _grid(v):
    return np.full((2, 2), v, dtype="float32")


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


def test_wind_speed_from_components():
    hours = [12, 18, 24]
    m = _model(u10=_series(hours, [3, 0, 6]), v10=_series(hours, [4, 10, 8]))
    assert extremes.compute(m)["wind"][0, 0, 0] == 10                 # hypot(6, 8) = 10, hypot(0, 10) = 10


def test_interval_records_catch_peaks_between_outputs():
    # 6-hourly instantaneous values miss a 58° afternoon peak that the 6-hour max record holds
    m = _model(t2m=_series([12, 18, 24, 30], [44, 50, 47, 41]))
    m["ext_series"] = {
        "tmax": [(6, 12, _grid(45)), (12, 18, _grid(58)), (18, 24, _grid(51)), (24, 30, _grid(47))],
        "tmin": [(6, 12, _grid(39)), (24, 30, _grid(36)), (30, 36, _grid(33))],
    }
    e = extremes.compute(m)
    assert e["tmax"][0, 0, 0] == 58
    # an interval ending at 12Z (lead 30) belongs to day 1; the next one to day 2
    assert e["tmin"][0, 0, 0] == 36 and e["tmin"][1, 0, 0] == 33


def test_daily_assignment_of_instantaneous_lows():
    # an instantaneous value exactly at 12Z belongs to the following day's low, as before
    entries = [(30, 30, _grid(20)), (24, 24, _grid(30))]
    d = extremes.daily(entries, [6, 30, 54], "min")
    assert d[0, 0, 0] == 30 and d[1, 0, 0] == 20


def test_missing_cells_stay_missing():
    hours = [12, 18]
    d = np.array([[[np.nan, 1], [2, 3]], [[np.nan, 5], [1, 1]]], dtype="float32")
    m = _model(gust={"hours": hours, "data": d})
    g = extremes.compute(m)["gust"][0]
    assert np.isnan(g[0, 0]) and g[0, 1] == 5 and g[1, 0] == 2


def test_record_spans():
    assert grib._span(":TMAX:2 m above ground:120-126 hour max fcst:", 126, 123) == (120, 126)
    assert grib._span(":TMIN:2 m above ground:12-24 hour min fcst:", 24, 18) == (12, 24)
    assert grib._span(":mx2t6:sfc:g:0001:od:fc:oper:", 150, 144) == (144, 150)
    assert grib._span(":10fg3:sfc:g:0001:od:fc:oper:", 144, 141) == (141, 144)
    assert grib._span(":10fg:sfc:g:0001:od:fc:oper:", 6, 3) == (3, 6)


def test_native_step_schedule():
    spec = {"extremes": {"steps": [[36, 1], [192, 3], [264, 6]]}}
    h = grib.extreme_hours(spec, 0, 264)
    assert h[:3] == [1, 2, 3] and 36 in h and 37 not in h and 39 in h and 192 in h and 195 not in h and h[-1] == 264
    assert grib.extreme_hours({"extremes": {"step": 3}}, 6, 24) == [9, 12, 15, 18, 21, 24]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")


def test_extreme_series_reads_records_once_per_hour():
    """extreme_series against a fake GRIB source: NAM-style hourly max/min and max-wind components,
    one index lookup per hour, failures logged rather than raised."""
    import re as _re
    opened = []

    class FakeH:
        def __init__(self, h):
            self.h = h

    def fake_H(spec, run, h):
        opened.append(h)
        return FakeH(h)

    def fake_rows(H, pattern):
        h = H.h
        table = {
            "TMAX": f":TMAX:2 m above ground:{h - 1}-{h} hour max fcst:",
            "TMIN": f":TMIN:2 m above ground:{h - 1}-{h} hour min fcst:",
            "MAXUW": f":MAXUW:10 m above ground:{h - 1}-{h} hour max fcst:",
            "MAXVW": f":MAXVW:10 m above ground:{h - 1}-{h} hour max fcst:",
            "GUST": f":GUST:surface:{h} hour fcst:",
        }
        return [r for k, r in table.items() if _re.search(pattern, r)]

    def fake_read(H, row, dom, *a, **k):
        if "GUST" in row and H.h == 9:
            raise RuntimeError("Slow Down")                   # a failed read is skipped and logged
        val = {"TMAX": 290.0 + H.h, "TMIN": 270.0 + H.h, "MAXUW": 3.0, "MAXVW": 4.0, "GUST": 10.0}
        key = next(k for k in val if f":{k}:" in row)
        return None, None, np.full((2, 2), val[key], dtype="float32")

    spec = {"label": "fake", "family": "ncep", "extremes": {"step": 1, "temp": "maxmin", "wind": "maxuv"}}
    saved = grib._H, grib._rows, grib._read
    grib._H, grib._rows, grib._read = fake_H, fake_rows, fake_read
    try:
        t2m = {9: np.full((2, 2), 280.0, "float32")}
        out = grib.extreme_series(spec, None, 6, 12, {}, t2m, {}, {})
    finally:
        grib._H, grib._rows, grib._read = saved
    assert sorted(opened) == [7, 8, 9, 10, 11, 12]
    assert len(opened) == len(set(opened))                    # one lookup per hour, shared by fields
    tmax = {(a, b): v[0, 0] for a, b, v in out["tmax"] if a < b}
    assert (11, 12) in tmax and abs(tmax[(11, 12)] - grib.K_TO_F(302.0)) < 1e-3
    assert any(a == b == 9 for a, b, _ in out["tmax"])        # the instantaneous sample is kept too
    assert all(abs(v[0, 0] - 5 * grib.M_S_TO_MPH) < 1e-3 for _, _, v in out["wind"])   # hypot(3, 4) = 5 m/s
    assert len(out["gust"]) == 5                               # hour 9's failed read is dropped
