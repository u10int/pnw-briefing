"""IVT components exported as time-stepped fields for the map."""
import tempfile
from datetime import datetime
from pathlib import Path

import numpy as np

from briefing import fields


def test_export_ivt_components():
    lat, lon = np.arange(43.0, 50.01, 0.25), np.arange(-125.75, -118.49, 0.25)
    u = np.full((3, lat.size, lon.size), 400.0, "float32")
    v = np.full_like(u, 300.0)
    m = {"id": "gfs", "label": "GFS", "tier": "global", "run": datetime(2026, 11, 4, 0),
         "ivt": {"hours": [6, 12, 18], "lat": lat, "lon": lon, "u": u, "v": v}}
    out, manifest = Path(tempfile.mkdtemp()), []
    fields._export_ivt(m, out, manifest)
    assert [e["var"] for e in manifest] == ["ivtu", "ivtv"]
    assert manifest[0]["times"][0].startswith("2026-11-04T06:00")
    import rasterio
    with rasterio.open(out / "gfs_ivtu.tif") as r:
        assert r.count == 3 and abs(r.read(1)[5, 5] * manifest[0]["scale"] - 400.0) < 0.2


def test_no_ivt_no_files():
    manifest = []
    fields._export_ivt({"id": "x", "label": "X", "run": datetime(2026, 11, 4)}, Path(tempfile.mkdtemp()), manifest)
    assert manifest == []
