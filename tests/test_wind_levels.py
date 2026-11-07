import numpy as np
import yaml

from briefing import impacts

IMP = yaml.safe_load(open("config.yaml"))["impacts"]


def test_leaf_season_lowers_lowland_level():
    dates = ["2026-11-14", "2026-11-15", "2026-11-16"]
    thr = impacts.gust_thresholds(IMP, "lowland", dates, np.zeros(3))
    assert list(thr) == [35, 35, 40]
    assert list(impacts.gust_thresholds(IMP, "coast", dates, np.zeros(3))) == [50, 50, 50]


def test_wet_soil_lowers_level_for_three_days():
    dates = ["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05"]
    r72 = np.array([0, 3.0, 0, 0, 0])          # lowland multi-day rain threshold is 2.5
    thr = impacts.gust_thresholds(IMP, "lowland", dates, r72)
    assert list(thr) == [40, 35, 35, 35, 40]


def test_gust_events_use_per_day_levels():
    cfg = yaml.safe_load(open("config.yaml"))
    p = next(x for x in cfg["points"] if x["kind"] == "lowland")
    cfg["points"], cfg["days"] = [p], 3
    dates = ["2026-11-14", "2026-11-15", "2026-11-16"]
    zeros = [0.0] * 3
    models = [{"label": f"M{i}", "dates": dates, "data": {p["name"]: {
        "precipitation_sum": zeros, "rain_sum": zeros, "snowfall_sum": zeros,
        "temperature_2m_min": [45.0] * 3, "temperature_2m_max": [55.0] * 3,
        "wind_gusts_10m_max": [37.0, 30.0, 38.0]}}} for i in range(3)]
    d, agree = impacts.detect(models, cfg)
    ev = [e for e in impacts.events(d, agree, cfg) if e["hazard"] == "wind"]
    # 37 mph on 11/14 is over the leaf-on 35; 38 mph on 11/16 is under the usual 40
    assert [(e["start"], e["end"]) for e in ev] == [("2026-11-14", "2026-11-14")]


def test_timeline_detail_lists_each_model():
    cfg = yaml.safe_load(open("config.yaml"))
    p = next(x for x in cfg["points"] if x["kind"] == "lowland")
    cfg["points"], cfg["days"] = [p], 2
    dates = ["2026-12-01", "2026-12-02"]
    gusts = [[50.0, 10.0], [30.0, 10.0]]
    models = [{"label": f"M{i}", "dates": dates, "data": {p["name"]: {
        "precipitation_sum": [0.0, 0.0], "rain_sum": [0.0, 0.0], "snowfall_sum": [0.0, 0.0],
        "temperature_2m_min": [45.0, 45.0], "temperature_2m_max": [55.0, 55.0],
        "wind_gusts_10m_max": g}}} for i, g in enumerate(gusts)]
    d, agree = impacts.detect(models, cfg)
    labels, m, detail = impacts.timeline(d, agree)
    row = labels.index("Strong gusts")
    assert m[row][0] == 0.5 and detail[row][1] is None
    assert detail[row][0] == {"point": p["name"], "models": [["M0", 50.0, True], ["M1", 30.0, False]]}
