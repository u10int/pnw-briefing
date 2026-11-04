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


if __name__ == "__main__":
    test_new_location_does_not_blank_the_comparison()
    test_no_shared_locations_still_reports_hazards()
    print("ok")
