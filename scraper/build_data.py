#!/usr/bin/env python3
"""
Merge data/mfm.json (PRIMARY, legal source) with data/grimslate.json (stratagems, detachment rule text,
enhancement text, unit keywords for battlefield roles) into the compact app/data/points.json
plus app/data/version.json.

points.json schema (compact keys):
{ v, fetched_at, mfm_version, gs_fetched_at, hash,
  battle_sizes: [{id, name, points, dp, enh, unit_limit, single3dp?}],
  rules_text: [...MFM 'Muster Armies' lines...],
  groups: [{name, factions:[{id, name, data}]}],          # Create-List picker tree (data = faction id holding points)
  factions: [{ id, name, url,
     units: [{ n: name, r: role, lg?: 1 (Legends), kw: [keywords], sg?: source group,
               t: [[from_unit, to_unit|null, [[models|null, points, label?], ...]], ...],   # cost tiers
               w?: [[wargear, points_per_item]], ch?: "up"|"down"|"mixed", ldr?: [...], sup?: [...], upd?: [...] }],
     dets: [{ n, dp, src: "mfm"|"gs", fd: [force dispositions], rs?: [restrictions], sup?: [...], chg?: [...],
              rule?: [name, text], enh: [[name, points, text|null, isUpgrade(0/1)]],
              st: [[name, cp, phase, type, turn, text]] }] }] }
"""
import argparse, datetime as dt, hashlib, json, os, re, sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))

SLUG_MAP = {"tau-empire": "t-au-empire", "emperors-children": "emperor-s-children",
            "imperial-agents": "agents-of-the-imperium"}

GROUPS = [
    ("Chaos", ["chaos-daemons", "chaos-knights", "chaos-space-marines", "chaos-titan-legions", "death-guard",
               "emperors-children", "thousand-sons", "world-eaters"]),
    ("Imperium", ["adepta-sororitas", "adeptus-custodes", "adeptus-mechanicus", "astra-militarum", "grey-knights",
                  "imperial-agents", "imperial-knights", "titan-legions"]),
    ("Imperium - Adeptus Astartes", ["black-templars", "blood-angels", "dark-angels", "deathwatch",
                                     "imperial-fists@space-marines", "iron-hands@space-marines",
                                     "raven-guard@space-marines", "salamanders@space-marines", "space-marines",
                                     "space-wolves", "ultramarines@space-marines", "white-scars@space-marines"]),
    ("Xenos", ["aeldari", "drukhari", "genestealer-cults", "leagues-of-votann", "necrons", "orks", "tau-empire",
               "tyranids"]),
]

ROLE_ORDER = ["Epic Hero", "Character", "Battleline", "Dedicated Transport", "Infantry", "Mounted", "Beast",
              "Swarm", "Monster", "Vehicle", "Fortification", "Other"]


def norm(s):
    s = (s or "").lower().replace("’", "'").replace("‘", "'")
    s = re.sub(r"\[legends\]|\(legends\)", "", s)
    return re.sub(r"[^a-z0-9]", "", s)


def title_name(s):
    """MFM names are upper case; GrimSlate has proper case. Fallback: smart title-case."""
    t = s.title()
    t = re.sub(r"'S\b", "'s", t).replace("’S", "’s")
    for w in ["Of", "The", "And", "In", "With", "On", "To", "A"]:
        t = re.sub(rf"(?<=\s){w}(?=\s)", w.lower(), t)
    return t


def role_from_keywords(kws, name, leader_of):
    k = {x.lower() for x in kws or []}
    if "epic hero" in k:
        return "Epic Hero"
    if "character" in k:
        return "Character"
    if "battleline" in k:
        return "Battleline"
    if "dedicated transport" in k:
        return "Dedicated Transport"
    if "fortification" in k:
        return "Fortification"
    for r in ["Vehicle", "Monster", "Mounted", "Beast", "Swarm", "Infantry"]:
        if r.lower() in k:
            return r
    if "aircraft" in k or "walker" in k or "titanic" in k:
        return "Vehicle"
    if leader_of:
        return "Character"
    if re.search(r"titan|tank|sicaran|grinder|vyper|atv|pylon|battery|hauler|walker|speeder|bike|knight", name, re.I):
        return "Vehicle"
    return "Other"


def compile_slot(sl, wnames):
    """[name, opts[[name, max, text, wIdx, maxAtSize]], defaults, minTotal, maxTotal, optional]"""
    opts = []
    for o in sl.get("options") or []:
        if not o.get("name"):
            continue
        keys = [norm(o["name"])] + [norm(g) for g in (o.get("grants") or [])]
        widx = next((i for i, wn in enumerate(wnames) if wn in keys), None)
        mas = [[m.get("unitSize"), m.get("max")] for m in (o.get("max_at_size") or []) if isinstance(m, dict)] or None
        opts.append([o["name"], o.get("max"), (o.get("text") or None), widx, mas])
    if not opts:
        return None
    return [sl.get("slot") or "Options", opts, sl.get("default") or [], sl.get("min_total"), sl.get("max_total"),
            1 if sl.get("optional") else 0]


def compile_loadout(gu, wargear_costs):
    """GrimSlate composition/wargear options -> compact loadout model (points stay MFM-only)."""
    comp = (gu or {}).get("composition") or []
    if not comp:
        return None
    wnames = []
    for w in wargear_costs or []:
        wn = {norm(w["name"])}
        for gw in (gu.get("wargear_costs") or []):
            if norm(gw.get("item")) == norm(w["name"]):
                wn |= {norm(x) for x in gw.get("match_names") or []}
        wnames.append(wn)
    wflat = [w for w in wnames]

    def widx_slot(sl):
        res = compile_slot(sl, [])
        if not res:
            return None
        for o, src in zip(res[1], [x for x in sl.get("options") or [] if x.get("name")]):
            keys = {norm(src["name"])} | {norm(g) for g in (src.get("grants") or [])}
            o[3] = next((i for i, wn in enumerate(wflat) if wn & keys), None)
        return res

    models = []
    for c in comp:
        if not c.get("name"):
            continue
        mas = [[m.get("unitSize"), m.get("max")] for m in (c.get("max_at_size") or []) if isinstance(m, dict)] or None
        models.append([c["name"], c.get("min") or 0, c.get("max") if c.get("max") is not None else (c.get("min") or 1),
                       c.get("fixed") or [], [x for x in (widx_slot(sl) for sl in c.get("options") or []) if x],
                       c.get("upgrades_from"), mas, 1 if c.get("add_on") else 0])
    unit_slots = [x for x in (widx_slot(sl) for sl in gu.get("unit_wargear_options") or []) if x]
    mc = gu.get("model_constraints") or {}
    lo = {"m": models}
    if unit_slots:
        lo["u"] = unit_slots
    if mc.get("minModels") is not None:
        lo["mn"] = mc.get("minModels")
    if mc.get("maxModels") is not None:
        lo["mx"] = mc.get("maxModels")
    return lo


def merge(mfm, gs):
    gsf = {f["id"]: f for f in gs.get("factions", [])}
    # global indexes for fallbacks (e.g. Space Marines units on chapter pages)
    g_units, g_dets = {}, {}
    for f in gs.get("factions", []):
        for u in f["units"]:
            g_units.setdefault(norm(u["name"]), u)
        for d in f["detachments"]:
            cur = g_dets.get(norm(d["name"]))
            if cur is None or (not cur["stratagems"] and d["stratagems"]):
                g_dets[norm(d["name"])] = d
    stats = Counter()
    unmatched_dets, out_factions = [], []
    for mf in mfm["factions"]:
        gf = gsf.get(SLUG_MAP.get(mf["id"], mf["id"]))
        fu = {}
        if gf:
            for u in gf["units"]:
                fu.setdefault(norm(u["name"]), u)
        units = []
        for u in mf["units"]:
            gu = fu.get(norm(u["name"])) or g_units.get(norm(u["name"]))
            stats["units"] += 1
            stats["units_with_keywords"] += bool(gu)
            kws = (gu or {}).get("keywords") or []
            name = (gu or {}).get("name") or title_name(u["name"])
            name = re.sub(r"\s*\[Legends\]\s*$", "", name)
            cu = {"n": name, "r": role_from_keywords(kws, name, u.get("leader_of")), "kw": kws,
                  "t": [[t["from_unit"], t["to_unit"],
                         [[c["models"], c["points"]] + ([c["label"]] if c.get("label") else []) for c in t["costs"]]]
                        for t in u["cost_tiers"]]}
            if u.get("legends"):
                cu["lg"] = 1
            if u.get("source_group") and norm(u["source_group"]) != norm(mf["name"]):
                cu["sg"] = title_name(u["source_group"])
            if u.get("wargear_costs"):
                cu["w"] = [[w["name"], w["points"]] for w in u["wargear_costs"]]
            if u.get("points_change"):
                ups = any((c.get("change") or 0) > 0 for t in u["cost_tiers"] for c in t["costs"])
                downs = any((c.get("change") or 0) < 0 for t in u["cost_tiers"] for c in t["costs"])
                cu["ch"] = "mixed" if ups and downs else ("up" if ups else "down" if downs else
                                                           ("up" if u["points_change"] == "increased" else "down"))
            deltas = [[c.get("label") or (f"{c['models']} model" + ("s" if c["models"] != 1 else "") if c.get("models") else ""), c["change"]]
                      for c in (u["cost_tiers"][0]["costs"] if u["cost_tiers"] else []) if c.get("change")]
            if deltas:
                cu["chd"] = deltas
            lo = compile_loadout(gu, u.get("wargear_costs"))
            if lo:
                cu["lo"] = lo
                stats["units_with_loadout"] += 1
                stats["loadout_options"] += sum(len(sl[1]) for m in lo["m"] for sl in m[4]) + sum(len(sl[1]) for sl in lo.get("u", []))
                stats["wargear_linked"] += len({o[3] for m in lo["m"] for sl in m[4] for o in sl[1] if o[3] is not None} |
                                               {o[3] for sl in lo.get("u", []) for o in sl[1] if o[3] is not None})
            stats["wargear_priced"] += len(u.get("wargear_costs") or [])
            if u.get("leader_of"):
                cu["ldr"] = u["leader_of"]
            if u.get("support_for"):
                cu["sup"] = u["support_for"]
            if u.get("changes"):
                cu["upd"] = u["changes"]
            units.append(cu)
        # display names must be unique per faction (lists reference units by name). Example: Space Wolves has a
        # current "Venerable Dreadnought" (130/140) and a Legends one (165) -> the Legends copy becomes "... [Legends]".
        seen_names = Counter(x["n"] for x in units)
        for x in units:
            if seen_names[x["n"]] > 1 and x.get("lg"):
                x["n"] = f'{x["n"]} [Legends]'
                stats["renamed_duplicate_units"] += 1
        seen_names = Counter()
        for x in units:
            seen_names[x["n"]] += 1
            if seen_names[x["n"]] > 1:
                x["n"] = f'{x["n"]} ({seen_names[x["n"]]})'
                stats["renamed_duplicate_units"] += 1
        units.sort(key=lambda x: (ROLE_ORDER.index(x["r"]) if x["r"] in ROLE_ORDER else 99, x["n"].lower()))

        gdets = {norm(d["name"]): d for d in (gf or {}).get("detachments", [])}
        dets, seen = [], set()
        for md in mf.get("detachments", []):
            stats["detachments"] += 1
            gd = gdets.get(norm(md["name"])) or g_dets.get(norm(md["name"]))
            if gd and not gd["stratagems"] and g_dets.get(norm(md["name"]), {}).get("stratagems"):
                gd = {**gd, "stratagems": g_dets[norm(md["name"])]["stratagems"]}
            ge = {norm(e["name"]): e for e in (gd or {}).get("enhancements", [])}
            if gd:
                stats["detachments_matched"] += 1
                stats["detachments_with_stratagems"] += bool(gd["stratagems"])
            else:
                unmatched_dets.append(f'{mf["id"]}: {md["name"]}')
            enh = []
            for e in md["enhancements"]:
                g = ge.get(norm(e["name"])) or ge.get(norm(re.sub(r"\(.*?\)", "", e["name"])))
                stats["enhancements"] += 1
                stats["enhancements_with_text"] += bool(g and g.get("text"))
                upg = 1 if "(upgrade)" in e["name"].lower() else 0   # MFM's own marker is authoritative
                enh.append([e["name"], e["points"], (g or {}).get("text"), upg])
            cd = {"n": (gd or {}).get("name") or title_name(md["name"]), "dp": md["detachment_points"], "src": "mfm",
                  "fd": md.get("force_dispositions", []), "enh": enh,
                  "st": [[s["name"], s["cp"], s.get("phase"), s.get("type"), s.get("turn"), s.get("text")]
                         for s in (gd or {}).get("stratagems", [])]}
            if gd and gd.get("detachment_points") is not None and gd["detachment_points"] != md["detachment_points"]:
                stats["dp_disagreements"] += 1
                cd["gs_dp"] = gd["detachment_points"]
            for k_src, k_dst in (("restrictions", "rs"), ("support", "sup"), ("changes", "chg")):
                if md.get(k_src):
                    cd[k_dst] = md[k_src]
            if gd and gd.get("rule"):
                cd["rule"] = [gd["rule"].get("name"), gd["rule"].get("text")]
            dets.append(cd)
            seen.add(norm(md["name"]))
        # Detachments GrimSlate lists that the current MFM does not (e.g. Space Marine codex detachments
        # awaiting their codex). Included but flagged src="gs"; skipped when no DP (Boarding Actions etc.).
        for gd in (gf or {}).get("detachments", []):
            if norm(gd["name"]) in seen or gd.get("detachment_points") is None:
                continue
            stats["gs_only_detachments"] += 1
            cd = {"n": gd["name"], "dp": gd["detachment_points"], "src": "gs",
                  "fd": [gd["force_disposition"]] if gd.get("force_disposition") else [],
                  "enh": [[e["name"], e["points"], e.get("text"), 1 if e.get("is_upgrade") else 0]
                          for e in gd["enhancements"]],
                  "st": [[s["name"], s["cp"], s.get("phase"), s.get("type"), s.get("turn"), s.get("text")]
                         for s in gd["stratagems"]]}
            if gd.get("unique_tag"):
                cd["rs"] = [f'UNIQUE: {gd["unique_tag"].upper()}']
            if gd.get("rule"):
                cd["rule"] = [gd["rule"].get("name"), gd["rule"].get("text")]
            dets.append(cd)
        dets.sort(key=lambda d: (d["src"] != "mfm", d["n"].lower()))
        out_factions.append({"id": mf["id"], "name": mf["name"], "url": mf["url"], "units": units, "dets": dets})
    return out_factions, stats, unmatched_dets


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mfm", default=os.path.join(ROOT, "data", "mfm.json"))
    ap.add_argument("--gs", default=os.path.join(ROOT, "data", "grimslate.json"))
    ap.add_argument("--outdir", default=os.path.join(ROOT, "app", "data"))
    a = ap.parse_args()
    mfm = json.load(open(a.mfm, encoding="utf-8"))
    try:
        gs = json.load(open(a.gs, encoding="utf-8"))
    except Exception as e:
        print(f"warning: GrimSlate data unavailable ({e}); building MFM-only", file=sys.stderr)
        gs = {"factions": []}
    factions, stats, unmatched = merge(mfm, gs)
    ids = {f["id"]: f["name"] for f in factions}
    # faction artwork downloaded by fetch_images.py (optional)
    img_index = {}
    ip = os.path.join(ROOT, "app", "assets", "factions", "index.json")
    if os.path.exists(ip):
        img_index = json.load(open(ip))
    for f in factions:
        im = img_index.get(f["id"])
        if im:
            f["img"] = f"assets/factions/{im['thumb']}"
            f["banner"] = f"assets/factions/{im['banner']}"
    stats["factions_with_images"] = sum(1 for f in factions if f.get("img"))
    fimg = {f["id"]: f.get("img") for f in factions}
    groups = []
    for gname, members in GROUPS:
        items = []
        for m in members:
            sub, _, data = m.partition("@")
            data = data or sub
            if data in ids:
                items.append({"id": sub, "name": ids.get(sub) or title_name(sub.replace("-", " ")), "data": data,
                              **({"img": fimg[data]} if fimg.get(data) else {})})
        groups.append({"name": gname, "factions": items})
    listed = {i["data"] for g in groups for i in g["factions"]}
    extra = [{"id": f, "name": n, "data": f} for f, n in ids.items() if f not in listed]
    if extra:
        groups.append({"name": "Other", "factions": extra})

    sizes = []
    for b in (mfm.get("muster") or {}).get("battle_sizes", []):
        sizes.append({"id": norm(b["name"]), "name": b["name"], "points": b["points"],
                      "dp": b["detachment_points"], "enh": b["enhancement_limit"], "unit_limit": b["unit_limit"],
                      **({"single3dp": True} if b["name"].lower() == "incursion" else {})})
    if not sizes:  # fallback to the values published in the MFM v1.5 'Muster Armies' table
        sizes = [{"id": "incursion", "name": "Incursion", "points": 1000, "dp": 2, "enh": 2, "unit_limit": 2,
                  "single3dp": True},
                 {"id": "strikeforce", "name": "Strike Force", "points": 2000, "dp": 3, "enh": 4, "unit_limit": 3}]
    if not any(s["points"] == 3000 for s in sizes):
        # Not defined by the current MFM: points only, no DP/enhancement/unit limits enforced.
        sizes.append({"id": "onslaught", "name": "Onslaught", "points": 3000, "dp": None, "enh": None,
                      "unit_limit": None, "undefined_limits": True})

    body = {"battle_sizes": sizes, "rules_text": (mfm.get("muster") or {}).get("rules_text", []),
            "groups": groups, "factions": factions}
    content = json.dumps(body, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    h = hashlib.sha256(content.encode()).hexdigest()[:16]
    meta = {"v": 1, "fetched_at": mfm.get("fetched_at"), "mfm_version": mfm.get("source_version"),
            "gs_fetched_at": gs.get("fetched_at"), "hash": h,
            "built_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    points = {**meta, **body}
    os.makedirs(a.outdir, exist_ok=True)
    pj = os.path.join(a.outdir, "points.json")
    with open(pj + ".tmp", "w", encoding="utf-8") as f:
        json.dump(points, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(pj + ".tmp", pj)
    nunits = sum(len(f["units"]) for f in factions)
    version = {**meta, "factions": len(factions), "units": nunits}
    # Meta win rates (listhammer) ship as a separate file so a stats refresh never changes the points hash.
    # source: fresh scrape in data/ (not committed), else the copy already published in app/data (fail-safe fallback)
    wr_src = os.path.join(ROOT, "data", "winrates.json")
    if not os.path.exists(wr_src):
        wr_src = os.path.join(ROOT, "app", "data", "winrates.json")
    if os.path.exists(wr_src):
        try:
            wr = json.load(open(wr_src, encoding="utf-8"))
            wr.pop("elapsed_s", None)
            wc = json.dumps(wr, ensure_ascii=False, separators=(",", ":"))
            wj = os.path.join(a.outdir, "winrates.json")
            with open(wj + ".tmp", "w", encoding="utf-8") as f:
                f.write(wc)
            os.replace(wj + ".tmp", wj)
            version["winrates_fetched_at"] = wr.get("fetched_at")
            version["winrates_range"] = (wr.get("date_range") or {}).get("dates")
            # hash the content only (not fetched_at) so an unchanged daily re-fetch doesn't count as new data
            wh = {k: v for k, v in wr.items() if k != "fetched_at"}
            version["winrates_hash"] = hashlib.sha256(json.dumps(wh, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]
            print(f"winrates.json: {len(wc)/1024:.0f} KB, {len(wr.get('factions', []))} factions", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print("warn: winrates not bundled:", e, file=sys.stderr)
    vj = os.path.join(a.outdir, "version.json")
    with open(vj + ".tmp", "w", encoding="utf-8") as f:
        json.dump(version, f, ensure_ascii=False, indent=1)
    os.replace(vj + ".tmp", vj)
    s = stats
    print(f"points.json: {os.path.getsize(pj)/1024:.0f} KB, hash {h}, {len(factions)} factions, {nunits} units", file=sys.stderr)
    print(f"  units with GrimSlate keywords/roles: {s['units_with_keywords']}/{s['units']}", file=sys.stderr)
    print(f"  MFM detachments matched to GrimSlate: {s['detachments_matched']}/{s['detachments']} "
          f"(with stratagems: {s['detachments_with_stratagems']}); DP disagreements: {s['dp_disagreements']}", file=sys.stderr)
    print(f"  enhancements with rules text: {s['enhancements_with_text']}/{s['enhancements']}", file=sys.stderr)
    print(f"  GrimSlate-only detachments added (flagged): {s['gs_only_detachments']}", file=sys.stderr)
    print(f"  units with loadout data (GrimSlate composition): {s['units_with_loadout']}/{s['units']}, "
          f"{s['loadout_options']} options; MFM priced wargear linked to options: {s['wargear_linked']}/{s['wargear_priced']}", file=sys.stderr)
    print(f"  duplicate unit names disambiguated: {s['renamed_duplicate_units']}", file=sys.stderr)
    print(f"  factions with artwork: {s['factions_with_images']}/{len(factions)}", file=sys.stderr)
    stats_path = os.path.join(ROOT, "data", "build_stats.json")
    json.dump({"stats": dict(s), "unmatched_mfm_detachments": unmatched}, open(stats_path, "w"), indent=1)


if __name__ == "__main__":
    main()
