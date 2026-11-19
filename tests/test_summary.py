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
    monkeypatch.setattr(summary, "ask_model", lambda f, m, k, retry=None: {"headline": "Windy weekend for Puget Sound, gusts to 52 mph", "lede": "Strong winds are likely today into tomorrow."})
    out = summary.overview(data, cfg)
    assert out["source"] == "openai" and out["headline"].endswith("52 mph")
    monkeypatch.setattr(summary, "ask_model", lambda f, m, k, retry=None: {"headline": "Gusts to 80 mph", "lede": "Very windy."})
    assert summary.overview(data, cfg)["source"] == "rules"
    # a lead that runs long is asked for again, told why
    calls = []
    def long_then_short(f, m, k, retry=None):
        calls.append(retry)
        lede = "Strong winds are likely today." if retry else "Windy. Very windy. Still windy."
        return {"headline": "Windy for Puget Sound", "lede": lede}
    monkeypatch.setattr(summary, "ask_model", long_then_short)
    out = summary.overview(data, cfg)
    assert out["source"] == "openai" and out["lede"] == "Strong winds are likely today." and calls[1][1] == "too long"
    # and if it still runs long, its first two sentences are kept
    monkeypatch.setattr(summary, "ask_model", lambda f, m, k, retry=None: {"headline": "Windy for Puget Sound", "lede": "Windy. Very windy. Still windy."})
    out = summary.overview(data, cfg)
    assert out["source"] == "openai" and out["lede"] == "Windy. Very windy."


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


def _brief(events=(), gauges=(), waves=(), ar=None):
    return {"meta": {"issued": "2026-11-07T15:00:00+00:00"}, "events": list(events), "ar": ar or {},
            "rivers": {"gauges": list(gauges)}, "coast": {"waves": list(waves)}}


CFG = {"timezone": "America/Los_Angeles", "points": [{"name": "Seattle", "kind": "city", "zone": "Puget Sound", "region": "wa"}],
       "regions": {"wa": {"name": "Western Washington"}}}


def test_near_term_and_regional_impacts_lead():
    gusts = {"hazard": "wind", "label": "Strong gusts", "level": "likely", "agreement": 0.8, "start": "2026-11-07", "end": "2026-11-08",
             "unit": "mph", "points": [{"name": "Seattle", "peak": 50, "frac": 1}]}
    one_river = {"name": "Skokomish River near Potlatch", "crest": {"level": 2, "time": "2026-11-07T18:00:00Z"}}
    ar = {"models": [{"model": "gfs"}, {"model": "ecmwf"}],
          "events": [{"model": m, "rank": 4, "point": "Seattle", "start": "2026-11-16T00:00:00Z", "end": "2026-11-18T00:00:00Z"} for m in ("gfs", "ecmwf")]}
    surf = {"name": "Off La Push", "area": "Outer coast", "daily": [{"date": "2026-11-07", "max": 20.0}, {"date": "2026-11-08", "max": 18.0}]}
    items = summary.facts(_brief([gusts], [one_river], [surf], ar), CFG)["items"]
    kinds = [i["kind"] for i in items]
    # a strong atmospheric river nine days out and one river in flood rank below today's wind and surf
    assert kinds.index("high surf") < kinds.index("atmospheric river") and kinds.index("impact") < kinds.index("atmospheric river")
    assert kinds.index("river flooding forecast") > kinds.index("impact")
    assert "Skokomish" in summary._sentence(next(i for i in items if i["kind"] == "river flooding forecast"))


def test_events_already_under_way_read_from_today():
    assert summary.when("2026-11-06", "2026-11-07", TODAY)["when"] == "today"
    assert summary.when("2026-11-07", "2026-11-10", TODAY)["when"] == "today through Tuesday"


def test_snow_level_uses_the_near_term_where_models_agree():
    def series(model, vals):   # 12-hourly from today 12Z
        return {"model": model, "times": [f"2026-11-{7 + i // 2:02d}T{12 if i % 2 == 0 else 0:02d}:00:00Z" for i in range(len(vals))], "values": vals}
    sl = {"passes": [{"name": "Stevens Pass", "elev_ft": 4061, "series": [
        series("HRRR", [3500, 3200, 3000, 3100]),
        series("GFS", [3600, 3300, 3100, 3000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 0])]}]}   # GFS alone a week out: 0
    data = {**_brief(), "snowLevel": sl}
    it = next(i for i in summary.facts(data, CFG)["items"] if i["kind"] == "snow level reaches the passes")
    assert it["lowestSnowLevel"] == "3000 ft" and it["lowestAt"] == "Stevens Pass" and it["when"] == "today"
    assert it["lowestRelativeToPass"] == "well below pass level"     # 3,000 ft at a 4,061 ft pass
    # a level near the ground at a pass's grid point: "well below pass level", no number to read as sea level
    sl["passes"][0]["series"] = [series("HRRR", [300, 200, 3000, 3100]), series("RRFS", [400, 100, 3100, 3000])]
    it = next(i for i in summary.facts({**_brief(), "snowLevel": sl}, CFG)["items"] if i["kind"] == "snow level reaches the passes")
    assert it["lowestRelativeToPass"] == "well below pass level" and "lowestSnowLevel" not in it
