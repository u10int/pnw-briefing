import json, urllib.request
g = lambda u: json.load(urllib.request.urlopen(u))
a = g("https://basemaps.cartocdn.com/gl/positron-gl-style/style.json")
b = g("https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json")
ia, ib = [l["id"] for l in a["layers"]], [l["id"] for l in b["layers"]]
print("positron", len(ia), "dark", len(ib), "common", len(set(ia) & set(ib)), "same order", ia == ib)
print("only positron", sorted(set(ia) - set(ib))[:20]); print("only dark", sorted(set(ib) - set(ia))[:20])
print("sources", a["sources"].keys(), b["sources"].keys(), a.get("sprite"), b.get("sprite"), a.get("glyphs") == b.get("glyphs"))
diff_src = [l["id"] for l in a["layers"] if l["id"] in ib and (l.get("source-layer"), l.get("filter"), l["type"]) != next((m.get("source-layer"), m.get("filter"), m["type"]) for m in b["layers"] if m["id"] == l["id"])]
print("layers with different type/source/filter", diff_src[:20])
print("bg", [l["paint"] for l in b["layers"] if l["type"] == "background"])
print("water", [l.get("paint") for l in b["layers"] if l["id"] == "water"])
