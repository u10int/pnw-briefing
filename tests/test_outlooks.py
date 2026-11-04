"""NWS discussion parsing, outlook point-in-polygon, and snowpack aggregation.

    PYTHONPATH=. python tests/test_outlooks.py
"""
from datetime import date

from briefing import outlooks, snowpack

AFD = """000
FXUS66 KSEW 041756
AFDSEW

.SYNOPSIS...After today, a pattern change will bring more fall-
like weather to the area with periods of rain.

Active weather will continue.

&&

.KEY MESSAGES...
* Rain heaviest Saturday.
* Snow levels fall Monday.

.SHORT TERM /TODAY THROUGH FRIDAY/...Details here.

&&

.HYDROLOGY...No flooding expected.

&&
"""


def test_afd_sections_reflow():
    assert outlooks._section(AFD, "SYNOPSIS") == [
        "After today, a pattern change will bring more fall- like weather to the area with periods of rain.",
        "Active weather will continue."]
    assert outlooks._section(AFD, "KEY MESSAGES") == ["* Rain heaviest Saturday. * Snow levels fall Monday."]
    assert outlooks._section(AFD, "HYDROLOGY") == ["No flooding expected."]
    assert outlooks._section(AFD, "MARINE") is None


def test_ero_levels_and_polygons():
    assert outlooks._ero_level({"outlook": "Slight (At Least 15%)"}) == 2
    assert outlooks._ero_level({"dn": 3, "label": "MDT"}) == 3
    assert outlooks._ero_level({"x": 1}) is None
    square = [[-123, 46], [-122, 46], [-122, 47], [-123, 47], [-123, 46]]
    hole = [[-122.8, 46.2], [-122.2, 46.2], [-122.2, 46.8], [-122.8, 46.8], [-122.8, 46.2]]
    assert outlooks._inside([square], -122.5, 46.5)
    assert not outlooks._inside([square, hole], -122.5, 46.5)       # inside the hole
    assert not outlooks._inside([square], -121.5, 46.5)


def test_snowpack_area_index():
    stations = [
        {"stationTriplet": "1:WA:SNTL", "name": "High", "elevation": 5000, "latitude": 47.4, "longitude": -121.4, "endDate": "2100-01-01 00:00"},
        {"stationTriplet": "2:WA:SNTL", "name": "Low", "elevation": 3000, "latitude": 47.41, "longitude": -121.42, "endDate": "2100-01-01 00:00"},
        {"stationTriplet": "3:WA:SNTL", "name": "Far", "elevation": 4000, "latitude": 48.9, "longitude": -121.4, "endDate": "2100-01-01 00:00"},
    ]

    def vals(seq):
        return [{"date": f"2026-11-{d:02d}", "value": v, "median": m} for d, v, m in seq]
    data = [
        {"stationTriplet": "1:WA:SNTL", "data": [
            {"stationElement": {"elementCode": "WTEQ"}, "values": vals([(1, 3.0, 2.0), (2, 3.5, 2.5), (9, 6.0, 3.0)])},
            {"stationElement": {"elementCode": "SNWD"}, "values": [{"date": "2026-11-09", "value": 20}]}]},
        {"stationTriplet": "2:WA:SNTL", "data": [
            {"stationElement": {"elementCode": "WTEQ"}, "values": vals([(2, 0.0, 0.5), (9, 1.0, 1.0)])}]},
    ]
    calls = []

    def fake_get(path, params):
        calls.append(path)
        return stations if path == "stations" else data
    saved = snowpack._get
    snowpack._get = fake_get
    try:
        cfg = {"snowpack": {"radius_km": 10, "min_median_in": 1.0,
                            "areas": [{"name": "Snoqualmie", "lat": 47.4, "lon": -121.41}]}}
        out = snowpack.fetch(cfg, today=date(2026, 11, 9))
    finally:
        snowpack._get = saved
    a = out["areas"][0]
    assert [s["name"] for s in a["stations"]] == ["High", "Low"]            # "Far" is outside the radius
    assert a["pct"] == round(100 * 7.0 / 4.0)                                 # total SWE / total median
    hi = a["stations"][0]
    assert hi["pct"] == 200 and hi["change7"] == 2.5 and hi["depth"] == 20     # 6.0 vs 3.5 on the 2nd
    assert out["asOf"] == "2026-11-09"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
