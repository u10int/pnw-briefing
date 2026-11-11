

def test_history_lines_up_by_date_and_averages_areas():
    from datetime import date
    from briefing import snowpack
    start = date(2026, 10, 11)
    h = snowpack._hist([{"date": "2026-10-11", "value": 1.0, "median": 0.5}, {"date": "2026-11-10", "value": 3.0, "median": 2.0}],
                       [{"date": "2026-11-10", "value": 12}], start)
    assert len(h["swe"]) == snowpack.HIST_DAYS + 1
    assert h["swe"][0] == 1.0 and h["swe"][-1] == 3.0 and h["swe"][5] is None and h["depth"][-1] == 12
    a = snowpack.area_hist([h, {**h, "swe": [2.0] * 31}], start)
    assert a["swe"][0] == 1.5 and a["swe"][5] == 2.0
