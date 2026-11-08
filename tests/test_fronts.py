from datetime import datetime, timezone
from pathlib import Path

from briefing import fronts

TEXT = (Path(__file__).parent / "fixtures" / "codsus_hr.txt").read_text()


def test_parse_coded():
    f = fronts.parse_coded(TEXT, now=datetime(2026, 11, 8, 6, tzinfo=timezone.utc))
    assert f["valid"] == "2026-11-08T03:00:00+00:00"
    cold = f["fronts"][0]
    assert cold["type"] == "cold" and cold["coords"][0] == [-127.3, 49.9] and len(cold["coords"]) == 9
    # continuation lines join their front
    assert len(f["fronts"][3]["coords"]) == 13
    lows = [c for c in f["centers"] if c["type"] == "L"]
    assert lows[0] == {"type": "L", "lon": -138.1, "lat": 52.8, "p": 976}


def test_clip_keeps_nearby():
    cfg = {"domain": {"lon_min": -126, "lat_min": 44, "lon_max": -120, "lat_max": 51}}
    f = fronts._clip(fronts.parse_coded(TEXT), fronts._box(cfg))
    assert "cold" in [x["type"] for x in f["fronts"]]
    assert all(x["coords"][0][0] < -100 for x in f["fronts"])


def test_nfc_valid():
    assert fronts.nfc_valid("Cold Front Valid: Sun Morning Nov 08 2026") == datetime(2026, 11, 8, 12, tzinfo=timezone.utc)
    assert fronts.nfc_valid("High Valid: Sat Nov 07 2026") == datetime(2026, 11, 8, 0, tzinfo=timezone.utc)
    assert fronts.nfc_valid("nothing") is None


def test_nfc_frame():
    box = (-140, 35, -110, 60)
    fr = [{"properties": {"feat": "Cold Front Valid", "popupconte": "Cold Front Valid: Sun Morning Nov 08 2026"},
           "geometry": {"type": "MultiLineString", "coordinates": [[[-127, 49], [-126, 47]], [[-80, 30], [-79, 29]]]}}]
    hl = [{"properties": {"feat": "Low Valid", "popupconte": "Low Valid: Sun Morning Nov 08 2026"}, "geometry": {"type": "Point", "coordinates": [-130, 50]}}]
    f = fronts.nfc_frame(hl, fr, box)
    assert f["valid"] == "2026-11-08T12:00:00+00:00" and len(f["fronts"]) == 1 and f["centers"][0]["type"] == "L"
