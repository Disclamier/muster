#!/usr/bin/env python3
"""Fetch 40K meta win rates from listhammer.info -> data/winrates.json.

How listhammer serves data: Nuxt 3 SSR (Cloudflare). Every page embeds its data in
<script id="__NUXT_DATA__"> (devalue format, decoded by scraper/nuxt.py). robots.txt (re-read on
every run and enforced for every request) disallows /api/, /players/, /events/, /list/ -- so we ONLY
read the allowed, server-rendered HTML pages. Their SSR honours two query parameters:
  /stats[?range=4weeks|dataslate][&includeRtt=true]
        faction table, events list, disposition win rates + disposition-vs-disposition matchups,
        for each time window ("This Weekend", "Last 4 Weeks", "Since Dataslate (..)") with and
        without RTTs (RTT mode widens the criteria to 3+ rounds / 8+ players).
  /factions/<slug>[?includeRtt=true]
        per-faction headline, weekly trend, matchups, detachment combinations, dispositions and the
        first page of recent undefeated / X-1 lists (with list text) -- with and without RTTs.
        SSR is always "This Weekend": the page's range switch (4 weeks / dataslate / codex) calls
        /api/factions/..., which robots.txt disallows, so those breakdowns are NOT fetched.
Rules-update dates (dataslates / codexes, used for trend markers) are read best-effort from the
site's public static JS bundle (/_nuxt/*.js, allowed).
"""
import argparse, datetime as dt, json, os, re, sys, time, urllib.request, urllib.robotparser, html as htmlmod

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nuxt import nuxt_data  # noqa: E402

BASE = "https://listhammer.info"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/126.0 Safari/537.36 MusterPersonalApp/1.0")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATE_RE = re.compile(r"(\d{1,2} [A-Z][a-z]{2}(?: \d{4})? - \d{1,2} [A-Z][a-z]{2} \d{4})")
SM_CHAPTERS = {"blood-angels", "dark-angels", "space-wolves", "black-templars", "deathwatch"}
NAME_TO_MFM = {"genestealer cult": "genestealer-cults", "space marines (astartes)": "space-marines"}


def http_get(url, retries=4, timeout=30):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html",
                                                       "Accept-Language": "en-US,en;q=0.9"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"GET {url} failed: {last}")


def norm(s):
    s = (s or "").replace("’", "'").replace("‘", "'").lower()
    return re.sub(r"[^a-z0-9]+", "", s)


def slugify(name):
    s = re.sub(r"\s*\(.*?\)", "", name or "")
    s = s.replace("’", "").replace("'", "").lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def page_data(html):
    d = nuxt_data(html)
    if not d:
        raise RuntimeError("no __NUXT_DATA__")
    return d.get("data") or {}


def page_range(html, default_label):
    txt = htmlmod.unescape(re.sub(r"<(script|style).*?</\1>", " ", html, flags=re.S))
    txt = re.sub(r"<[^>]+>", " ", txt)
    m = DATE_RE.search(txt)
    return {"label": default_label, "dates": m.group(1) if m else None}


def pct(s):
    try:
        return round(float(s), 2)
    except (TypeError, ValueError):
        return None


def load_mfm_index():
    """mfm faction ids by normalised name, and detachments per faction (MFM + GrimSlate)."""
    fac, dets = {}, {}
    try:
        m = json.load(open(os.path.join(ROOT, "data", "mfm.json")))
        for f in m["factions"]:
            fac[norm(f["name"])] = f["id"]
            for d in f.get("detachments", []):
                dets.setdefault(f["id"], {})[norm(d["name"])] = (d["name"], "mfm")
    except Exception as e:  # noqa: BLE001
        print("warn: mfm.json not loaded:", e, file=sys.stderr)
    try:
        g = json.load(open(os.path.join(ROOT, "data", "grimslate.json")))
        for f in g["factions"]:
            fid = f.get("mfm_id") or f.get("id") or slugify(f.get("name"))
            for d in f.get("detachments", []):
                dets.setdefault(fid, {}).setdefault(norm(d["name"]), (d["name"], "gs"))
    except Exception as e:  # noqa: BLE001
        print("warn: grimslate.json not loaded:", e, file=sys.stderr)
    return fac, dets


def match_det(name, fid, dets):
    pools = [fid] + (["space-marines"] if fid in SM_CHAPTERS else [])
    k = norm(name)
    for p in pools:
        hit = dets.get(p, {}).get(k)
        if hit:
            return {"faction": p, "name": hit[0], "src": hit[1]}
    for p, pool in dets.items():  # last resort: anywhere
        if k in pool:
            return {"faction": p, "name": pool[k][0], "src": pool[k][1]}
    return None


def stats_table(data):
    for v in data.values():
        if isinstance(v, dict) and isinstance(v.get("result"), list) and "recentEvents" in v:
            return v["result"], v.get("recentEvents") or []
    for v in data.values():
        if isinstance(v, dict) and isinstance(v.get("result"), list):
            return v["result"], []
    return [], []


def stats_dispositions(data):
    for v in data.values():
        if isinstance(v, dict) and "overall" in v and "matchups" in v and isinstance(v["overall"], list):
            return v
    return {}


def faction_row(r):
    return {"name": r["faction"], "win_rate": pct(r.get("winRate")), "games": r.get("total"),
            "wins": r.get("wins"), "losses": r.get("losses"), "players": r.get("players"),
            "x0": r.get("undefeated"), "x1": r.get("xMinus1"), "top4": r.get("top4"),
            "event_wins": r.get("eventWins"), "overrep": pct(r.get("overrep"))}


def rnd1(v):
    return None if v is None else round(v, 1)


def gofirst(g):
    g = g or {}
    return {"win_rate": pct(g.get("winRate")), "games": g.get("total"), "wins": g.get("wins"),
            "losses": g.get("losses"), "avg_diff": rnd1(g.get("avgDifferential"))}


def page_text(html):
    txt = htmlmod.unescape(re.sub(r"<(script|style).*?</\1>", " ", html, flags=re.S))
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", txt))


def stats_dataset(html, key, rtt):
    """One /stats view -> {label, dates, criteria, table, events, dispositions}."""
    data = page_data(html)
    txt = page_text(html)
    m = re.search(r"(This Weekend|Last 4 Weeks|Since [A-Za-z]+ \([^)]{1,30}\)) Meta Breakdown", txt)
    label = m.group(1).strip() if m else None
    dm = DATE_RE.search(txt)
    crit = re.search(r"(Stats are compiled from [^.]+\.)", txt)
    rows, events = stats_table(data)
    dp = stats_dispositions(data)
    return {
        "key": key, "range": key.replace("_rtt", ""), "include_rtt": rtt, "label": label,
        "dates": dm.group(1) if dm else None, "criteria": crit.group(1) if crit else None,
        "table": [faction_row(r) for r in rows],
        "events": [{"name": e.get("name"), "country": e.get("country"), "state": e.get("state"),
                    "players": e.get("players"), "in_progress": bool(e.get("started") and not e.get("ended"))}
                   for e in events],
        "event_count": len(events), "event_players": sum(e.get("players") or 0 for e in events),
        "dispositions": [{"name": r["disposition"], "win_rate": pct(r.get("winRate")), "games": r.get("total"),
                          "wins": r.get("wins"), "losses": r.get("losses"), "players": r.get("players")}
                         for r in dp.get("overall") or []],
        "disposition_matchups": [{"name": r["disposition"], "opponent": r["opponentDisposition"],
                                  "win_rate": pct(r.get("winRate")), "games": r.get("total"), "wins": r.get("wins"),
                                  "losses": r.get("losses"), "avg_diff": rnd1(r.get("avgDifferential")),
                                  "go_first": gofirst(r.get("goingFirst"))}
                                 for r in dp.get("matchups") or []],
    }


def faction_detail(html, fid, det_idx, fac_idx):
    """One /factions/<slug> view -> detail dict (+ recent lists)."""
    data = page_data(html)
    fd = next(v for v in data.values() if isinstance(v, dict) and "matchups" in v and "headline" in v)
    rl = next((v for k, v in data.items() if str(k).startswith("recentLists") and isinstance(v, dict)), {}) or {}
    txt = page_text(html)
    cm = re.search(r"(Compiled from \d+ [^.]+\.)", txt)
    hl = fd.get("headline") or {}
    ov = fd.get("overall") or {}
    rec = {"win_rate": pct(hl.get("winRate")), "games": hl.get("total"), "wins": hl.get("wins"),
           "losses": hl.get("losses"), "players": fd.get("players"), "x0": fd.get("undefeated"),
           "x1": fd.get("xMinus1"), "event_wins": fd.get("eventWins"), "event_count": fd.get("eventCount"),
           "overrep": pct(fd.get("overrep")), "criteria": cm.group(1) if cm else None,
           "overall_6mo": {"win_rate": pct(ov.get("winRate")), "games": ov.get("total"),
                           "wins": ov.get("wins"), "losses": ov.get("losses")},
           "weekly": [{"week": w["week"], "win_rate": pct(w.get("winRate")), "games": w.get("total"),
                       "wins": w.get("wins"), "losses": w.get("losses")} for w in fd.get("weekly") or []]}
    combos, single = [], {}
    for c in fd.get("detachmentCombinations") or []:
        parts = [p.strip() for p in c["detachment"].split("|")]
        m = [match_det(p, fid, det_idx) if p != "Unknown" else None for p in parts]
        combos.append({"name": c["detachment"], "parts": parts, "win_rate": pct(c.get("winRate")),
                       "games": c.get("total"), "wins": c.get("wins"), "losses": c.get("losses"),
                       "players": c.get("players"), "field_pct": round(c.get("fieldPercent") or 0, 1), "mfm": m})
        for p, mm in zip(parts, m):
            s = single.setdefault(p, {"name": p, "wins": 0, "losses": 0, "games": 0, "mfm": mm})
            s["wins"] += c.get("wins") or 0; s["losses"] += c.get("losses") or 0; s["games"] += c.get("total") or 0
    usage = fd.get("detachments") or {}
    for p, s in single.items():
        s["win_rate"] = round(100 * s["wins"] / s["games"], 2) if s["games"] else None
        s["players"] = usage.get(p)
    for p, n in usage.items():
        if p not in single:
            single[p] = {"name": p, "wins": 0, "losses": 0, "games": 0, "win_rate": None,
                         "players": n, "mfm": match_det(p, fid, det_idx)}
    rec["detachments"] = combos
    rec["detachments_single"] = sorted(single.values(), key=lambda s: -(s["games"] or 0))
    known = sum(c.get("players") or 0 for c in combos if c["name"] != "Unknown")
    rec["no_detachment_players"] = max(0, (rec["players"] or 0) - known)
    rec["matchups"] = []
    for mu in fd.get("matchups") or []:
        rec["matchups"].append({
            "opponent": mu["opponentFaction"],
            "opponent_mfm_id": fac_idx.get(norm(mu["opponentFaction"])) or NAME_TO_MFM.get(mu["opponentFaction"].lower()),
            "opponent_slug": slugify(mu["opponentFaction"]),
            "win_rate": pct(mu.get("winRate")), "games": mu.get("total"),
            "wins": mu.get("wins"), "losses": mu.get("losses"),
            "avg_diff": rnd1(mu.get("avgDifferential")), "go_first": gofirst(mu.get("goingFirst"))})
    rec["dispositions"] = fd.get("dispositions") or {}
    rec["detachment_names"] = fd.get("detachmentNames") or []
    lists = [{"player": x.get("playerName"), "event": x.get("eventName"), "event_players": x.get("numberOfPlayers"),
              "rounds": x.get("numberOfRounds"), "w": x.get("wins"), "d": x.get("draws"), "l": x.get("losses"),
              "detachment": x.get("detachment"), "disposition": x.get("disposition"), "date": x.get("startDate"),
              "rtt": bool(x.get("isRtt")), "text": x.get("listText") or ""}
             for x in rl.get("result") or []]
    return rec, {"lists": lists, "total": rl.get("totalCount")}


def rules_updates(get, html):
    """Best-effort: dataslate / codex dates from the public JS bundle (allowed static asset)."""
    for src in dict.fromkeys(re.findall(r'/_nuxt/[A-Za-z0-9_-]+\.js', html)):
        try:
            js = get(src, delay=0.3)
        except Exception:  # noqa: BLE001
            continue
        if 'kind:"dataslate"' not in js:
            continue
        out = []
        for m in re.finditer(r'\{date:"(\d{4}-\d\d-\d\d)",kind:"(\w+)",game:"40k"([^{}]*)\}', js):
            lab = re.search(r'label:"([^"]+)"', m.group(3))
            facs = re.search(r'factions:\[([^\]]*)\]', m.group(3))
            out.append({"date": m.group(1), "kind": m.group(2), "label": lab.group(1) if lab else None,
                        "factions": re.findall(r'"([^"]+)"', facs.group(1)) if facs else None})
        return sorted(out, key=lambda x: x["date"])
    return []


STATS_VIEWS = [("weekend", False, "/stats"), ("weekend_rtt", True, "/stats?includeRtt=true"),
               ("4weeks", False, "/stats?range=4weeks"), ("4weeks_rtt", True, "/stats?range=4weeks&includeRtt=true"),
               ("dataslate", False, "/stats?range=dataslate"),
               ("dataslate_rtt", True, "/stats?range=dataslate&includeRtt=true")]
EXPECTED_LABEL = {"weekend": "This Weekend", "4weeks": "Last 4 Weeks", "dataslate": "Since"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "winrates.json"))
    ap.add_argument("--delay", type=float, default=1.5)
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--no-rtt", action="store_true", help="skip the Include-RTTs views (faster test runs)")
    a = ap.parse_args()

    rp = urllib.robotparser.RobotFileParser()
    rp.parse(http_get(BASE + "/robots.txt").splitlines())

    def get(path, delay=None):
        if not rp.can_fetch(UA, BASE + path) or not rp.can_fetch("*", BASE + path):
            raise RuntimeError(f"robots.txt disallows {path}")
        time.sleep(a.delay if delay is None else delay)
        return http_get(BASE + path)

    fac_idx, det_idx = load_mfm_index()
    errors = []
    t0 = time.time()

    datasets, first_html = {}, None
    for key, rtt, path in STATS_VIEWS:
        if rtt and a.no_rtt:
            continue
        try:
            h = get(path)
            first_html = first_html or h
            ds = stats_dataset(h, key, rtt)
            exp = EXPECTED_LABEL[ds["range"]]
            if not ds["table"]:
                raise RuntimeError("empty faction table")
            if not (ds["label"] or "").startswith(exp):  # e.g. no recent dataslate -> site falls back to This Weekend
                print(f"  skip {key}: page shows '{ds['label']}'", file=sys.stderr)
                continue
            datasets[key] = ds
            print(f"  stats {key}: {ds['label']} {ds['dates']}, {len(ds['table'])} factions, {ds['event_count']} events",
                  file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            errors.append(f"stats {key}: {e}")
            print("!! stats", key, e, file=sys.stderr)
    if "weekend" not in datasets:
        raise RuntimeError("default /stats view failed")

    def table(key):
        return {r["name"]: r for r in (datasets.get(key) or {}).get("table", [])}
    table_week, table_4w = table("weekend"), table("4weeks")
    names = sorted(set(table_week) | set(table_4w))

    factions, lists_out = [], {}
    for name in names:
        slug = slugify(name)
        if a.only and slug not in a.only:
            continue
        fid = fac_idx.get(norm(name)) or NAME_TO_MFM.get(name.lower()) or (slug if slug in det_idx else None)
        rec = dict(table_week.get(name) or {"name": name, "win_rate": None, "games": 0})
        rec.update({"slug": slug, "url": f"{BASE}/factions/{slug}", "mfm_id": fid,
                    "last_4_weeks": {k: v for k, v in (table_4w.get(name) or {}).items() if k != "name"} or None})
        lists_out[slug] = {"name": name}
        try:
            det, rl = faction_detail(get(f"/factions/{slug}"), fid, det_idx, fac_idx)
            rec.update({k: (v if v is not None else rec.get(k)) for k, v in det.items()})
            lists_out[slug]["std"] = rl
        except Exception as e:  # noqa: BLE001
            errors.append(f"{slug}: {e}")
            rec.setdefault("detachments", []); rec.setdefault("matchups", [])
            print("!!", slug, e, file=sys.stderr)
        if not a.no_rtt:
            try:
                det, rl = faction_detail(get(f"/factions/{slug}?includeRtt=true"), fid, det_idx, fac_idx)
                rec["rtt"] = det
                lists_out[slug]["rtt"] = rl
            except Exception as e:  # noqa: BLE001
                errors.append(f"{slug} (RTT): {e}")
                print("!!", slug, "RTT", e, file=sys.stderr)
        factions.append(rec)
        print(f"  {name}: {rec.get('win_rate')}% / {rec.get('games')} games, "
              f"{len(rec.get('detachments', []))} det combos, {len(rec.get('matchups', []))} matchups"
              + (f"; RTT {rec['rtt'].get('win_rate')}% / {rec['rtt'].get('games')} games" if rec.get("rtt") else ""),
              file=sys.stderr)

    updates = []
    try:
        updates = rules_updates(get, first_html or "")
    except Exception as e:  # noqa: BLE001
        print("warn: rules-update dates not found:", e, file=sys.stderr)

    rng = {k: {"label": d["label"], "dates": d["dates"]} for k, d in datasets.items()}
    out = {
        "schema": 2,
        "source": "Listhammer (listhammer.info) - unofficial community tournament stats",
        "source_url": BASE + "/stats",
        "date_range": rng["weekend"],
        "ranges": rng,
        "datasets": datasets,
        "rules_updates": updates,
        "notes": ("Faction pages (detachments, matchups, dispositions, recent lists) are server-rendered for "
                  "'This Weekend' only (with or without RTTs); listhammer's 4-week / since-dataslate / since-codex "
                  "versions of those breakdowns come from /api/, which robots.txt disallows. The faction table, "
                  "events and disposition stats are provided for every window, with and without RTTs. "
                  "detachments_single win rates are derived by summing every detachment combination that "
                  "includes the detachment."),
        "fetched_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "elapsed_s": round(time.time() - t0, 1),
        "dispositions_4weeks": (datasets.get("4weeks") or {}).get("dispositions", []),
        "factions": factions,
        "recent_lists": lists_out,
        "errors": errors,
    }
    tmp = a.out + ".tmp"
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(tmp, "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    os.replace(tmp, a.out)
    unmatched = sorted({p for f in factions for s in f.get("detachments_single", []) if not s.get("mfm") and s["name"] != "Unknown"
                        for p in [f"{f['name']}: {s['name']}"]})
    print(f"wrote {a.out}: {len(factions)} factions, datasets {list(datasets)}, errors={len(errors)}, "
          f"{out['elapsed_s']}s; {len(updates)} rules updates; unmatched detachments {len(unmatched)}: {unmatched}",
          file=sys.stderr)
    return 0 if len(factions) - len([e for e in errors if not e.startswith("stats")]) >= 20 else 1


if __name__ == "__main__":
    sys.exit(main())
