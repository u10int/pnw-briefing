from briefing import trends

DOC = {
    "dates": ["2026-11-07", "2026-11-08", "2026-11-09"],
    "regions": [{"id": "wwa", "name": "Western Washington"}],
    "points": [{"name": "Pass", "kind": "pass", "region": "wwa"}, {"name": "Town", "kind": "lowland", "region": "wwa"},
               {"name": "Coast", "kind": "coast", "region": "wwa"}],
    "models": [
        {"label": "A", "data": {"Pass": {"snowfall_sum": [1, 2, 3]}, "Town": {"wind_gusts_10m_max": [30, 40, 20], "temperature_2m_max": [50, 52, 54], "temperature_2m_min": [40, 40, 40]},
                                "Coast": {"wind_gusts_10m_max": [45, 35, 30], "temperature_2m_max": [48, 50, 52], "temperature_2m_min": [42, 42, 42]}}},
        {"label": "B", "data": {"Pass": {"snowfall_sum": [0, 0, None]}, "Town": {"wind_gusts_10m_max": [25, 30, None], "temperature_2m_max": [51, 51, None], "temperature_2m_min": [41, 41, None]},
                                "Coast": {"wind_gusts_10m_max": [35, 30, None], "temperature_2m_max": [49, 49, None], "temperature_2m_min": [43, 43, None]}}},
    ],
}
WINS = [{"days": 2, "label": "Next 48 hours"}, {"days": 3, "label": "Next 3 days"}]


def test_summarize_per_variable():
    t = trends.summarize(DOC, WINS)
    snow2 = t["snow"][0]["regions"][0]
    assert (snow2["median"], snow2["lo"], snow2["hi"], snow2["n"]) == (1.5, 0, 3, 2)
    assert t["snow"][1]["regions"][0]["n"] == 1                 # B stops after day 2
    gust2 = t["gust"][0]["regions"][0]                           # regional max of each point's max, lowland + coast only
    assert (gust2["lo"], gust2["hi"]) == (35, 45)
    assert t["tmax"][0]["regions"][0]["median"] == 50             # mean of each point's mean, then the median across models


def test_compare_same_dates():
    prev = {**DOC, "dates": ["2026-11-06", "2026-11-07", "2026-11-08"],
            "models": [{"label": "A", "data": {"Pass": {"snowfall_sum": [9, 0, 0]}, "Town": {}, "Coast": {}}}]}
    c = trends.compare(DOC, prev, WINS)
    w = c["snow"][0]
    assert w["overlapDays"] == 2 and w["regions"]["wwa"]["prev"] == 0 and w["regions"]["wwa"]["delta"] == 1.5
