from datetime import date, timedelta

from briefing import climo


def _series(years, wet):
    d0 = date(years[0], 1, 1)
    n = (date(years[-1], 12, 31) - d0).days + 1
    days = [(d0 + timedelta(days=k)).isoformat() for k in range(n)]
    vals = [0.1] * n
    for d, x in wet.items():
        vals[(d - d0).days] = x
    return days, vals


def test_values():
    assert climo._value("T") == 0.0 and climo._value("M") is None
    assert climo._value("0.52A") == 0.52 and climo._value("S") == 0.0


def test_season_maxima_windows_and_spans():
    days, vals = _series([2000, 2001, 2002], {date(2001, 11, 12): 2.0, date(2001, 11, 13): 1.0, date(2002, 3, 1): 9.0})
    mx = climo.season_maxima(days, vals, date(2026, 11, 10))
    assert sorted(mx) == [2000, 2001, 2002]
    assert mx[2001][1] == 2.0 and mx[2001][3] == 3.1
    assert mx[2002][1] == 0.1                       # the March storm is outside the window
    assert mx[2000][7] == 0.7


def test_missing_days_drop_a_year():
    days, vals = _series([2000, 2001], {})
    d0 = date(2000, 1, 1)
    for k in range(60):
        vals[(date(2001, 10, 15) - d0).days + k] = None
    mx = climo.season_maxima(days, vals, date(2026, 11, 10))
    assert 2001 not in mx and 2000 in mx
