from datetime import date

from briefing import summary

TODAY = date(2026, 11, 7)          # a Saturday


def test_relative_timing():
    w = lambda a, b=None: summary.when(a, b, TODAY)["when"]
    assert w("2026-11-07") == "today"
    assert w("2026-11-07", "2026-11-08") == "today into tomorrow"
    assert w("2026-11-10", "2026-11-12") == "early to mid next week"
    assert w("2026-11-14", "2026-11-15") == "next weekend"
    assert w("2026-11-11") == "next Wednesday"


def test_check_rejects_invented_numbers_and_dates():
    f = {"issued": "Saturday morning", "items": [{"kind": "impact", "worst": "56 mph", "importance": 3}], "changesSinceYesterday": []}
    assert summary.check({"headline": "Gusts to 56 mph this weekend", "lede": "Windy for Puget Sound."}, f) is None
    assert "number" in summary.check({"headline": "Gusts to 70 mph this weekend", "lede": "Windy."}, f)
    assert summary.check({"headline": "Gusts to 56 mph Sat 11/7", "lede": "Windy."}, f) == "calendar date"
    # the ranking scores aren't facts the model sees
    assert "number" in summary.check({"headline": "Windy", "lede": "Rated 3 of 5."}, f)


def test_rules_lead_with_the_most_important():
    f = {"items": [
        {"kind": "impact", "hazard": "Strong gusts", "likelihood": "likely", "when": "this weekend", "areas": ["Puget Sound"], "regions": ["Western Washington"], "importance": 3.4},
        {"kind": "precipitation total", "window": "next 7 days", "byRegion": {"Western Washington": {"total": "2.5 in", "percentOfNormal": "116%"}}, "importance": 0.9},
    ], "changesSinceYesterday": []}
    out = summary.by_rules(f)
    assert out["headline"] == "Strong winds for Puget Sound this weekend"
    assert out["lede"] == "Over the next 7 days, Western Washington about 2.5 in (116% of normal)."


def test_quiet():
    f = {"items": [{"kind": "precipitation total", "window": "next 7 days", "byRegion": {"W": {"total": "0.3 in"}}, "importance": 0.9}], "changesSinceYesterday": []}
    assert summary.by_rules(f)["headline"].startswith("A quiet stretch")


def test_overview_uses_model_text_only_when_it_checks_out(monkeypatch):
    cfg = {"timezone": "America/Los_Angeles", "points": [{"name": "Seattle", "kind": "lowland", "region": "wwa", "zone": "Puget Sound"}],
           "regions": {"wwa": {"name": "Western Washington"}}}
    data = {"meta": {"issued": "2026-11-07T07:40:00-08:00"}, "windows": [], "events": [
        {"hazard": "wind", "label": "Strong gusts", "unit": "mph", "start": "2026-11-07", "end": "2026-11-08",
         "points": [{"name": "Seattle", "frac": 1.0, "peak": 52.4}], "agreement": 1.0, "n_models": 10, "level": "likely"}]}
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    monkeypatch.setattr(summary, "ask_model", lambda f, m, k: {"headline": "Windy weekend for Puget Sound, gusts to 52 mph", "lede": "Strong winds are likely today into tomorrow."})
    out = summary.overview(data, cfg)
    assert out["source"] == "openai" and out["headline"].endswith("52 mph")
    monkeypatch.setattr(summary, "ask_model", lambda f, m, k: {"headline": "Gusts to 80 mph", "lede": "Very windy."})
    assert summary.overview(data, cfg)["source"] == "rules"


def test_check_rejects_named_products_and_long_leads():
    f = {"issued": "Saturday morning", "items": [], "changesSinceYesterday": []}
    assert summary.check({"headline": "High Wind Warning for the coast", "lede": "Windy."}, f) == "names an NWS product"
    assert summary.check({"headline": "Windy on the coast", "lede": "A watch is out."}, f) == "names an NWS product"
    long = "Windy on the coast. Rain in the hills. Snow in the passes."
    assert summary.check({"headline": "Windy on the coast", "lede": long}, f) == "too long"
    assert summary.check({"headline": "Windy on the coast", "lede": " ".join(["word"] * 50) + "."}, f) == "too long"


def test_model_text_is_capitalised(monkeypatch):
    cfg = {"timezone": "America/Los_Angeles", "points": [], "regions": {}}
    data = {"meta": {"issued": "2026-11-07T07:40:00-08:00"}, "windows": [], "events": []}
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    monkeypatch.setattr(summary, "ask_model", lambda f, m, k: {"headline": "a quiet stretch ahead", "lede": "nothing stands out."})
    out = summary.overview(data, cfg)
    assert out["headline"] == "A quiet stretch ahead" and out["lede"] == "Nothing stands out."


def test_place_names_are_capitalised():
    cfg = {"regions": {"wwa": {"name": "Western Washington"}}, "points": [{"zone": "WA coast"}, {"zone": "Southwest BC"}]}
    n = summary.place_names(cfg)
    t = "strong gusts along puget sound, the wa coast or southwest bc, rain in western washington"
    assert summary.fix_places(t, n) == "strong gusts along Puget Sound, the WA coast or Southwest BC, rain in Western Washington"
