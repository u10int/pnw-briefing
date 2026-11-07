from briefing import trends

DOC = {
    "dates": ["2026-11-07", "2026-11-08", "2026-11-09"],
    "regions": [{"id": "wwa", "name": "Western Washington"}],
    "points": [{"name": "Pass", "kind": "pass", "region": "wwa"}, {"name": "Town", "kind": "lowland", "region": "wwa"},
               {"name": "Coast", "kind": "coast", "region": "wwa"}],
    "models": [
        {"label": "A", "data": {"Pass": {"snowfall_sum": [1, 2, 3], "precipitation_sum": [1, 1, 1]},
                                "Town": {"precipitation_sum": [0.5, 0.5, 0], "wind_gusts_10m_max": [30, 40, 20], "temperature_2m_max": [50, 52, 54], "temperature_2m_min": [40, 40, 40]},
                                "Coast": {"precipitation_sum": [1, 0, 0], "wind_gusts_10m_max": [45, 35, 30], "temperature_2m_max": [48, 50, 52], "temperature_2m_min": [42, 42, 42]}}},
        {"label": "B", "data": {"Pass": {"snowfall_sum": [0, 0, None], "precipitation_sum": [0, 0, None]},
                                "Town": {"precipitation_sum": [0, 0, None], "wind_gusts_10m_max": [25, 30, None], "temperature_2m_max": [51, 51, None], "temperature_2m_min": [41, 41, None]},
                                "Coast": {"precipitation_sum": [0, 0, None], "wind_gusts_10m_max": [35, 30, None], "temperature_2m_max": [49, 49, None], "temperature_2m_min": [43, 43, None]}}},
    ],
}
WINS = [{"days": 2, "label": "Next 48 hours"}, {"days": 3, "label": "Next 3 days"}]


def test_points_and_regions():
    w2, w3 = trends.summarize(DOC, WINS)["windows"]
    assert w2["points"]["Town"]["gust"] == {"median": 35.0, "lo": 30.0, "hi": 40.0, "n": 2}
    assert w2["points"]["Pass"]["snow"]["median"] == 1.5
    assert w3["points"]["Pass"]["snow"]["n"] == 1                   # B stops after day 2
    r = w2["regions"]["wwa"]
    assert (r["gust"]["lo"], r["gust"]["hi"]) == (35, 45)          # the strongest lowland/coastal gust in each model
    assert r["snow"]["median"] == 1.5                              # passes only
    assert r["tmax"]["median"] == 50                               # lowland and coastal average


def test_compare_same_dates():
    prev = {**DOC, "dates": ["2026-11-06", "2026-11-07", "2026-11-08"],
            "models": [{"label": "A", "data": {"Pass": {"snowfall_sum": [9, 0, 0]}}}]}
    w = trends.compare(DOC, prev, WINS)["windows"][0]
    assert w["overlapDays"] == 2
    assert w["points"]["Pass"]["snow"] == {"now": 1.5, "prev": 0.0, "delta": 1.5}
    assert w["regions"]["wwa"]["snow"]["delta"] == 1.5


def test_zone_group_for_locations_outside_regions():
    doc = {**DOC, "points": DOC["points"] + [{"name": "Whistler", "kind": "pass", "region": None, "zone": "Southwest BC"}],
           "models": [{"label": "A", "data": {**DOC["models"][0]["data"], "Whistler": {"snowfall_sum": [4, 4, 4]}}}]}
    w2 = trends.summarize(doc, WINS)["windows"][0]
    assert w2["regions"]["zone:Southwest BC"]["snow"]["median"] == 8
    assert "precip" not in w2["regions"]["zone:Southwest BC"]       # Whistler has no precip series here
