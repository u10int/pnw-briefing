from datetime import datetime, timezone
from unittest import mock

from briefing import coast

NDBC = """#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
2026 11 08 16 20 230 11.0 14.0    MM    MM  10.0 227 1014.8  12.2    MM   8.9   MM   MM    MM
2026 11 08 16 10 230 10.0 13.0   6.3    15  10.0 227 1014.8  12.2  11.0   8.9   MM   MM    MM
2026 11 08 10 10 230  5.0  7.0   7.4    16  10.0 227 1014.8  12.2  11.0   8.9   MM   MM    MM
2026 11 06 10 10 230  5.0 30.0  12.0    16  10.0 227 1014.8  12.2  11.0   8.9   MM   MM    MM
"""
NOW = datetime(2026, 11, 8, 16, 40, tzinfo=timezone.utc)


def test_buoy_latest_and_peaks():
    resp = mock.Mock(text=NDBC)
    with mock.patch.object(coast, "_get", return_value=resp):
        b = coast.buoy({"id": "46087", "name": "Neah Bay", "lat": 48.5, "lon": -124.7, "area": "Outer coast"}, NOW)
    assert b["wave"] == 20.7 and b["period"] == 15 and b["gust"] == 31 and b["wind"] == 25
    assert b["waveMax24"] == 24.3 and b["gustMax24"] == 31          # the two-day-old 12 m row is left out
    assert b["water"] == 52 and b["time"] == "2026-11-08T16:10:00+00:00"


def test_tide_margins_include_surge():
    pred = {"predictions": [{"t": "2026-11-08 11:30", "v": "9.9", "type": "H"}, {"t": "2026-11-08 18:01", "v": "-0.6", "type": "L"},
                            {"t": "2026-11-09 00:40", "v": "12.5", "type": "H"}]}
    with mock.patch.object(coast, "_coops", return_value=pred), \
         mock.patch.object(coast, "_get", return_value=mock.Mock(json=lambda: {"nws_minor": 13.94, "nos_minor": None})), \
         mock.patch.object(coast, "_surge", return_value=0.8):
        t = coast.tide({"id": "9441102", "name": "Westport", "near": "Aberdeen", "area": "Outer coast"}, NOW)
    assert [h["height"] for h in t["highs"]] == [9.9, 12.5]
    assert t["flood"] == 13.94 and t["highs"][1]["margin"] == 0.64


def test_surge_mean_of_last_hour():
    obs = {"data": [{"t": "2026-11-08 15:30", "v": "5.0"}, {"t": "2026-11-08 16:00", "v": "6.0"}, {"t": "2026-11-08 16:30", "v": "7.0"}]}
    pred = {"predictions": [{"t": "2026-11-08 15:30", "v": "5.0"}, {"t": "2026-11-08 16:00", "v": "5.0"}, {"t": "2026-11-08 16:30", "v": "5.6"}]}
    with mock.patch.object(coast, "_coops", side_effect=[obs, pred]):
        assert coast._surge("x", NOW) == 1.2


def test_marine_alerts_keep_local_zones():
    js = {"features": [{"properties": {"id": "a", "event": "Gale Warning", "geocode": {"UGC": ["PZZ130", "PZZ131"]}, "areaDesc": "Strait"}},
                       {"properties": {"id": "b", "event": "Small Craft Advisory", "geocode": {"UGC": ["PZZ545"]}, "areaDesc": "Monterey"}}]}
    with mock.patch.object(coast, "_get", return_value=mock.Mock(json=lambda: js)):
        out = coast.marine_alerts({}, ["PZZ1", "PZZ2"])
    assert [a["event"] for a in out] == ["Gale Warning"] and out[0]["zones"] == ["PZZ130", "PZZ131"]


def test_wave_forecast_daily_max_and_inland_skip():
    js = [{"hourly_units": {"wave_height": "ft"}, "hourly": {"time": ["2026-11-08T00:00", "2026-11-08T01:00", "2026-11-09T00:00"],
                                                            "wave_height": [10.0, 14.2, 9.0], "wave_period": [12, 14, 11], "wave_direction": [250, 260, 270]}},
          {"hourly_units": {"wave_height": "ft"}, "hourly": {"time": ["2026-11-08T00:00"], "wave_height": [None], "wave_period": [None], "wave_direction": [None]}}]
    pts = [{"name": "A", "lat": 1, "lon": 2, "area": "Outer coast"}, {"name": "B", "lat": 1, "lon": 2}]
    with mock.patch.object(coast, "_get", return_value=mock.Mock(json=lambda: js)):
        out = coast.wave_forecast(pts)
    assert list(out) == ["A"] and out["A"]["daily"][0] == {"date": "2026-11-08", "max": 14.2, "period": 14, "dir": 260, "time": "2026-11-08T01:00"}
