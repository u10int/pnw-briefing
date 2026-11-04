"""Ensemble odds, observed precipitation (demo data) and pressure gradients.

    PYTHONPATH=. python tests/test_context.py
"""
import tempfile
from datetime import datetime
from pathlib import Path

import numpy as np
import yaml

from briefing import context, observed, odds

CFG = yaml.safe_load(open(Path(__file__).parent.parent / "config.yaml"))
LAT = np.array([46.0, 46.25])
LON = np.array([-123.0, -122.75])


def _ens(label, values, snow=None):
    """values: [member, day] applied to every grid cell."""
    v = np.asarray(values, dtype="float32")[:, :, None, None] * np.ones((1, 1, 2, 2), "float32")
    s = None if snow is None else np.asarray(snow, "float32")[:, :, None, None] * np.ones((1, 1, 2, 2), "float32")
    return {"label": label, "dates": ["2026-11-04", "2026-11-05", "2026-11-06"],
            "grid": {"lat": LAT, "lon": LON, "precip_in": v, "snow_in": s}}


def test_point_odds_pool_members_and_use_place_thresholds():
    cfg = {"points": [{"name": "Low", "lat": 46.0, "lon": -123.0, "kind": "lowland"}],
           "impacts": {"heavy_rain_24h": {"lowland": 1.0}, "heavy_rain_72h": {"lowland": 2.5},
                       "snow_24h": {"lowland": 1.0}}}
    a = _ens("A", [[1.2, 0.1, 0.1], [0.5, 1.5, 1.2], [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]])          # 4 members
    b = _ens("B", [[0.0, 0.0, 2.0], [2.0, 0.0, 0.0]], snow=[[0, 2, 0], [0, 0, 0]])           # 2 members
    o = odds.point_odds([a, b], cfg)["points"]["Low"]
    assert o["rain24"] == [round(100 * 3 / 6), round(100 * 2 / 6), round(100 * 3 / 6)]
    assert o["rain72"][:2] == [None, None] and o["rain72"][2] == round(100 * 2 / 6)          # 3.2" and 3.0"
    assert o["snow24"] == [0, 50, 0] and o["snow24N"] == [2, 2, 2]                             # snow from B alone


def test_odds_maps_written():
    cfg = {**CFG, "domain": {"lat_min": 45.9, "lat_max": 46.4, "lon_min": -123.1, "lon_max": -122.6},
           "windows": [{"days": 3, "label": "Next 3 days"}]}
    a = _ens("A", [[1.2, 0.1, 2.0], [0.0, 0.0, 0.0]])
    with tempfile.TemporaryDirectory() as d:
        m = odds.grids([a], cfg, Path(d))
        assert {(e["var"], e["days"]) for e in m} == {("p24", 3), ("p72", 3)}
        import rasterio
        with rasterio.open(Path(d) / "odds_p24_3d.tif") as r:
            assert abs(np.nanmax(r.read(1)) - 50) < 1e-3                                       # 1 of 2 members


def test_observed_demo_windows():
    with tempfile.TemporaryDirectory() as d:
        s, g = observed.summarize(CFG, datetime(2026, 11, 4, 12), Path(d), demo=True)
    w7, w30 = s["windows"]
    assert (w7["days"], w30["days"]) == (7, 30) and len(s["dates"]) == 30
    assert w30["missingDays"] and not w7["missingDays"]                                       # demo drops one old day
    assert w30["regions"]["wwa"]["obs"] > w7["regions"]["wwa"]["obs"] > 0
    assert g["obs30"].shape == g["pct30"].shape


def test_gradient_sign():
    from datetime import timezone
    lat, lon = np.array([45.0, 46.0, 47.0, 48.0, 49.0]), np.array([-123.0, -122.0])
    mslp = np.zeros((2, 5, 2), "float32")
    mslp[:, 0, :] = 1020                      # south high
    mslp[:, 4, :] = 1008                      # north low
    m = {"label": "M", "tier": "global", "run": datetime(2026, 11, 4, 12, tzinfo=timezone.utc), "lat": lat, "lon": lon,
         "fields": {"mslp": {"hours": [6, 12], "data": mslp}}}
    cfg = {"gradients": [{"id": "s_n", "a": {"name": "S", "lat": 45.0, "lon": -123.0},
                          "b": {"name": "N", "lat": 49.0, "lon": -123.0}, "meaning": "", "thresholds": []}]}
    g = context.gradients([m], cfg)[0]
    assert g["series"][0]["values"] == [12.0, 12.0] and g["series"][0]["times"][0] == "2026-11-04T18:00:00Z"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
