"""Embed briefing.json and the map images into the single-file page build.

    cd web && npm run build:single
    python -m briefing.standalone web/public/data web/dist-single/index.html briefing.html

The result opens from disk or as an email attachment, with no server and no data folder.
Maps, COGs (for the interactive map) and data are all embedded.
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path


def embed(data_dir: Path, page: Path, out: Path) -> Path:
    data = json.loads((data_dir / "briefing.json").read_text())
    for key, name in (data.get("maps") or {}).items():
        if name:
            b64 = base64.b64encode((data_dir / name).read_bytes()).decode()
            data["maps"][key] = f"data:image/png;base64,{b64}"
    for c in data.get("cogs") or []:
        f = data_dir / c["path"]
        if f.exists():
            c["path"] = "data:image/tiff;base64," + base64.b64encode(f.read_bytes()).decode()
    fields_path = data_dir / "fields.json"
    if fields_path.exists():
        fl = json.loads(fields_path.read_text())
        for e in fl.get("fields", []):
            f = data_dir / e["path"]
            if f.exists():
                e["path"] = "data:image/tiff;base64," + base64.b64encode(f.read_bytes()).decode()
        data["_fields"] = fl
    payload = json.dumps(data, separators=(",", ":")).replace("</", "<\\/")
    html = page.read_text(encoding="utf-8")
    inject = f"<script>window.__BRIEFING__={payload}</script>"
    worker = next(page.parent.glob("maplibre-gl-worker*.js"), None)   # emitted beside the single-file build
    if worker:
        inject += f"<script>window.__MAPLIBRE_WORKER__=\"{base64.b64encode(worker.read_bytes()).decode()}\"</script>"
    html = html.replace("<head>", f"<head>{inject}", 1)
    out.write_text(html, encoding="utf-8")
    return out


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    print(embed(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])))
