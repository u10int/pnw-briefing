from briefing import verify

NOW = {
    "regions": [{"id": "wwa", "name": "Western Washington"}],
    "points": [{"name": "A", "region": "wwa"}, {"name": "B", "region": "wwa"}],
    "observed": {"dates": ["2026-11-04", "2026-11-05", "2026-11-06"],
                 "daily": {"A": [1.0, 0.0, 0.5], "B": [0.2, 0.0, None]}},
}


def test_scores_by_lead():
    # issued 11/4 (day 1 = 11/4), forecasting 11/4 .. 11/6; and issued 11/5
    b1 = {"dates": ["2026-11-04", "2026-11-05", "2026-11-06"], "models": [{"label": "GFS", "tier": "global",
          "data": {"A": {"precipitation_sum": [0.5, 0.0, 1.0]}, "B": {"precipitation_sum": [0.2, 0.1, 0.3]}}}]}
    b2 = {"dates": ["2026-11-05", "2026-11-06", "2026-11-07"], "models": [{"label": "GFS", "tier": "global",
          "data": {"A": {"precipitation_sum": [0.0, 0.5, 2.0]}, "B": {"precipitation_sum": [0.0, 0.0, 0.0]}}}]}
    v = verify.verify(NOW, [b1, b2])
    s = v["models"][0]["scores"]
    # day 1: (A 11/4: .5 vs 1), (B 11/4: .2 vs .2), (A 11/5: 0 vs 0), (B 11/5: 0 vs 0)
    assert s["d1"]["n"] == 4 and s["d1"]["mae"] == 0.125
    assert s["d1"]["bias"] == round(0.7 / 1.2, 2)
    # days 2-3 from b1: A 11/5 (0 vs 0), B 11/5 (.1 vs 0), A 11/6 (1 vs .5); B 11/6 has no observation
    # plus b2's A 11/6 at lead 1 (.5 vs .5)
    assert s["d23"]["n"] == 4
    assert s["d1"]["pod"] == 1.0                              # the one wet location-day (A 11/4) was forecast wet
    assert v["chart"]["observed"]["wwa"][0] == 0.6
    assert v["from"] == "2026-11-04" and v["to"] == "2026-11-06"


def test_nothing_to_verify():
    assert verify.verify({**NOW, "observed": None}, []) is None
