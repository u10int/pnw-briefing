from datetime import datetime

from briefing import timing

CFG = {"points": [{"name": "Seattle", "kind": "lowland"}, {"name": "Forks", "kind": "coast"}]}


def _model(label, gusts, rates):
    times = [f"2026-11-07T{12 + k:02d}:00Z" if 12 + k < 24 else f"2026-11-08T{k - 12:02d}:00Z" for k in range(1, 25)]
    return {"label": label, "hourly": {"times": times, "step": [1] * 24,
            "gust": {"Seattle": gusts, "Forks": [20] * 24}, "rate": {"Seattle": rates, "Forks": [0.0] * 24}}}


def test_periods_peaks_and_spread():
    g1 = [20] * 5 + [36, 42, 48, 40, 36] + [20] * 14            # 18Z – 22Z, peak 20Z
    g2 = [20] * 6 + [37, 45, 50, 38] + [20] * 14                # 19Z – 22Z, peak 21Z
    r = [0.0] * 10 + [0.12, 0.35, 0.2, 0.0, 0.11] + [0.0] * 9   # 23Z – 01Z, then a gap and 03Z
    out = timing.compute([_model("HRRR", g1, r), _model("RRFS", g2, r)], CFG, datetime(2026, 11, 7, 12))
    sea = out["points"]["Seattle"]
    assert "Forks" not in out["points"]                           # nothing reaches the thresholds there
    g = sea["gust"][0]
    assert g["start"] == "2026-11-07T19:00Z" and g["end"] == "2026-11-07T22:00Z"
    assert g["peak"] == 46 and g["peakTime"] == "2026-11-07T20:00Z"   # median of 48 and 45 at 20Z
    assert g["peakFrom"] == "2026-11-07T20:00Z" and g["peakTo"] == "2026-11-07T21:00Z" and g["models"] == 2
    p = sea["precip"][0]
    assert p["start"] == "2026-11-07T23:00Z" and p["end"] == "2026-11-08T03:00Z"   # the 2-hour gap is bridged
    assert p["heavy"] and p["peak"] == 0.35
