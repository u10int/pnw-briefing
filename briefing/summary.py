"""The briefing's headline and lead: a quick overview of the key impacts and events.

Code decides the facts; a language model (OpenAI, when OPENAI_API_KEY is set) only words them.
The facts are drawn from the briefing's own data: the impact periods, active NWS alerts, the
atmospheric-river outlook, snow level against the passes, temperatures and precipitation
against normal, river forecasts and what changed since yesterday. Forecaster discussions are
deliberately left out, so the overview rests on the data alone.

Places are given as broad areas (Puget Sound, the coast, the Cascades passes) and timing as
relative phrases ("this weekend", "early next week") so the overview stays general. After the
model answers, every number in its text must appear in the facts; if not, or if the API is
unavailable, the overview falls back to rule-based sentences written from the same facts.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np

log = logging.getLogger(__name__)

URL = "https://api.openai.com/v1/chat/completions"
DEFAULT_MODEL = "gpt-4.1-mini"
WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
WEEKDAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
AR_WORD = ["", "weak", "moderate", "strong", "extreme", "exceptional"]
FLOOD = ["", "action stage", "minor flooding", "moderate flooding", "major flooding"]


# ---------------------------------------------------------------- timing and places

def _d(s) -> date:
    return date.fromisoformat(str(s)[:10])


def _day_word(d: date, today: date) -> str:
    n = (d - today).days
    if n == 0:
        return "today"
    if n == 1:
        return "tomorrow"
    week = (d - timedelta(days=d.weekday())) - (today - timedelta(days=today.weekday()))
    if week.days == 0:
        return WEEKDAY_LONG[d.weekday()]
    if week.days == 7:
        return f"next {WEEKDAY_LONG[d.weekday()]}"
    return f"in about {n} days"


def _part_of_week(d: date, today: date) -> tuple[str, str]:
    """("early" | "mid" | "late", "this week" | "next week" | ...) for a date."""
    part = "early" if d.weekday() <= 1 else "mid" if d.weekday() <= 3 else "late"
    week = ((d - timedelta(days=d.weekday())) - (today - timedelta(days=today.weekday()))).days // 7
    ref = "this week" if week == 0 else "next week" if week == 1 else "the week after next" if week == 2 else f"in about {(d - today).days} days"
    return part, ref


def when(start, end, today: date) -> dict:
    """{when, weekdays, startsInDays, days}: a relative phrase for a period of local dates."""
    s, e = _d(start), _d(end or start)
    n = (s - today).days
    span = (e - s).days + 1
    weeks = ((s - timedelta(days=s.weekday())) - (today - timedelta(days=today.weekday()))).days // 7
    if span == 1:
        phrase = _day_word(s, today)
    elif span == 2 and n <= 1:
        phrase = f"{_day_word(s, today)} into {_day_word(e, today)}"
    elif s.weekday() == 5 and span == 2:
        phrase = "this weekend" if weeks == 0 else "next weekend" if weeks == 1 else f"in about {n} days"
    else:
        (pa, ra), (pb, rb) = _part_of_week(s, today), _part_of_week(e, today)
        if ra == rb:
            phrase = f"{pa} {ra}" if pa == pb else f"{pa} to {pb} {ra}"
        else:
            phrase = f"{pa} {ra} into {pb} {rb}" if span <= 4 else f"{pa} {ra} through {pb} {rb}"
        phrase = phrase.replace("mid this week", "midweek")
    wd = WEEKDAY[s.weekday()] if span == 1 else f"{WEEKDAY[s.weekday()]} – {WEEKDAY[e.weekday()]}"
    return {"when": phrase, "weekdays": wd, "startsInDays": n, "days": span}


def _places(cfg) -> dict:
    regions = {k: v["name"] for k, v in (cfg.get("regions") or {}).items()}
    return {p["name"]: {"zone": p.get("zone") or p.get("area") or p["name"], "kind": p["kind"],
                        "region": regions.get(p.get("region"), p.get("zone") or "")} for p in cfg["points"]}


def where(names, places) -> dict:
    """The broad areas a set of locations falls in: their zones and regions, and whether they're all passes."""
    ps = [places[n] for n in names if n in places]
    zones = list(dict.fromkeys(p["zone"] for p in ps))
    regions = list(dict.fromkeys(p["region"] for p in ps if p["region"]))
    out = {"areas": zones, "regions": regions}
    if ps and all(p["kind"] == "pass" for p in ps):
        out["elevation"] = "mountain passes"
    return out


# ---------------------------------------------------------------- facts

def _num(v, unit):
    return int(round(v)) if unit in ("mph", "°F", "ft", "%") else round(float(v), 1)


def facts(data: dict, cfg: dict) -> dict:
    """Everything the overview may say, as plain data, each item with an `importance` for ranking."""
    tz = ZoneInfo(cfg["timezone"])
    issued = datetime.fromisoformat(data["meta"]["issued"]).astimezone(tz)
    today = issued.date()
    places = _places(cfg)
    items = []

    for e in data.get("events") or []:
        unit = (e.get("unit") or "").split("/")[0]
        pts = e.get("points") or []
        peak = max((p["peak"] for p in pts if p.get("peak") is not None), default=None)
        main = [p["name"] for p in pts if p.get("frac", 1) >= 0.5] or [p["name"] for p in pts[:2]]
        items.append({
            "kind": "impact", "hazard": e["label"], "likelihood": e["level"],
            "shareOfModels": f"{round(100 * e['agreement'])}%", **when(e["start"], e["end"], today),
            **where(main, places), "worst": None if peak is None else f"{_num(peak, unit)} {unit}",
            "importance": (3 if e["level"] == "likely" else 2) + {"wind": 0.4, "heavy_rain_72h": 0.5, "snow_24h": 0.3, "freezing_precip": 0.4}.get(e["hazard"], 0)
                          - 0.08 * max(0, (_d(e["start"]) - today).days),
        })

    # NWS alerts are left out on purpose: the overview speaks to impacts and events in general;
    # the alerts timeline below the headline lists the individual warnings and advisories

    ar = data.get("ar") or {}
    models = [m["model"] for m in ar.get("models") or []]
    for rank in range(5, 0, -1):
        evs = sorted((e for e in ar.get("events") or [] if e["rank"] >= rank), key=lambda e: e["start"])
        if evs:   # the first episode: events starting within a day of the earliest
            t0 = datetime.fromisoformat(evs[0]["start"].replace("Z", "+00:00"))
            evs = [e for e in evs if datetime.fromisoformat(e["start"].replace("Z", "+00:00")) - t0 <= timedelta(hours=24)]
        agree = {e["model"] for e in evs}
        if models and len(agree) / len(models) >= 0.5:
            s = min(datetime.fromisoformat(e["start"].replace("Z", "+00:00")) for e in evs).astimezone(tz).date()
            t = max(datetime.fromisoformat(e["end"].replace("Z", "+00:00")) for e in evs).astimezone(tz).date()
            items.append({"kind": "atmospheric river", "strength": f"AR{rank} ({AR_WORD[rank]})", **when(s, t, today),
                          **where(list({e["point"] for e in evs}), places),
                          "modelsAgreeing": f"{len(agree)} of {len(models)}", "importance": 1.0 + 0.7 * rank})
            break

    sl = data.get("snowLevel") or {}
    low = []
    for p in sl.get("passes") or []:
        by_t = {}
        for s in p.get("series") or []:
            for t, v in zip(s["times"], s["values"]):
                if v is not None:
                    by_t.setdefault(t, []).append(v)
        below = sorted(t for t, vs in by_t.items() if np.median(vs) < p["elev_ft"])
        if below:
            mins = min(float(np.median(v)) for v in by_t.values())
            first = datetime.fromisoformat(below[0].replace("Z", "+00:00")).astimezone(tz).date()
            low.append((p["name"], first, mins))
    if low:
        first = min(x[1] for x in low)
        items.append({"kind": "snow level reaches the passes", "passes": [x[0] for x in low], **when(first, first, today),
                      "lowestSnowLevel": f"{int(round(min(x[2] for x in low) / 500) * 500)} ft", "importance": 2.2})

    td = data.get("tempDeparture") or {}
    tw = next((w for w in td.get("windows") or [] if w["days"] == 7), None)
    if tw and tw.get("regions"):
        deps = {places_name: {"highs": f"{v['tmax']:+.0f}°F", "lows": f"{v['tmin']:+.0f}°F"}
                for rid, v in tw["regions"].items() if v.get("tmax") is not None
                for places_name in [(cfg.get("regions") or {}).get(rid, {}).get("name", rid)]}
        big = max((abs(v.get("tmax") or 0), abs(v.get("tmin") or 0)) for v in tw["regions"].values())
        items.append({"kind": "temperatures vs normal", "window": "next 7 days", "byRegion": deps,
                      "importance": 2.4 if max(big) >= 8 else 1.4 if max(big) >= 5 else 0.4})

    norms = {w["days"]: w for w in (data.get("normals") or {}).get("windows") or []}
    for w in data.get("windows") or []:
        if w["days"] not in (7, 14):
            continue
        rows = {}
        top = 0
        for r in w["regions"]:
            pct = ((norms.get(w["days"]) or {}).get("regions") or {}).get(r["rid"], {}).get("pct")
            rows[r["region"]] = {"total": f"{r['median']:.1f} in", **({"percentOfNormal": f"{round(pct)}%"} if pct is not None else {})}
            top = max(top, pct or 0)
        items.append({"kind": "precipitation total", "window": w["label"].lower(), "byRegion": rows,
                      "importance": 2.6 if top >= 200 else 1.8 if top >= 130 else 0.9 if w["days"] == 7 else 0.6})
    if data.get("wettest"):
        items.append({"kind": "wettest stretch", **when(data["wettest"]["start"], data["wettest"]["end"], today), "importance": 0.8})

    gauges = (data.get("rivers") or {}).get("gauges") or []
    flooding = [g for g in gauges if ((g.get("crest") or {}).get("level") or 0) >= 2]
    if flooding:
        lvl = max(g["crest"]["level"] for g in flooding)
        items.append({"kind": "river flooding forecast", "gauges": len(flooding), "worst": FLOOD[lvl],
                      "rivers": list(dict.fromkeys(g["name"].split(" at ")[0].split(" near ")[0] for g in flooding))[:4],
                      "importance": 2.5 + 0.5 * lvl})

    changes = []
    ch = data.get("change") or {}
    w7 = next((w for w in ch.get("windows") or [] if w["days"] == 7), None)
    if w7:
        for rid, v in w7["regions"].items():
            if abs(v["delta"]) >= 0.25:
                name = (cfg.get("regions") or {}).get(rid, {}).get("name", rid)
                changes.append(f"{name} 7-day total {'up' if v['delta'] > 0 else 'down'} {abs(v['delta']):.1f} in since yesterday")
    ev = ch.get("events") or {}
    for e in ev.get("new") or []:
        changes.append(f"new: {e['label'].lower()} ({e['level']}) {when(e['start'], e['end'], today)['when']}")
    for e in ev.get("dropped") or []:
        changes.append(f"dropped: {e['label'].lower()} {when(e['start'], e['end'], today)['when']}")

    items.sort(key=lambda x: -x["importance"])
    # at most 8 events and alerts; the precipitation and temperature context always comes along
    context = {"precipitation total", "temperatures vs normal", "wettest stretch"}
    items = [i for i in items if i["kind"] not in context][:8] + [i for i in items if i["kind"] in context]
    items.sort(key=lambda x: -x["importance"])
    return {"issued": f"{WEEKDAY_LONG[today.weekday()]} {'morning' if issued.hour < 14 else 'evening'}",
            "items": items, "changesSinceYesterday": changes}


# ---------------------------------------------------------------- the model's words

SYSTEM = """You write the headline and lead for a weather briefing, updated four times a day, covering Western Washington, Northwest Oregon and southwest British Columbia.
Use only the facts given. Do not add places, timings, numbers or hazards that are not in them, and do not speculate.
- Headline: at most 10 words, sentence case (capitalise the first word and proper names only), no final period. Lead with the most important impact or event (facts are listed most important first). When the headline names more than one event, give each its own area if they differ (e.g. "Windy for Puget Sound, heavy rain for Southwest BC"); never attach one area to events that happen in different places.
- Lead: the same rule for places and timing applies; one or two short sentences, at most 40 words in all, giving a quick overview of the other key impacts and events, in order of importance. Leave out anything minor.
- Describe the weather and its impacts, never named NWS products: no "warning", "watch", "advisory" or "statement".
- Keep it general: broad areas (e.g. "Puget Sound", "the coast", "the Cascade passes") rather than towns, with place names capitalised exactly as in the facts, and relative timing ("this weekend", "early next week") rather than dates. Never write calendar dates.
- Use at most two numbers in total, copied exactly from the facts (e.g. "gusts to 55 mph", "about 3.6 in").
- Say "likely" or "possible" when the likelihood matters. Plain, calm, factual language; no exclamation marks, no advice.
- If little stands out, say so plainly."""

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["headline", "lede"],
          "properties": {"headline": {"type": "string"}, "lede": {"type": "string"}}}


def _numbers(s: str) -> list[float]:
    return [float(x) for x in re.findall(r"(?<![\w.])\d+(?:\.\d+)?", s.replace(",", ""))]


def check(text: dict, f: dict) -> str | None:
    """Why the model's text can't be used, or None when it can."""
    h, lede = (text.get("headline") or "").strip(), (text.get("lede") or "").strip()
    if not h or not lede:
        return "empty"
    if len(h.split()) > 12 or len(lede.split()) > 48 or len(re.findall(r"[.!?](?:\s|$)", lede)) > 2:
        return "too long"
    if re.search(r"\b(?:warning|watch|advisory|statement)s?\b", h + " " + lede, re.I):
        return "names an NWS product"
    if re.search(r"\b\d{1,2}/\d{1,2}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d", h + " " + lede):
        return "calendar date"
    allowed = set(_numbers(json.dumps(shown(f))))
    for n in _numbers(h + " " + lede):
        if n not in allowed and not any(abs(n - a) < 0.051 for a in allowed):
            return f"number {n:g} not in the facts"
    return None


def shown(f: dict) -> dict:
    """The facts as the model sees them (without the ranking scores)."""
    return {**f, "items": [{k: v for k, v in i.items() if k != "importance"} for i in f["items"]]}


def ask_model(f: dict, model: str, key: str) -> dict:
    import requests
    body = {"model": model, "temperature": 0.3,
            "messages": [{"role": "system", "content": SYSTEM},
                         {"role": "user", "content": "Facts for this briefing (JSON):\n" + json.dumps(shown(f), indent=1)}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "overview", "strict": True, "schema": SCHEMA}}}
    last = None
    for _ in range(2):
        try:
            r = requests.post(URL, json=body, headers={"Authorization": f"Bearer {key}"}, timeout=60)
            r.raise_for_status()
            return json.loads(r.json()["choices"][0]["message"]["content"])
        except Exception as e:
            last = e
    raise RuntimeError(f"OpenAI request failed: {last}")


# ---------------------------------------------------------------- rules, when there's no model

def _area_phrase(it) -> str:
    a = it.get("areas") or []
    if it.get("elevation"):
        return "the mountain passes"
    if len(it.get("regions") or []) >= 2 or len(a) > 2:
        return "much of the region"
    the = lambda z: f"the {z}" if re.search(r"coast|passes|Cascades", z) else z
    return " and ".join(the(z) for z in a) if a else "the region"


def _sentence(it) -> str:
    k = it["kind"]
    if k == "impact":
        what = {"Strong gusts": "strong winds", "Heavy rain": "heavy rain", "Multi-day rain, flood risk": "soaking multi-day rain",
                "Snow": "heavy snow", "Possible icy precipitation": "icy precipitation", "Hard freeze": "a hard freeze"}.get(it["hazard"], it["hazard"].lower())
        lik = "" if it["likelihood"] == "likely" else "a possible " if what.startswith("a ") else "possible "
        what = what[2:] if lik.startswith("a ") and what.startswith("a ") else what
        return f"{(lik + what)[0].upper()}{(lik + what)[1:]} for {_area_phrase(it)} {it['when']}"
    if k == "atmospheric river":
        w = AR_WORD[int(it['strength'][2])]
        return f"{'An' if w[0] in 'aeiou' else 'A'} {w} atmospheric river reaches the coast {it['when']}"
    if k == "snow level reaches the passes":
        return f"Snow level dropping to pass level {it['when']}"
    if k == "temperatures vs normal":
        vals = [float(v[x].rstrip("°F")) for v in it["byRegion"].values() for x in ("highs", "lows")]
        m = max(vals, key=abs)
        return f"{'Mild' if m > 0 else 'Chilly'} for the season over the next week" if abs(m) >= 5 else "Temperatures near normal over the next week"
    if k == "precipitation total":
        parts = [f"{n} about {v['total']}" + (f" ({v['percentOfNormal']} of normal)" if v.get("percentOfNormal") else "") for n, v in it["byRegion"].items()]
        return f"Over the {it['window']}, {' and '.join(parts)}"
    if k == "river flooding forecast":
        return f"Rivers forecast to reach {it['worst']}"
    if k == "wettest stretch":
        return f"The wettest stretch comes {it['when']}"
    return ""


def by_rules(f: dict) -> dict:
    items = f["items"]
    if not items or items[0]["importance"] < 1.5:
        lede = ". ".join(s for s in (_sentence(i) for i in items[:2]) if s)
        return {"headline": "A quiet stretch with nothing standing out", "lede": (lede + ".") if lede else ""}
    head = _sentence(items[0])
    rest = [s for s in (_sentence(i) for i in items[1:]) if s][:1]
    precip = next((i for i in items if i["kind"] == "precipitation total" and i["window"].endswith("7 days")), None)
    if precip and _sentence(precip) not in rest:
        rest.append(_sentence(precip))
    return {"headline": head, "lede": ". ".join(rest) + "."}


# ---------------------------------------------------------------- entry point

# proper names the overview may use, beyond the configured regions, zones and areas
PLACES = ["Western Washington", "Northwest Oregon", "Southwest BC", "southwest British Columbia", "British Columbia",
          "Washington", "Oregon", "Puget Sound", "Willamette Valley", "Columbia River Gorge", "Cascades", "Cascade",
          "Olympics", "Olympic Peninsula", "Coast Range", "Lower Mainland", "Sea to Sky", "Vancouver Island", "Portland",
          "Seattle", "Vancouver", "BC"]   # not bare "WA" or "OR": "or" is a word


def place_names(cfg: dict) -> list[str]:
    names = [r["name"] for r in (cfg.get("regions") or {}).values()]
    for p in cfg.get("points") or []:
        names += [x for x in (p.get("zone"), p.get("area")) if x]
    return list(dict.fromkeys(names + PLACES))


def fix_places(text: str, names: list[str]) -> str:
    """Write place names as they're spelled in the facts ("southwest bc" -> "Southwest BC"), and
    capitalise "southwest"/"northwest" etc. only where they're part of a name."""
    out = text
    for n in sorted(names, key=len, reverse=True):
        canon = n[0].upper() + n[1:]
        out = re.sub(rf"(?<![\w-]){re.escape(n)}(?![\w-])", canon, out, flags=re.I)
    return out


def _cap(s: str) -> str:
    """First letter upper case: the model sometimes takes "sentence case" to mean none at all."""
    return s[:1].upper() + s[1:]


def overview(data: dict, cfg: dict, demo: bool = False) -> dict:
    f = facts(data, cfg)
    sc = cfg.get("summary") or {}
    key = os.environ.get("OPENAI_API_KEY")
    if key and not demo and sc.get("enabled", True):
        model = sc.get("model", DEFAULT_MODEL)
        try:
            text = ask_model(f, model, key)
            why = check(text, f)
            if why is None:
                log.info("overview written by %s", model)
                names = place_names(cfg)
                return {"headline": _cap(fix_places(text["headline"].strip().rstrip("."), names)),
                        "lede": _cap(fix_places(text["lede"].strip(), names)),
                        "source": "openai", "model": model}
            log.warning("overview from %s not used (%s): %s", model, why, text)
        except Exception as e:
            log.warning("overview model unavailable (%s)", e)
    return {**by_rules(f), "source": "rules"}
