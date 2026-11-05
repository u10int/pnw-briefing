"""Wildfire sources, parsed from responses captured from the live services (Nov 2026), replayed
through a stubbed requests.get, plus the geometry helpers."""
import json
from pathlib import Path
from urllib.parse import urlparse

import pytest
import yaml

from briefing import wildfire

ROOT = Path(__file__).resolve().parents[1]
CFG = yaml.safe_load((ROOT / "config.yaml").read_text())
FIX = Path(__file__).parent / "fixtures" / "wildfire_live.json"


class _Resp:
    def __init__(self, js):
        self._js = js
        self.status_code = 200

    def raise_for_status(self):
        pass

    def json(self):
        return self._js


@pytest.fixture
def live(monkeypatch):
    data = json.loads(FIX.read_text())

    def get(url, params=None, **kw):
        path = urlparse(url).path
        spatial = bool(params and params.get("geometry"))
        if "SPC_firewx" in path:
            lid = path.split("/")[-2]
            return _Resp(data[f"spc{lid}" if spatial else f"spcmeta{lid}"])
        key = ("psa_areas" if "PSA_GACC_KeyRAWS" in path else "psa_fc" if "current_forecast" in path
               else "inc" if "Incident_Locations" in path else "per" if "Perimeters" in path
               else "usdm" if "USDM" in path else None)
        return _Resp(data[key])
    monkeypatch.setattr(wildfire.requests, "get", get)
    return data


def test_spc_quiet_week_keeps_valid_days(live):
    days = wildfire.spc_outlooks(CFG)
    assert [d["day"] for d in days] == list(range(1, 9))
    assert all(d["date"] and d["valid"] for d in days)
    assert all(not d["areas"] for d in days)          # nothing over the region this week


def test_psa_names_and_ten_days(live):
    psa = wildfire.psa_potential(CFG)
    names = {a["name"] for a in psa["areas"]}
    assert {"W1", "W2", "W3", "W4"} <= names
    assert len(psa["dates"]) == 10
    w2 = next(a for a in psa["areas"] if a["name"] == "W2")
    assert "Portland" in w2["points"] and all(d and d["label"] for d in w2["days"])


def test_incidents_and_perimeters(live):
    inc = wildfire.incidents(CFG)
    assert inc and all(r["type"] in ("Wildfire", "Prescribed fire", "Complex") for r in inc)
    sizes = [r["acres"] or 0 for r in inc if r["type"] != "Prescribed fire"]
    assert sizes == sorted(sizes, reverse=True)
    per = wildfire.perimeters(CFG)
    assert per["features"] and all(f["geometry"]["type"] == "MultiPolygon" for f in per["features"])


def test_drought_points(live):
    dm = wildfire.drought(CFG)
    assert dm["released"] and dm["categories"]
    assert set(dm["points"]) == {p["name"] for p in CFG["points"]}
    assert all(v is None or 0 <= v <= 4 for v in dm["points"].values())


def test_contains_respects_holes():
    sq = lambda a, b: [[a, a], [b, a], [b, b], [a, b], [a, a]]
    g = {"type": "Polygon", "coordinates": [sq(0, 10), sq(4, 6)]}
    assert wildfire._contains(g, 2, 2) and not wildfire._contains(g, 5, 5)


def test_demo_is_complete():
    d = wildfire.fetch(CFG, demo=True)
    assert d["alerts"] and d["spc"] and d["psa"]["areas"] and d["incidents"] and d["drought"]["categories"]
