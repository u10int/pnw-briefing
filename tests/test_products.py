"""Offline checks for the change view, NWS alert matching and COG export.

    PYTHONPATH=. python tests/test_products.py
"""
import tempfile
from pathlib import Path

import numpy as np

from briefing import alerts, change, cogs

REGIONS = [{"id": "wwa"}, {"id": "nwor"}]
POINTS = [{"name": "Seattle", "region": "wwa"}, {"name": "Portland", "region": "nwor"}]


def doc(dates, seattle, portland, events=()):
    return {"dates": dates, "regions": REGIONS, "points": POINTS, "events": list(events), "meta": {"issued": "x"},
            "models": [{"label": "GFS", "data": {"Seattle": {"precipitation_sum": seattle},
                                                 "Portland": {"precipitation_sum": portland}}}]}


def test_change_uses_the_same_days():
    # yesterday covered Nov 2-4, today covers Nov 3-5: compare Nov 3-4 only
    prev = doc(["2026-11-02", "2026-11-03", "2026-11-04"], [9, 1.0, 1.0], [9, 0.5, 0.5],
               [{"hazard": "wind", "label": "Strong gusts", "start": "2026-11-04", "end": "2026-11-04", "level": "possible"}])
    now = doc(["2026-11-03", "2026-11-04", "2026-11-05"], [1.5, 1.5, 7], [0.5, 0.5, 7],
              [{"hazard": "wind", "label": "Strong gusts", "start": "2026-11-04", "end": "2026-11-04", "level": "likely"},
               {"hazard": "heavy_rain_24h", "label": "Heavy rain", "start": "2026-11-05", "end": "2026-11-05", "level": "likely"}])
    out = change.compare(now, prev, [{"days": 3, "label": "Next 3 days"}])
    w = out["windows"][0]
    assert w["overlapDays"] == 2, w
    assert abs(w["regions"]["wwa"]["delta"] - 1.0) < 1e-9      # 3.0 now vs 2.0 yesterday over Nov 3-4
    assert abs(w["regions"]["nwor"]["delta"]) < 1e-9
    assert [e["label"] for e in out["events"]["upgraded"]] == ["Strong gusts"]
    assert [e["label"] for e in out["events"]["new"]] == ["Heavy rain"]
    assert change.compare(now, None, []) is None


def test_alerts_match_by_zone():
    zones = {"Seattle": ["WAZ558", "WAC033"], "Portland": ["ORZ006", "ORC051"]}
    feats = [
        {"properties": {"id": "a", "event": "Wind Advisory", "affectedZones": ["https://api.weather.gov/zones/forecast/WAZ558"]}},
        {"properties": {"id": "b", "event": "Flood Warning", "affectedZones": ["https://api.weather.gov/zones/county/ORC051"]}},
        {"properties": {"id": "c", "event": "Heat Advisory", "affectedZones": ["https://api.weather.gov/zones/forecast/CAZ001"]}},
    ]
    out = alerts.match(feats, zones)
    assert [a["event"] for a in out] == ["Flood Warning", "Wind Advisory"]   # warnings first, unrelated dropped
    assert out[0]["points"] == ["Portland"]


def test_cog_roundtrip():
    import rasterio
    lat = np.arange(44.0, 46.0, 0.25)
    lon = np.arange(-124.0, -121.0, 0.25)
    f = np.add.outer(lat, lon * 0).astype("float32")            # value == latitude
    f[0, 0] = np.nan
    with tempfile.TemporaryDirectory() as d:
        p = cogs.write_cog(Path(d) / "t.tif", lat, lon, f, "in", "test")
        with rasterio.open(p) as s:
            assert s.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") == "COG"
            assert str(s.crs) == "EPSG:4326"
            r, c = s.index(-123.0, 45.5)
            assert abs(s.read(1)[r, c] - 45.5) < 1e-6           # north-up and correctly placed
            r, c = s.index(-124.0, 44.0)
            assert np.isnan(s.read(1)[r, c])                     # nodata preserved


if __name__ == "__main__":
    test_change_uses_the_same_days()
    test_alerts_match_by_zone()
    test_cog_roundtrip()
    print("ok")
