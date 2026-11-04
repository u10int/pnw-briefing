"""Page-only rebuild: config labels re-applied to published data, and the briefing's date."""
from briefing import repage


def test_refresh_gradient_labels_and_date():
    cfg = {"timezone": "America/Los_Angeles",
           "gradients": [{"id": "olm_bli", "a": {"name": "Olympia", "code": "OLM"}, "b": {"name": "Bellingham", "code": "BLI"},
                          "meaning": "new meaning", "thresholds": [{"value": 9, "label": "x"}]}]}
    data = {"meta": {"issued": "2026-11-05T06:30:00+00:00"},
            "gradients": [{"id": "olm_bli", "a": "Olympia", "b": "Bellingham", "meaning": "old", "thresholds": [],
                           "series": [{"model": "GFS"}]},
                          {"id": "gone", "a": "A", "b": "B", "meaning": "m", "thresholds": [], "series": []}]}
    out = repage.refresh(data, cfg)
    g = out["gradients"][0]
    assert g["codes"] == ["OLM", "BLI"] and g["meaning"] == "new meaning" and g["thresholds"][0]["value"] == 9
    assert g["series"] == [{"model": "GFS"}]                       # model data untouched
    assert "codes" not in out["gradients"][1]                      # unknown ids left alone
    assert repage.briefing_date(data, cfg) == "2026-11-04"          # 06:30Z is the evening before in Pacific time
