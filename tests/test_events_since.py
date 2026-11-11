"""Impacts compared with the last edition, like for like."""
import copy

import yaml

from briefing import change, impacts

CFG = yaml.safe_load(open("config.yaml"))
DATES = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]
PT = next(p for p in CFG["points"] if p["kind"] == "lowland")
THR = CFG["impacts"]["heavy_rain_24h"]["lowland"]


def doc(rain_by_model, first_hours=24, issued="2026-11-10T04:00:00-08:00"):
    """A briefing with one location: per model, its daily rain (the rest dry and mild)."""
    models = []
    for label, rain in rain_by_model.items():
        n = len(rain)
        models.append({"label": label, "data": {PT["name"]: {
            "precipitation_sum": rain, "rain_sum": rain, "snowfall_sum": [0.0] * n,
            "temperature_2m_max": [50.0] * n, "temperature_2m_min": [42.0] * n, "wind_gusts_10m_max": [10.0] * n}}})
    d = {"dates": DATES[: max(len(r) for r in rain_by_model.values())], "points": [PT], "models": models,
         "meta": {"issued": issued, "firstDayHours": first_hours}}
    c = {**CFG, "points": [PT], "days": len(d["dates"])}
    evs = impacts.events(*impacts.detect([{**m, "dates": d["dates"]} for m in models], c), c)
    d["events"] = [{**e, "points": [{"name": n, "frac": f, "peak": pk} for n, f, pk in e["points"]]} for e in evs]
    return d


WET, DRY = THR + 0.5, 0.1


def test_a_model_only_in_one_edition_is_no_change():
    # three models agree on day 2 in both editions; the later one adds a fourth (dry) model, which
    # would have lowered the share on its own
    prev = doc({"A": [DRY, WET, DRY, DRY], "B": [DRY, WET, DRY, DRY], "C": [DRY, WET, DRY, DRY]})
    now = doc({"A": [DRY, WET, DRY, DRY], "B": [DRY, WET, DRY, DRY], "C": [DRY, WET, DRY, DRY], "D": [DRY, DRY, DRY, DRY]})
    ev = change.events_since(now, prev, CFG)
    assert [r["kind"] for r in ev["same"]] == ["same"] and not ev["downgraded"]


def test_a_real_upgrade_shows():
    prev = doc({"A": [DRY, WET, DRY, DRY], "B": [DRY, DRY, DRY, DRY], "C": [DRY, DRY, DRY, DRY]})
    now = doc({"A": [DRY, WET, DRY, DRY], "B": [DRY, WET, DRY, DRY], "C": [DRY, WET, DRY, DRY]})
    ev = change.events_since(now, prev, CFG)
    assert [r["kind"] for r in ev["upgraded"]] == ["upgraded"]


def test_a_partly_covered_first_day_isnt_compared():
    # the earlier edition saw heavy rain on day 1; the later one covers day 1 only in part and sees
    # less of it, which would otherwise read as dropped
    prev = doc({"A": [WET, DRY, DRY, DRY], "B": [WET, DRY, DRY, DRY], "C": [WET, DRY, DRY, DRY]})
    now = doc({"A": [DRY, DRY, DRY, DRY], "B": [DRY, DRY, DRY, DRY], "C": [DRY, DRY, DRY, DRY]}, first_hours=12)
    ev = change.events_since(now, prev, CFG)
    assert not ev["dropped"]


def test_new_and_dropped_on_full_days():
    prev = doc({"A": [DRY, DRY, WET, DRY], "B": [DRY, DRY, WET, DRY], "C": [DRY, DRY, WET, DRY]})
    now = doc({"A": [DRY, DRY, DRY, WET], "B": [DRY, DRY, DRY, WET], "C": [DRY, DRY, DRY, WET]})
    ev = change.events_since(now, prev, CFG)
    # a day later counts as the same event moved (within a day)
    assert [r["kind"] for r in ev["same"]] == ["moved"]
    far = doc({"A": [WET, DRY, DRY, DRY], "B": [WET, DRY, DRY, DRY], "C": [WET, DRY, DRY, DRY]})   # 2 days apart
    late = doc({"A": [DRY, DRY, DRY, WET], "B": [DRY, DRY, DRY, WET], "C": [DRY, DRY, DRY, WET]})
    ev = change.events_since(late, far, CFG)
    assert [r["kind"] for r in ev["new"]] == ["new"] and [r["kind"] for r in ev["dropped"]] == ["dropped"]


def test_shorter_run_in_one_edition_masks_those_days():
    # model C reaches only day 2 in the earlier edition: on days 3-4 it isn't counted in either
    prev = doc({"A": [DRY, DRY, DRY, WET], "B": [DRY, DRY, DRY, DRY], "C": [DRY, DRY]})
    now = doc({"A": [DRY, DRY, DRY, WET], "B": [DRY, DRY, DRY, DRY], "C": [DRY, DRY, DRY, WET]})
    ev = change.events_since(now, prev, CFG)
    assert not ev["upgraded"]
