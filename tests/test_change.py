"""Since-yesterday comparison.

    PYTHONPATH=. python tests/test_change.py
"""
from briefing import change

DATES = ["2026-11-03", "2026-11-04", "2026-11-05"]
REGIONS = [{"id": "wwa", "name": "Western Washington"}]


def _doc(points, dates, amount, events=()):
    models = [{"label": m, "data": {p["name"]: {"precipitation_sum": [amount] * len(dates)} for p in points}}
              for m in ("A", "B")]
    return {"dates": dates, "regions": REGIONS, "points": points, "models": models,
            "events": list(events), "meta": {"issued": "2026-11-03T21:23:00-08:00"}}


SEA = {"name": "Seattle", "region": "wwa"}
VAN = {"name": "Vancouver BC", "region": None}


def test_new_location_does_not_blank_the_comparison():
    prev = _doc([SEA], DATES, 0.5)
    now = _doc([SEA, VAN], DATES[1:] + ["2026-11-06"], 0.75)
    c = change.compare(now, prev, [{"days": 2, "label": "Next 48 hours"}])
    assert len(c["windows"]) == 1
    w = c["windows"][0]
    assert w["overlapDays"] == 2
    assert abs(w["regions"]["wwa"]["delta"] - 0.5) < 1e-9          # 2 days x +0.25 in
    assert "Vancouver BC" not in w["points"] and "Seattle" in w["points"]


def test_no_shared_locations_still_reports_hazards():
    prev = _doc([{"name": "Elsewhere", "region": "wwa"}], DATES, 0.5)
    now = _doc([SEA], DATES[1:] + ["2026-11-06"], 0.5,
               [{"hazard": "wind", "label": "Strong gusts", "start": "2026-11-05", "end": "2026-11-05", "level": "possible"}])
    c = change.compare(now, prev, [{"days": 2, "label": "Next 48 hours"}])
    assert c["windows"] == [] and len(c["events"]["new"]) == 1


def _ev(h, a, b, level="possible"):
    return {"hazard": h, "label": h, "start": a, "end": b, "level": level, "points": [{"name": "Seattle", "peak": 1.0}]}


def test_events_moved_matched_and_dropped():
    days = ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"]
    prev = _doc([SEA], ["2026-11-03"] + days[:-1], 0.5, [
        _ev("rain", "2026-11-03", "2026-11-04"),          # partly past, still on the 4th: unchanged, not "moved"
        _ev("wind", "2026-11-05", "2026-11-05"),          # moves two days later, no overlap: shifted
        _ev("snow", "2026-11-08", "2026-11-09"),          # gone today: dropped
        _ev("heat", "2026-11-06", "2026-11-07"),          # same dates, now likely: upgraded
    ])
    now = _doc([SEA], days, 0.5, [
        _ev("rain", "2026-11-04", "2026-11-04"),
        _ev("wind", "2026-11-07", "2026-11-07"),
        _ev("heat", "2026-11-06", "2026-11-07", "likely"),
        _ev("ice", "2026-11-10", "2026-11-10"),
    ])
    ev = change.compare(now, prev, [])["events"]
    by = {e["hazard"]: (k, e) for k, xs in ev.items() for e in xs}
    assert by["rain"][0] == "same" and not by["rain"][1]["shifted"]
    assert by["wind"][0] == "same" and by["wind"][1]["shifted"] and by["wind"][1]["prevStart"] == "2026-11-05"
    assert by["snow"][0] == "dropped" and by["snow"][1]["prevEnd"] == "2026-11-09"
    assert by["heat"][0] == "upgraded" and not by["heat"][1]["shifted"]
    assert by["ice"][0] == "new" and by["ice"][1]["where"] == [{"name": "Seattle", "peak": 1.0}]


def test_two_events_dont_share_one_match():
    prev = _doc([SEA], DATES, 0.5, [_ev("rain", "2026-11-04", "2026-11-05")])
    now = _doc([SEA], DATES, 0.5, [_ev("rain", "2026-11-04", "2026-11-04"), _ev("rain", "2026-11-05", "2026-11-05")])
    ev = change.compare(now, prev, [])["events"]
    assert len(ev["same"]) == 1 and len(ev["new"]) == 1


if __name__ == "__main__":
    test_new_location_does_not_blank_the_comparison()
    test_no_shared_locations_still_reports_hazards()
    print("ok")
