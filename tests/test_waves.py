from datetime import datetime, timedelta

import numpy as np

from briefing import waves


def _w():
    lat, lon = np.arange(44, 48, 0.5), np.arange(-127, -123, 0.5)
    hs = list(range(0, 49)) + list(range(51, 241, 3))
    n = len(hs)
    wave = np.full((n, len(lat), len(lon)), 6.0, dtype="float32")
    wave[30] = 18.0                                    # hour 30: the biggest waves
    wave[:, 0, 0] = np.nan                             # land
    return {"run": datetime(2026, 11, 16, 12), "hours": hs, "lat": lat, "lon": lon, "wave": wave,
            "wper": np.full_like(wave, 12.0), "wu": np.zeros_like(wave), "wv": np.zeros_like(wave)}


def test_hours_hourly_then_stepped():
    h = waves.hours({"hourly_hours": 48, "step": 3, "max_hours": 60})
    assert h[:3] == [0, 1, 2] and h[48] == 48 and h[49:] == [51, 54, 57, 60]


def test_window_maxima_cover_only_windows_the_forecast_reaches(tmp_path):
    wins = [{"days": 2, "label": "Through tomorrow"}, {"days": 7, "label": "Next 7 days"}, {"days": 14, "label": "Next 14 days"}]
    man = waves.export_cogs(_w(), wins, datetime(2026, 11, 16, 12), tmp_path)
    assert [m["days"] for m in man] == [2, 7] and all(m["var"] == "waves" and m["model"] == "GFS-Wave" for m in man)
    import rasterio
    with rasterio.open(tmp_path / "gfswave_waves_2d.tif") as r:
        a = r.read(1)
    assert np.nanmax(a) == 18.0


def test_fields_manifest(tmp_path):
    man = waves.export_fields(_w(), tmp_path)
    assert {m["var"] for m in man} == {"wave", "wper", "wu", "wv"}
    assert len(man[0]["times"]) == len(_w()["hours"]) and man[0]["times"][0].startswith("2026-11-16T12:00:00")


def test_group_speed_points_where_waves_head():
    # waves from the west (270°) at 12 s head east at g T / 4π
    to = np.deg2rad(270 + 180.0)
    cg = waves.G * 12 / (4 * np.pi) * waves.MS_TO_MPH
    assert abs(cg * np.sin(to) - cg) < 1e-6 and abs(cg * np.cos(to)) < 1e-6
