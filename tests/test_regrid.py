"""Regridding onto the common grid: bilinear from regular lat/lon sources, nearest elsewhere."""
import numpy as np

from briefing import analysis


def test_bilinear_from_regular_grid():
    lat, lon = np.array([45.0, 45.25, 45.5]), np.array([-123.0, -122.75, -122.5])
    f = np.add.outer(lat * 4, lon * 4).astype("float32")          # a plane: linear in both axes
    glat, glon = np.arange(45.0, 45.51, 0.05), np.arange(-123.0, -122.49, 0.05)
    out = analysis.regrid(lat, lon, f, glat, glon)
    np.testing.assert_allclose(out, np.add.outer(glat * 4, glon * 4), atol=1e-4)
    assert len(np.unique(np.round(out, 4))) > 9                    # not nine flat blocks


def test_descending_lat_and_time_axis():
    lat, lon = np.array([45.5, 45.25, 45.0]), np.array([-123.0, -122.75, -122.5])
    f = np.stack([np.add.outer(lat, lon), 2 * np.add.outer(lat, lon)]).astype("float32")
    glat, glon = np.array([45.1, 45.4]), np.array([-122.9, -122.6])
    out = analysis.regrid(lat, lon, f, glat, glon)
    np.testing.assert_allclose(out[1], 2 * out[0], rtol=1e-6)
    np.testing.assert_allclose(out[0], np.add.outer(glat, glon), atol=1e-4)


def test_missing_neighbour_falls_back_to_nearest():
    lat, lon = np.array([45.0, 45.25]), np.array([-123.0, -122.75])
    f = np.array([[1.0, np.nan], [3.0, 4.0]], dtype="float32")
    out = analysis.regrid(lat, lon, f, np.array([45.0, 45.25]), np.array([-123.0]))
    np.testing.assert_allclose(out[:, 0], [1.0, 3.0])                # edge column: nearest, not NaN
