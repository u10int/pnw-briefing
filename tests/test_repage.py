"""Page-only rebuild: config labels re-applied to published data, and the briefing's date."""
from briefing import repage


def test_refresh_gradient_labels_and_date():
    cfg = {"timezone": "America/Los_Angeles", "title": "PNW weather briefing",
           "gradients": [{"id": "olm_bli", "a": {"name": "Olympia", "code": "OLM", "lat": 46.97, "lon": -122.9},
                          "b": {"name": "Bellingham", "code": "BLI", "lat": 48.79, "lon": -122.54},
                          "meaning": "new meaning", "thresholds": [{"value": 9, "label": "x"}]}]}
    data = {"meta": {"issued": "2026-11-05T06:30:00+00:00", "title": "Old title"},
            "gradients": [{"id": "olm_bli", "a": "Olympia", "b": "Bellingham", "meaning": "old", "thresholds": [],
                           "series": [{"model": "GFS"}]},
                          {"id": "gone", "a": "A", "b": "B", "meaning": "m", "thresholds": [], "series": []}]}
    out = repage.refresh(data, cfg)
    assert out["meta"]["title"] == "PNW weather briefing"
    g = out["gradients"][0]
    assert g["codes"] == ["OLM", "BLI"] and g["meaning"] == "new meaning" and g["thresholds"][0]["value"] == 9
    assert g["locs"] == [[-122.9, 46.97], [-122.54, 48.79]]
    assert g["series"] == [{"model": "GFS"}]                       # model data untouched
    assert "codes" not in out["gradients"][1]                      # unknown ids left alone
    assert repage.briefing_date(data, cfg) == "2026-11-04"          # 06:30Z is the evening before in Pacific time
