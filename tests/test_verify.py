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


def test_temperature_scores():
    now = {**NOW, "observedTemps": {"source": "URMA", "dates": ["2026-11-04", "2026-11-05"],
                                    "tmax": {"A": [50.0, 52.0], "B": [48.0, None]},
                                    "tmin": {"A": [40.0, 41.0], "B": [38.0, None]}}}
    b = {"dates": ["2026-11-04", "2026-11-05"], "models": [{"label": "GFS", "tier": "global", "data": {
        "A": {"temperature_2m_max": [52.0, 50.0], "temperature_2m_min": [40.0, 45.0]},
        "B": {"temperature_2m_max": [47.0, 49.0], "temperature_2m_min": [39.0, 39.0]}}}]}
    v = verify.verify_temps(now, [b])
    d1, d23 = v["models"][0]["scores"]["d1"], v["models"][0]["scores"]["d23"]
    # day 1: A 11/4 high +2 low 0; B 11/4 high -1 low +1
    assert d1["n"] == 2 and d1["maeHi"] == 1.5 and d1["biasHi"] == 0.5 and d1["mae"] == 1.0 and d1["within"] == 1.0
    # days 2-3: A 11/5 only (B has no analysis): high -2, low +4
    assert d23["n"] == 1 and d23["biasLo"] == 4.0 and d23["within"] == 0.5
    assert v["chart"]["observed"]["wwa"]["hi"] == [49.0, 52.0]


def test_urma_wanted_days():
    from datetime import date, datetime, timezone
    from briefing import urma
    # 11/7 15Z: 11/5's day ended 11/6 12Z, out by 20Z; 11/6's day ends 11/7 12Z, not out until 20Z
    d = urma.wanted_days(datetime(2026, 11, 7, 15, tzinfo=timezone.utc), 3)
    assert d == [date(2026, 11, 3), date(2026, 11, 4), date(2026, 11, 5)]
    assert urma.wanted_days(datetime(2026, 11, 7, 21, tzinfo=timezone.utc), 1) == [date(2026, 11, 6)]


def test_urma_reuses_earlier_days(monkeypatch):
    from datetime import datetime, timezone
    from briefing import urma
    cfg = {"points": [{"name": "A", "lat": 47.6, "lon": -122.3}], "domain": {}}
    fetched = []
    monkeypatch.setattr(urma, "_fetch_day", lambda d, pts, dom: fetched.append(d) or {"A": (50.0, 40.0)})
    prev = {"observedTemps": {"dates": ["2026-11-05"], "tmax": {"A": [55.0]}, "tmin": {"A": [45.0]}}}
    out = urma.collect(cfg, [prev], now=datetime(2026, 11, 7, 21, tzinfo=timezone.utc), ndays=3, max_new=5)
    assert [d.isoformat() for d in fetched] == ["2026-11-06", "2026-11-04"]          # newest first, 11/5 reused
    assert out["dates"] == ["2026-11-04", "2026-11-05", "2026-11-06"] and out["tmax"]["A"] == [50.0, 55.0, 50.0]


def test_partial_first_day_is_not_scored():
    # an 18Z edition: its first day (11/4) is only the rest of the day, so it isn't scored
    b = {"meta": {"firstDayHours": 18}, "dates": ["2026-11-04", "2026-11-05"], "models": [{"label": "GFS", "tier": "global",
         "data": {"A": {"precipitation_sum": [0.1, 0.0]}, "B": {"precipitation_sum": [0.1, 0.0]}}}]}
    v = verify.verify(NOW, [b])
    s = v["models"][0]["scores"]
    assert "d1" not in s and s["d23"]["n"] == 2


def test_change_compares_whole_days_only():
    from briefing.change import full_dates
    assert full_dates({"meta": {"firstDayHours": 6}, "dates": ["2026-11-07", "2026-11-08"]}) == {"2026-11-08"}
    assert full_dates({"meta": {"firstDayHours": 24}, "dates": ["2026-11-07", "2026-11-08"]}) == {"2026-11-07", "2026-11-08"}
    assert full_dates({"dates": ["2026-11-07"]}) == {"2026-11-07"}
