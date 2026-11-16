import json, re, sys, requests
out = {}
def ls(url):
    r = requests.get(url, timeout=60); r.raise_for_status()
    return sorted(set(re.findall(r'href="([^"?/][^"]*)"', r.text)))
base = "https://dd.weather.gc.ca/today/model_rdwps/"
out["root"] = ls(base)
for d in out["root"][:12]:
    try:
        out[d] = ls(base + d)[:40]
    except Exception as e:
        out[d] = str(e)
# dig into anything mentioning pacific/national
def walk(url, depth=0, acc=None):
    acc = acc if acc is not None else []
    if depth > 4 or len(acc) > 400: return acc
    try: items = ls(url)
    except Exception as e: acc.append(f"ERR {url} {e}"); return acc
    for it in items:
        if it.endswith("/"):
            if depth < 3 or len(items) < 8: walk(url + it, depth + 1, acc)
            else: acc.append(url + it + " (dir, " + str(len(items)) + " siblings)"); break
        else:
            acc.append(url + it)
    return acc
for d in out["root"]:
    if any(k in d.lower() for k in ("national", "pacific", "nep", "salish")):
        files = walk(base + d)
        out["walk_" + d] = files[:200]
json.dump(out, open("probe-out/rdwps.json", "w"), indent=1)
