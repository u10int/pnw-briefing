from briefing import alerts, eccc_alerts as ea

SQ = lambda x0, y0, x1, y1: {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}
PTS = [{"name": "Nanaimo", "lat": 49.17, "lon": -123.94, "kind": "lowland", "country": "CA"},
       {"name": "Tofino", "lat": 49.15, "lon": -125.91, "kind": "coast", "country": "CA"}]


def feat(code, name, geom, colour="orange", status="continued", start="2026-11-11T12:00:00Z", end="2026-11-12T19:00:00Z"):
    return {"geometry": geom, "properties": {
        "alert_code": code, "alert_name_en": f"{name} warning", "alert_type": "warning", "risk_colour_en": colour,
        "validity_datetime": start, "event_end_datetime": end, "publication_datetime": start, "status_en": status,
        "alert_text_en": "Heavy rain is expected.\n\nWhat: ...", "feature_name_en": f"Region {code} {geom['coordinates'][0][0][0]}",
        "impact_en": "Moderate", "confidence_en": "High", "feature_id": "f1"}}


def test_point_in_polygon_with_hole():
    g = {"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]]}
    assert ea.contains(g, 1, 1) and not ea.contains(g, 5, 5) and not ea.contains(g, 11, 5)
    assert ea.contains({"type": "MultiPolygon", "coordinates": [g["coordinates"]]}, 2, 8)


def test_regions_of_one_alert_join_and_others_drop():
    west, east, far = SQ(-126.5, 48.8, -125.5, 49.5), SQ(-124.3, 49.0, -123.6, 49.4), SQ(-120, 49, -119, 50)
    items = ea.match([feat("RFW", "rainfall", west), feat("RFW", "rainfall", east), feat("WDW", "wind", far),
                      feat("FGA", "fog", east, status="ended")], PTS)
    assert len(items) == 1
    a = items[0]
    assert a["event"] == "Rainfall Warning" and a["colour"] == "orange" and a["source"] == "eccc"
    assert a["points"] == ["Nanaimo", "Tofino"] and a["headline"] == "Heavy rain is expected."
    assert a["url"].startswith("https://weather.gc.ca/en/location/index.html?coords=49.170,-123.940")


def test_different_colours_are_separate_alerts():
    west, east = SQ(-126.5, 48.8, -125.5, 49.5), SQ(-124.3, 49.0, -123.6, 49.4)
    items = ea.match([feat("RFW", "rainfall", west, "orange"), feat("RFW", "rainfall", east, "yellow")], PTS)
    assert sorted(a["colour"] for a in items) == ["orange", "yellow"]


def test_nws_zone_lookup_skips_canada(monkeypatch):
    called = []
    monkeypatch.setattr(alerts, "_get", lambda url, ua, **k: called.append(url) or {"properties": {}})
    alerts.resolve_zones(PTS + [{"name": "Seattle", "lat": 47.6, "lon": -122.3}], "ua")
    assert len(called) == 1 and "47.6" in called[0]
