from datetime import datetime

from briefing.grib import day0, first_day_hours


def test_06z_edition_starts_at_next_12z(monkeypatch):
    monkeypatch.setenv("BRIEFING_CYCLE", "2026-11-25T06Z")
    s = day0({})
    assert s == datetime(2026, 11, 25, 12) and first_day_hours(s) == 24


def test_00z_edition_keeps_rest_of_day(monkeypatch):
    monkeypatch.setenv("BRIEFING_CYCLE", "2026-11-25T00Z")
    s = day0({})
    assert s == datetime(2026, 11, 25, 0) and first_day_hours(s) == 12
