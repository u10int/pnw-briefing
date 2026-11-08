from datetime import date, datetime, timezone
from unittest import mock

from briefing import obsreports

DAYS = [date(2026, 11, 6), date(2026, 11, 7), date(2026, 11, 8)]


def test_asos_units_and_trace():
    js = {"data": [{"date": "2026-11-06", "precip": 0.25, "max_gust": 26.0, "max_gust_localts": "2026-11-06T10:00", "snow": 0},
                   {"date": "2026-11-07", "precip": 0.0001, "max_gust": 41, "max_gust_localts": None, "snow": None},
                   {"date": "2026-11-09", "precip": None, "max_gust": None}]}
    with mock.patch.object(obsreports, "http_json", return_value=js):
        out = obsreports.asos("SEA", "WA_ASOS", DAYS)
    assert out["2026-11-06"] == {"precip": 0.25, "gust": 30, "gustTime": "2026-11-06T10:00", "snow": 0.0}
    assert out["2026-11-07"]["precip"] == 0.001 and out["2026-11-07"]["gust"] == 47
    assert "2026-11-09" not in out


def test_snotel_daily_changes():
    vals = lambda pairs: [{"date": d, "value": v} for d, v in pairs]
    js = [{"stationTriplet": "791:WA:SNTL", "data": [
        {"stationElement": {"elementCode": "PREC"}, "values": vals([("2026-11-05 23:00", 10.0), ("2026-11-06 12:00", 10.6), ("2026-11-06 23:00", 11.0),
                                                                     ("2026-11-07 23:00", 10.9), ("2026-11-08 06:00", 11.3)])},
        {"stationElement": {"elementCode": "SNWD"}, "values": vals([("2026-11-05 23:00", 4), ("2026-11-06 08:00", 9), ("2026-11-06 23:00", 7),
                                                                     ("2026-11-07 23:00", 6), ("2026-11-08 06:00", 8)])}]}]
    with mock.patch.object(obsreports, "http_json", return_value=js):
        out = obsreports.snotel(["791:WA:SNTL"], DAYS)["791:WA:SNTL"]
    assert out["2026-11-06"] == {"precip": 1.0, "snow": 5, "depth": 7}
    assert out["2026-11-07"]["precip"] == 0 and out["2026-11-07"]["snow"] == 0
    assert out["2026-11-08"]["precip"] == 0.4 and out["2026-11-08"]["snow"] == 2


def test_lsrs_kinds_and_nearest():
    cfg = {"domain": {"lon_min": -125, "lat_min": 45, "lon_max": -120, "lat_max": 49},
           "points": [{"name": "Seattle", "lat": 47.61, "lon": -122.33}, {"name": "Forks", "lat": 47.95, "lon": -124.39}]}
    f = lambda **p: {"properties": {"valid": "2026-11-07T12:00:00Z", "qualifier": "M", **p}}
    js = {"features": [f(typetext="NON-TSTM WND GST", lat=47.6, lon=-122.3, magf=35, unit="KNOTS", city="Seattle"),
                       f(typetext="HEAVY SNOW", lat=47.0, lon=-121.0, magf=8, unit="INCH"),
                       f(typetext="TSTM WND GST", lat=47.6, lon=-122.3, magf=50, unit="MPH"),
                       f(typetext="RAIN", lat=40.0, lon=-122.3, magf=1, unit="INCH")]}
    with mock.patch.object(obsreports, "http_json", return_value=js):
        out = obsreports.lsrs(cfg, ["SEW"], datetime(2026, 11, 5, tzinfo=timezone.utc), datetime(2026, 11, 8, tzinfo=timezone.utc))
    assert [r["kind"] for r in out] == ["gust", "snow"]
    assert out[0]["mag"] == 40 and out[0]["unit"] == "mph" and out[0]["near"] == "Seattle"
    assert out[1]["near"] is None


from pathlib import Path

FIX = Path(__file__).parent / "fixtures"


def test_parse_pns_wind():
    rows = obsreports.parse_pns((FIX / "pnssew.txt").read_text(), "SEW")
    assert len(rows) == 4
    h = next(r for r in rows if r["place"] == "2 W Hoquiam")
    assert h["kind"] == "gust" and h["mag"] == 69 and h["unit"] == "mph" and h["county"] == "Grays Harbor County"
    assert h["time"] == "2026-11-08T02:19:00+00:00" and (h["lat"], h["lon"]) == (46.97, -123.92)
    assert rows[0]["county"] == "Maritime Stations" and h["summary"]["office"] == "SEW"


def test_parse_pns_snow_trace_and_elev():
    rows = obsreports.parse_pns((FIX / "pnspqr_snow.txt").read_text(), "PQR")
    assert [r["kind"] for r in rows] == ["snow"] * 3
    assert rows[0]["mag"] == 4.0 and rows[0]["county"] == "North Oregon Cascades"
    assert rows[1]["mag"] == 0.001 and rows[2]["elev_ft"] == 818


def test_merge_drops_repeated_lsr():
    pns = obsreports.parse_pns((FIX / "pnssew.txt").read_text(), "SEW")
    lsr = [{"kind": "gust", "mag": 69, "lat": 46.97, "lon": -123.92, "time": "2026-11-08T02:19:00Z", "place": "2 W Hoquiam"},
           {"kind": "gust", "mag": 50, "lat": 47.6, "lon": -122.3, "time": "2026-11-08T02:19:00Z", "place": "Seattle"}]
    pts = [{"name": "Aberdeen", "lat": 46.98, "lon": -123.82}]
    out = obsreports.merge_reports(lsr, pns, pts)
    assert len(out) == 5 and sum(1 for r in out if r["place"] == "2 W Hoquiam") == 1
    assert next(r for r in out if r["place"] == "2 W Hoquiam")["near"] == "Aberdeen"
