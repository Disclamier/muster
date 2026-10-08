#!/usr/bin/env python3
"""
Secondary source: GrimSlate (https://grimslate.com), an unofficial fan list-builder (data from BSData).
Used for detachment point (DP) costs, detachment rules and stratagems (CP cost, phase, type, text).

How the site works (Oct 2026): Next.js App Router on Vercel. Faction pages (/factions/<slug>) only
render unit points; detachment/stratagem data is not in them. However every public roster page
(/rosters/<uuid>) embeds the WHOLE faction dataset as `initialFactionData` in its React Server
Components payload (detachments with dpCost, forceDisposition, enhancements, stratagems, units...).
We therefore:
  1. read faction slugs from /sitemap.xml,
  2. find one public roster per faction via /explore?faction=<slug> (RSC payload),
  3. fetch that roster's RSC payload and pull `initialFactionData`.
robots.txt disallows /api/, /_next/ and /admin/; we touch none of those.

Usage: python3 fetch_grimslate.py [--out PATH] [--delay 1.5] [--only necrons,orks] [--mfm PATH]
"""
import argparse, datetime as dt, json, os, re, sys, time, urllib.request, urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsc import parse_rows, resolve  # noqa: E402

BASE = "https://grimslate.com"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/126.0 Safari/537.36 w40k-list-tool/1.0")


def http_get(url, headers=None, retries=4, timeout=60):
    h = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
    h.update(headers or {})
    last = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
            code = getattr(e, "code", None)
            if code and 400 <= code < 500 and code != 429:
                raise
            wait = 2 ** attempt * 2
            print(f"  ! {url}: {e} (retry {attempt+1}/{retries} in {wait}s)", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"failed to fetch {url}: {last}")


def rsc(url):
    body = http_get(url, {"RSC": "1", "Accept": "text/x-component"})
    return parse_rows(body)


def iter_dicts(x):
    stack = [x]
    while stack:
        y = stack.pop()
        if isinstance(y, dict):
            yield y
            stack.extend(y.values())
        elif isinstance(y, list):
            stack.extend(y)


def undef(v):
    return None if v == "$undefined" else v


def clean_slot(w):
    return {"slot": undef(w.get("slot")), "default": [x for x in (undef(w.get("defaultChoices")) or []) if isinstance(x, str)],
            "min_total": undef(w.get("minTotal")), "max_total": undef(w.get("maxTotal")), "optional": bool(undef(w.get("optional"))),
            "unit_level": bool(undef(w.get("unitLevel"))),
            "options": [{"name": o.get("name"), "max": undef(o.get("max")), "grants": undef(o.get("grantsWeapons")),
                         "grants_count": undef(o.get("grantsWeaponCount")), "text": undef(o.get("description")),
                         "max_at_size": undef(o.get("maxAtUnitSize"))}
                        for o in (undef(w.get("options")) or []) if isinstance(o, dict)]}


def clean_model(c):
    return {"name": c.get("name"), "min": undef(c.get("min")), "max": undef(c.get("max")),
            "fixed": [x for x in (undef(c.get("fixedWeapons")) or []) if isinstance(x, str)],
            "options": [clean_slot(w) for w in (undef(c.get("wargearOptions")) or []) if isinstance(w, dict)],
            "upgrades_from": undef(c.get("upgradesFrom")), "max_at_size": undef(c.get("maxAtUnitSize")),
            "add_on": bool(undef(c.get("isAddOn")))}


def faction_slugs():
    xml = http_get(f"{BASE}/sitemap.xml")
    return list(dict.fromkeys(re.findall(r"<loc>https://grimslate\.com/factions/([a-z0-9-]+)</loc>", xml)))


def find_rosters(slug):
    rows = rsc(f"{BASE}/explore?faction={slug}")
    out = []
    for v in rows.values():
        for d in iter_dicts(v):
            if d.get("factionId") == slug and isinstance(d.get("id"), str) and \
                    re.fullmatch(r"[0-9a-f-]{36}", d["id"]) and "pointsLimit" in d:
                out.append(d)
    out.sort(key=lambda d: (d.get("edition") != "11th", -(d.get("unitCount") or 0)))
    return list({d["id"]: d for d in out}.values())


def faction_data_from_roster(rid):
    rows = rsc(f"{BASE}/rosters/{rid}")
    for k, v in rows.items():
        if isinstance(v, (list, dict)) and "initialFactionData" in json.dumps(v)[:2_000_000]:
            for d in iter_dicts(resolve(rows, v)):
                if isinstance(d.get("initialFactionData"), dict):
                    return d["initialFactionData"]
    return None


def clean_faction(slug, fd, roster_id):
    dets = []
    for d in fd.get("detachments") or []:
        rule = d.get("rule") or {}
        dets.append({
            "id": d.get("id"),
            "name": d.get("name"),
            "detachment_points": undef(d.get("dpCost")),
            "force_disposition": undef(d.get("forceDisposition")),
            "unique_tag": undef(d.get("uniqueTag")),
            "rule": {"name": undef(rule.get("name")), "text": undef(rule.get("description"))} if rule else None,
            "enhancements": [{"name": e.get("name"), "points": undef(e.get("points")),
                              "is_upgrade": bool(e.get("isUpgrade")), "text": undef(e.get("description"))}
                             for e in d.get("enhancements") or []],
            "stratagems": [{"name": s.get("name"), "cp": undef(s.get("cpCost")), "phase": undef(s.get("phase")) or None,
                            "turn": undef(s.get("turn")) or None, "type": undef(s.get("type")) or None,
                            "text": undef(s.get("description"))}
                           for s in d.get("stratagems") or []],
        })
    units = [{"name": u.get("name"),
              "keywords": [k for k in (u.get("keywords") or []) if isinstance(k, str)],
              "faction_keyword": undef(u.get("factionKeyword")),
              "costs": [{"models": p.get("models"), "points": p.get("points"),
                         **({"composition": undef(p.get("composition"))} if undef(p.get("composition")) else {})}
                        for p in u.get("pointsOptions") or []],
              # unit composition + wargear options (used for loadouts only; points always come from MFM)
              "composition": [clean_model(c) for c in u.get("composition") or [] if isinstance(c, dict)],
              "unit_wargear_options": [clean_slot(w) for w in u.get("wargearOptions") or [] if isinstance(w, dict)],
              "model_constraints": undef(u.get("compositionConstraints")),
              "wargear_costs": [{"item": w.get("item"), "points": undef(w.get("points")), "match_names": undef(w.get("matchNames")) or []}
                                for w in u.get("wargearCosts") or [] if isinstance(w, dict)]}
             for u in fd.get("units") or []]
    return {"id": slug, "name": fd.get("factionName"), "grimslate_faction_id": fd.get("factionId"),
            "catalogue_id": fd.get("catalogueId"), "schema_version": fd.get("schemaVersion"),
            "source_roster": f"{BASE}/rosters/{roster_id}", "url": f"{BASE}/factions/{slug}",
            "detachments": dets, "units": units}


# MFM slug -> GrimSlate slug where they differ
SLUG_MAP = {"tau-empire": "t-au-empire", "emperors-children": "emperor-s-children",
            "imperial-agents": "agents-of-the-imperium"}


def norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower().replace("’", "'"))


def compare_with_mfm(gs, mfm_path):
    """Compare detachment points and enhancement points against MFM (MFM is authoritative)."""
    try:
        mfm = json.load(open(mfm_path))
    except Exception as e:
        return {"error": f"could not read {mfm_path}: {e}"}
    gsf = {f["id"]: f for f in gs["factions"]}
    report = {"dp_disagreements": [], "dp_filled_from_grimslate": [], "enhancement_disagreements": [],
              "detachments_missing_in_grimslate": [], "detachments_only_in_grimslate": []}
    for mf in mfm["factions"]:
        g = gsf.get(SLUG_MAP.get(mf["id"], mf["id"]))
        if not g:
            continue
        gd = {norm(d["name"]): d for d in g["detachments"]}
        for md in mf.get("detachments", []):
            d = gd.get(norm(md["name"]))
            if not d:
                report["detachments_missing_in_grimslate"].append(f'{mf["id"]}: {md["name"]}')
                continue
            if md.get("detachment_points") is None and d["detachment_points"] is not None:
                report["dp_filled_from_grimslate"].append(
                    {"faction": mf["id"], "detachment": md["name"], "grimslate_dp": d["detachment_points"]})
            elif d["detachment_points"] != md.get("detachment_points"):
                report["dp_disagreements"].append({"faction": mf["id"], "detachment": md["name"],
                                                   "mfm_dp": md.get("detachment_points"),
                                                   "grimslate_dp": d["detachment_points"]})
            ge = {norm(e["name"]): e for e in d["enhancements"]}
            for me in md["enhancements"]:
                e = ge.get(norm(me["name"]))
                if e and e["points"] != me["points"]:
                    report["enhancement_disagreements"].append(
                        {"faction": mf["id"], "detachment": md["name"], "enhancement": me["name"],
                         "mfm_points": me["points"], "grimslate_points": e["points"]})
        mnames = {norm(d["name"]) for d in mf.get("detachments", [])}
        for d in g["detachments"]:
            if norm(d["name"]) not in mnames:
                report["detachments_only_in_grimslate"].append(
                    f'{mf["id"]}: {d["name"]} (dp={d["detachment_points"]})')
    return report


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(here, "..", "data", "grimslate.json"))
    ap.add_argument("--mfm", default=os.path.join(here, "..", "data", "mfm.json"))
    ap.add_argument("--delay", type=float, default=1.5)
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    t0 = time.time()
    slugs = faction_slugs()
    if a.only:
        slugs = [s for s in slugs if s in a.only.split(",")]
    print(f"{len(slugs)} GrimSlate factions", file=sys.stderr)
    res = {"source": BASE, "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
           "factions": [], "errors": []}
    for slug in slugs:
        try:
            time.sleep(a.delay)
            rosters = find_rosters(slug)
            if not rosters:
                raise RuntimeError("no public roster found on /explore for this faction")
            fd = None
            for r in rosters[:3]:
                time.sleep(a.delay)
                fd = faction_data_from_roster(r["id"])
                if fd and fd.get("factionId") == slug:
                    break
                fd = None
            if not fd:
                raise RuntimeError("no initialFactionData in first 3 rosters")
            f = clean_faction(slug, fd, r["id"])
            res["factions"].append(f)
            ns = sum(len(d["stratagems"]) for d in f["detachments"])
            print(f"  {slug:24s} detachments={len(f['detachments']):3d} stratagems={ns:3d} units={len(f['units']):3d}",
                  file=sys.stderr)
        except Exception as e:
            print(f"  ! {slug}: {e}", file=sys.stderr)
            res["errors"].append({"faction": slug, "error": str(e)})
    res["comparison_with_mfm"] = compare_with_mfm(res, a.mfm)
    res["elapsed_seconds"] = round(time.time() - t0, 1)
    out = os.path.abspath(a.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out + ".tmp", "w", encoding="utf-8") as fh:
        json.dump(res, fh, ensure_ascii=False, indent=1)
    os.replace(out + ".tmp", out)
    c = res["comparison_with_mfm"]
    print(f"wrote {out}: {len(res['factions'])} factions, errors={len(res['errors'])}, "
          f"{res['elapsed_seconds']}s; DP disagreements={len(c.get('dp_disagreements', []))}, "
          f"enh disagreements={len(c.get('enhancement_disagreements', []))}", file=sys.stderr)


if __name__ == "__main__":
    main()
