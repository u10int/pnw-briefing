"""Run selection skips cycles that are listed but unreadable, or whose source lookup errors.

    PYTHONPATH=. python tests/test_run_selection.py
"""
from datetime import datetime

from briefing import grib


def _spec():
    return {"label": "fake", "cycles": [0, 12], "range_days": 2, "max_hours": 120, "herbie": {}}


def test_falls_back_when_newest_cycle_errors_or_is_unreadable(monkeypatch=None):
    start = datetime(2026, 11, 4, 12)
    calls = []

    def fake_readable(spec, run, fxx):
        calls.append((run.hour, fxx))
        if run.hour == 12:
            raise KeyError("href")          # e.g. Herbie's Azure lookup for a run that isn't out
        return True

    orig = grib._readable
    grib._readable = fake_readable
    try:
        run, lead0, ndays = grib._latest_run(_spec(), start)
    finally:
        grib._readable = orig
    assert run == datetime(2026, 11, 4, 0) and lead0 == 12 and ndays == 2
    assert calls[0][0] == 12


def test_unreadable_listing_is_skipped():
    start = datetime(2026, 11, 4, 12)
    orig = grib._readable
    grib._readable = lambda spec, run, fxx: run.hour != 12   # 12Z listed but index unreadable
    try:
        run, _, _ = grib._latest_run(_spec(), start)
    finally:
        grib._readable = orig
    assert run.hour == 0


if __name__ == "__main__":
    test_falls_back_when_newest_cycle_errors_or_is_unreadable()
    test_unreadable_listing_is_skipped()
    print("ok")


def test_range_redirect_is_retried():
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("Range request not honored: server returned HTTP 302 (Content-Length: 721).")
        return "ok"

    import time as _t
    sleep, _t.sleep = _t.sleep, lambda s: None
    try:
        assert grib._retry(flaky) == "ok" and len(calls) == 2
    finally:
        _t.sleep = sleep
