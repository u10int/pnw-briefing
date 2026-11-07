from datetime import datetime, timezone

from briefing import rivers

CATS = {"action": 23.5, "minor": 28, "moderate": 30, "major": 32}


def test_category():
    assert [rivers.category(s, CATS) for s in (None, 20, 23.5, 29, 31, 40)] == [None, 0, 1, 2, 3, 4]
    assert rivers.category(15, {"minor": 14}) == 2          # gauges without an action stage


def test_hourly_keeps_last_reading_each_hour():
    pts = [{"validTime": "2026-11-07T10:15:00Z", "primary": 1.0}, {"validTime": "2026-11-07T10:45:00Z", "primary": 2.0},
           {"validTime": "2026-11-07T11:00:00Z", "primary": -999}, {"validTime": "2026-11-07T11:15:00Z", "primary": 3.0},
           {"validTime": "2026-11-05T11:15:00Z", "primary": 9.0}]
    out = rivers._hourly(pts, datetime(2026, 11, 6, tzinfo=timezone.utc))
    assert out == [["2026-11-07T10:45:00Z", 2.0], ["2026-11-07T11:15:00Z", 3.0]]


def test_demo_rivers():
    import yaml
    from briefing import demo
    r = demo.rivers(yaml.safe_load(open("config.yaml")))
    assert r["gauges"][0]["crest"]["level"] == 3            # sorted worst first


def test_gauge_from_live_payload(monkeypatch):
    """Two real gauges (Skagit near Mt Vernon, Chehalis near Grand Mound) as the API returned them on
    2026-11-07, observed series trimmed."""
    import json
    live = json.load(open("tests/fixtures/rivers_live.json"))

    def fake(url, ua, params=None):
        lid = url.split("/gauges/")[1].split("/")[0]
        return live[lid]["sf"] if url.endswith("/stageflow") else live[lid]["info"]
    monkeypatch.setattr(rivers, "_get", fake)
    now = datetime(2026, 11, 7, 18, tzinfo=timezone.utc)
    g = rivers._gauge({"lid": "MVEW1", "name": "x", "latitude": 48.445, "longitude": -122.33}, "ua", now)
    assert g["categories"] == {"major": 32, "moderate": 30, "minor": 28, "action": 23.5}
    assert g["units"] == "ft" and g["forecast"] and g["observed"]
    assert g["crest"]["stage"] == max(v for _, v in g["forecast"])
    assert g["now"]["level"] == 0 and g["record"]["stage"] > 37
    assert rivers._gauge({"lid": "CGMW1", "name": "x", "latitude": 46.78, "longitude": -123.03}, "ua", now)["categories"]
