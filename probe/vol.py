import json, logging, os, time, yaml
from pathlib import Path
from briefing import volume
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logging.getLogger("herbie").setLevel(logging.WARNING)
cfg = yaml.safe_load(open("config.yaml"))
cfg["grib_models"] = [m for m in cfg["grib_models"] if m["id"] in ("hrrr", "rrfs")]
os.environ["BRIEFING_CYCLE"] = os.environ.get("CYC", "2026-11-13T18Z")
out = Path("/tmp/vout"); out.mkdir(exist_ok=True)
t = time.time()
man = volume.build(cfg, out)
print("took", round(time.time() - t), "s")
for e in man:
    print(e["model"], e["nx"], e["ny"], e["nz"], len(e["times"]), e["lat"], e["lon"], sorted(e["vars"]))
tot = 0
for f in sorted((out / "volume").glob("*.gz")):
    tot += f.stat().st_size; print(f.name, round(f.stat().st_size / 1e6, 2), "MB")
print("total MB", round(tot / 1e6, 1))
import gzip, numpy as np
for e in man:
    b = np.frombuffer(gzip.decompress((out / e["vars"]["cloud"]["path"]).read_bytes()), np.uint8)
    print(e["model"], "cloud missing", round(float((b == 255).mean()), 3), "cloudy>50%", round(float(((b > 127) & (b < 255)).mean()), 3))
