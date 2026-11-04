"""Landslide index (USGS Seattle threshold), the avalanche.org parsing, and pressure read outside the map."""
from datetime import datetime, timezone

import numpy as np

from briefing import avalanche, landslide
from briefing.grib import _sample_sites, outside_sites


def test_index_series_from_observed_into_forecast():
    obs = [0.2] * 30                                  # 15 days before = 3.0 in
    fc = [1.0, 1.0, 1.5, None]
    ser = landslide.index_series(obs, fc)
    assert len(ser) == 3                               # stops at the first missing forecast day
    p3, p15, idx = ser[2]
    assert p3 == 3.5 and abs(p15 - 3.0) < 1e-9 and abs(idx - (3.5 + 0.67 * 3.0)) < 1e-9
    p3, p15, _ = ser[0]                                # two observed days + day 1
    assert abs(p3 - 1.4) < 1e-9 and abs(p15 - 3.0) < 1e-9


def test_compute_needed_rain_and_models():
    cfg = {"days": 3, "landslide": {"points": ["Seattle"]}}
    obs = {"daily": {"Seattle": [None] * 15 + [0.3] * 15}}        # 4.5 in over the last 15 days
    models = [{"label": "GFS", "tier": "global", "data": {"Seattle": {"precipitation_sum": [0.1, 0.2, 0.3]}}}]
    out = landslide.compute(models, obs, cfg, datetime(2026, 11, 4, 12, tzinfo=timezone.utc))
    p = out["points"][0]
    assert p["observed"]["needed3"] == round(3.5 - 0.67 * 4.5, 2)
    assert p["models"][0]["index"][0] is not None and out["days"][0]["start"] == "2026-11-04T12:00:00Z"


def test_avalanche_text_and_bands():
    assert avalanche._text("<p>Avoid steep&rsquo;s <b>slopes</b></p>") == "Avoid steep’s slopes"
    danger = [{"lower": 2, "middle": 2, "upper": 3, "valid_day": "current"},
              {"lower": None, "middle": None, "upper": None, "valid_day": "tomorrow"}]
    assert avalanche._bands(danger, "current") == {"upper": 3, "middle": 2, "lower": 2}
    assert avalanche._bands(danger, "tomorrow") is None
    assert avalanche._local_date("2026-11-21T02:30:00", avalanche.ZoneInfo("America/Los_Angeles")) == "2026-11-20"


def test_pressure_read_outside_the_map():
    import xarray as xr
    lat, lon = np.arange(40, 56, 0.25), np.arange(230, 245, 0.25)    # 0-360 longitudes, like GFS
    da = xr.DataArray(np.add.outer(lat, np.zeros_like(lon)), coords={"latitude": lat, "longitude": lon},
                      dims=("latitude", "longitude"))
    cfg = {"domain": {"lat_min": 43, "lat_max": 50, "lon_min": -125.8, "lon_max": -118.5},
           "gradients": [{"a": {"name": "Bellingham", "lat": 48.79, "lon": -122.54},
                          "b": {"name": "Williams Lake", "lat": 52.18, "lon": -122.05}}]}
    sites = outside_sites(cfg)
    assert [s["name"] for s in sites] == ["Williams Lake"]
    v = _sample_sites(da, sites + [{"name": "far", "lat": 70.0, "lon": -122.0}])
    assert abs(v[0] - 52.25) < 0.3 and np.isnan(v[1])                # nearest cell, and NaN off the grid
