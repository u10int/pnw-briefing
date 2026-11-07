"""Prepare already-published briefing data for a page-only rebuild (no model downloads).

    python -m briefing.repage web/public/data/briefing.json

Re-applies the labels that come straight from config.yaml (the page title, pressure-gradient station names,
codes, locations, meanings and thresholds), so a config tweak shows up without re-fetching anything, and
prints the briefing's date (YYYY-MM-DD) and cycle (YYYY-MM-DDTHHZ, possibly empty) for the archive. Everything computed from
model data stays as published.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

ROOT = Path(__file__).resolve().parent


def refresh(data: dict, cfg: dict) -> dict:
    if cfg.get("title"):
        data.setdefault("meta", {})["title"] = cfg["title"]
    by_id = {g["id"]: g for g in cfg.get("gradients", [])}
    for g in data.get("gradients") or []:
        c = by_id.get(g.get("id"))
        if not c:
            continue
        g.update({"a": c["a"]["name"], "b": c["b"]["name"],
                  "codes": [c["a"].get("code"), c["b"].get("code")],
                  "locs": [[c["a"]["lon"], c["a"]["lat"]], [c["b"]["lon"], c["b"]["lat"]]],
                  "meaning": c["meaning"], "thresholds": c.get("thresholds", [])})
    return data


def briefing_date(data: dict, cfg: dict) -> str:
    """The briefing's day: its first 12Z – 12Z day (an overnight 06Z edition still belongs to the
    evening before), or the local date it was issued for older briefings."""
    if data.get("dates") and (data.get("meta") or {}).get("cycle"):
        return str(data["dates"][0])[:10]
    issued = datetime.fromisoformat(data["meta"]["issued"])
    return issued.astimezone(ZoneInfo(cfg["timezone"])).date().isoformat()


def briefing_cycle(data: dict) -> str:
    """The edition's cycle as YYYY-MM-DDTHHZ ("" for briefings before editions followed cycles)."""
    c = (data.get("meta") or {}).get("cycle") or ""
    return f"{c[:13]}Z" if c else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("briefing", type=Path)
    ap.add_argument("--config", default=str(ROOT.parent / "config.yaml"))
    a = ap.parse_args()
    cfg = yaml.safe_load(open(a.config))
    data = json.loads(a.briefing.read_text())
    a.briefing.write_text(json.dumps(refresh(data, cfg), separators=(",", ":")))
    print(briefing_date(data, cfg), briefing_cycle(data))


if __name__ == "__main__":
    main()
