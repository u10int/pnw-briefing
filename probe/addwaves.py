"""Fetch the wave grids for real and add them to a copy of the published data."""
import json, sys, time, logging
from datetime import datetime, timezone
from pathlib import Path
import yaml
from briefing import waves, analysis
from briefing.grib import cycle_start
logging.basicConfig(level=logging.INFO)
cfg = yaml.safe_load(open("config.yaml"))
site = Path(sys.argv[1])
t0 = time.time()
w = waves.fetch(cfg, datetime.now(timezone.utc))
print("fetch seconds", round(time.time() - t0), "steps", len(w["hours"]), "grid", w["lat"].shape, w["lon"].shape)
import numpy as np
print("wave max ft", float(np.nanmax(w["wave"])), "period range", float(np.nanmin(w["wper"])), float(np.nanmax(w["wper"])))
b = json.load(open(site / "briefing.json"))
start = datetime.fromisoformat(b["meta"]["cycle"].replace("Z", "+00:00")).replace(tzinfo=None) if b["meta"].get("cycle") else cycle_start()
fm = waves.export_fields(w, site / "fields")
cm = waves.export_cogs(w, analysis.windows(cfg), start, site / "cogs")
print("cogs", [(c["days"]) for c in cm])
f = json.load(open(site / "fields.json")); f["fields"] += fm; json.dump(f, open(site / "fields.json", "w"))
b["cogs"] += cm; b["waveGrid"] = waves.summary(w, None, start); json.dump(b, open(site / "briefing.json", "w"))
sizes = sum((site / "fields" / Path(e["path"]).name).stat().st_size for e in fm)
print("field MB", round(sizes / 1e6, 1))
