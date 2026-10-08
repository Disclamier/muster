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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import codex_override  # noqa: E402  committed codex override layer (Space Marines 11th-ed codex)

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


def gs_alt_keys(name):
    """Alternative GrimSlate lookup keys for an MFM unit name (spelling variants, never a different unit)."""
    base = re.sub(r"\s*\[legends\]\s*", " ", str(name), flags=re.I).strip()
    base = re.sub(r"(?i)defence", "defense", base)
    out = []
    for n in (base, re.sub(r"(?i)\s+with\s+.*$", "", base)):
        k = norm(n)
        out += [k, k[:-1] if k.endswith("s") else k + "s", norm(n + " battle tank"), norm(n + " [legends]")]
    return [k for i, k in enumerate(out) if k and k not in out[:i]]


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
    ds_out = merge.datasheets = {}
    merge.codex_report = {}
    for mf in mfm["factions"]:
        gf = gsf.get(SLUG_MAP.get(mf["id"], mf["id"]))
        fu = {}
        if gf:
            for u in gf["units"]:
                fu.setdefault(norm(u["name"]), u)
        units = []
        for u in mf["units"]:
            gu = fu.get(norm(u["name"])) or g_units.get(norm(u["name"]))
            fuzzy = None
            if not gu:
                # spelling variants only (plural/singular, Defence/Defense, "[Legends]", "... with <weapon>" suffix);
                # the unit keeps its MFM display name so saved lists never change
                for k in gs_alt_keys(u["name"]):
                    fuzzy = fu.get(k) or g_units.get(k)
                    if fuzzy:
                        stats["units_matched_fuzzy"] += 1
                        break
            stats["units"] += 1
            stats["units_with_keywords"] += bool(gu or fuzzy)
            name = (gu or {}).get("name") or title_name(u["name"])
            gu = gu or fuzzy
            kws = (gu or {}).get("keywords") or []
            name = re.sub(r"\s*\[Legends\]\s*$", "", name)
            cu = {"_gu": gu, "n": name, "r": role_from_keywords(kws, name, u.get("leader_of")), "kw": kws,
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
            if (gu or {}).get("faction_keyword"):
                cu["fk"] = gu["faction_keyword"]
            if u.get("unit_group"):
                cu["grp"] = title_name(u["unit_group"])
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
        apply_detachment_restrictions(mf, units, dets, stats)
        # datasheets (profiles / abilities) ship in a separate file: unit display name -> compact datasheet
        frules = (gf or {}).get("faction_rules") or []
        frn = {norm(r.get("name")) for r in frules}
        f_ds = {}
        for x in units:
            gu = x.pop("_gu", None)
            cds = compact_ds(gu, frn) if gu else None
            if cds:
                f_ds[x["n"]] = cds
                stats["units_with_datasheet"] += 1
                stats["units_with_weapon_profiles"] += bool(cds["wp"])
                stats["units_with_abilities"] += bool(cds["ab"] or cds["cr"] or cds["fa"])
        f_rules = [[r.get("name"), r.get("text") or ""] for r in frules]
        # codex override layer: beats GrimSlate for datasheets / loadouts / detachment rules+stratagems+enhancement text
        codex_override.apply(mf["id"], units, dets, f_ds, f_rules,
                             {x["n"]: [{"name": w[0]} for w in x.get("w") or []] for x in units},
                             stats, merge.codex_report, role_from_keywords)
        units.sort(key=lambda x: (ROLE_ORDER.index(x["r"]) if x["r"] in ROLE_ORDER else 99, x["n"].lower()))
        ds_out[mf["id"]] = {"rules": f_rules, "units": f_ds}
        out_factions.append({"id": mf["id"], "name": mf["name"], "url": mf["url"], "units": units, "dets": dets})
    return out_factions, stats, unmatched_dets


def compact_ds(gu, frn):
    """GrimSlate datasheet -> compact form: s stats, inv invuln, ab [[name,text]], wa wargear abilities
    [[option,name,text]], cr core rule names, fa faction ability names, wp weapons [[name, r|m, [[profile, range, A,
    BS/WS, S, AP, D, [keywords]]]]], ml model loadouts [[model, [weapon names]]], tr transport text."""
    ds = gu.get("datasheet") or {}
    if not ds or not (ds.get("stats") or ds.get("weapons") or ds.get("abilities")):
        return None
    ab = ds.get("abilities") or []
    is_inv = lambda a: norm(a.get("name")) in ("invulnerablesave", "invulnerable")
    inv = next((a.get("text") for a in ab if is_inv(a)), None)
    rules = [r for r in ds.get("rules") or [] if r]
    wid = ds.get("weapon_ids") or {}
    out = {"s": ds.get("stats"),
           "ab": [[a.get("name"), a.get("text") or ""] for a in ab if not is_inv(a)],
           "wa": [[w.get("option"), w.get("name"), w.get("text") or ""] for w in ds.get("wargear_abilities") or []],
           "cr": [r for r in rules if norm(r) not in frn],
           "fa": [r for r in rules if norm(r) in frn],
           "wp": [[w.get("name"), "r" if w.get("type") == "ranged" else "m",
                   [[p.get("profile"), p.get("range"), p.get("a"), p.get("skill"), p.get("s"), p.get("ap"), p.get("d"), p.get("keywords") or []]
                    for p in w.get("profiles") or []]] for w in ds.get("weapons") or []],
           "ml": [[m.get("name"), [wid.get(i, i) for i in m.get("weapons") or []]] for m in ds.get("model_loadouts") or []]}
    if inv:
        out["inv"] = inv
    if ds.get("transport"):
        out["tr"] = ds["transport"]
    return out


def apply_detachment_restrictions(mf, units, dets, stats):
    """Units that can only be taken with particular detachments -> unit["req"] = [detachment names].
    Neither MFM nor GrimSlate has an explicit field, so this is derived from both (conservatively):
      1. MFM lists the unit in a named sub-group of the faction page that is not an MFM faction
         (e.g. World Eaters "BLOOD LEGIONS", Death Guard "PLAGUE LEGIONS"),
      2. the unit is not part of the army faction: it has a GrimSlate faction keyword that differs from the army's and it
         has neither the army's faction keyword nor the faction name among its keywords
         (Harlequins / Ynnari carry AELDARI, Ultramarines characters carry ADEPTUS ASTARTES -> not restricted),
      3. the group's name appears in the rule text of some (not all) of the faction's detachments
         (BLOOD LEGIONS -> Khorne Daemonkin). Those detachments unlock the unit."""
    main_fk = Counter(u.get("fk") for u in units if u.get("fk") and not u.get("grp")).most_common(1)
    main_fk = main_fk[0][0] if main_fk else None
    ident = {norm(mf["name"])} | ({norm(main_fk)} if main_fk else set())
    groups = {}
    for u in units:
        if u.get("grp"):
            groups.setdefault(u["grp"], []).append(u)
    for g, us in groups.items():
        if norm(g) in ident:
            continue
        outsiders = [u for u in us if u.get("fk") and norm(u["fk"]) not in ident and not ({norm(k) for k in u.get("kw") or []} & ident)]
        if not outsiders:
            continue
        pat = re.compile(r"\b" + re.escape(g).replace(r"\ ", r"\s+") + r"\b", re.I)
        unlock = [d["n"] for d in dets if d.get("rule") and pat.search(f"{d['rule'][0]} {d['rule'][1]}")]
        if not unlock or len(unlock) == len(dets):
            continue
        for u in outsiders:
            u["req"] = unlock
            stats["detachment_restricted_units"] += 1
        stats["restricted_groups"] += 1
        print(f"  restricted: {mf['id']}: {g} ({len(outsiders)} units) -> only with {', '.join(unlock)}", file=sys.stderr)


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
    wr_pub = os.path.join(ROOT, "app", "data", "winrates.json")
    if not os.path.exists(wr_src):
        wr_src = wr_pub
    elif os.path.exists(wr_pub):  # never let an older cached scrape replace newer published stats
        try:
            fa = json.load(open(wr_src, encoding="utf-8")).get("fetched_at") or ""
            fb = json.load(open(wr_pub, encoding="utf-8")).get("fetched_at") or ""
            if fb > fa:
                print(f"note: published winrates ({fb}) newer than data/winrates.json ({fa}) - keeping published", file=sys.stderr)
                wr_src = wr_pub
        except Exception:  # noqa: BLE001
            pass
    if os.path.exists(wr_src):
        try:
            wr = json.load(open(wr_src, encoding="utf-8"))
            wr.pop("elapsed_s", None)
            # recent tournament lists (full list text) are big: one lazily-loaded file per faction in meta-lists/
            rl = wr.pop("recent_lists", None)
            if rl:
                ld = os.path.join(a.outdir, "meta-lists")
                os.makedirs(ld, exist_ok=True)
                for slug, v in rl.items():
                    if not re.fullmatch(r"[a-z0-9-]+", slug or ""):
                        continue
                    lc = json.dumps({"fetched_at": wr.get("fetched_at"), **v}, ensure_ascii=False, separators=(",", ":"))
                    with open(os.path.join(ld, slug + ".json.tmp"), "w", encoding="utf-8") as f:
                        f.write(lc)
                    os.replace(os.path.join(ld, slug + ".json.tmp"), os.path.join(ld, slug + ".json"))
                wr["lists_hash"] = hashlib.sha256(json.dumps(rl, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]
                wr["lists_available"] = sorted(k for k, v in rl.items() if (v.get("std") or {}).get("lists") or (v.get("rtt") or {}).get("lists"))
                print(f"meta-lists/: {len(rl)} faction files", file=sys.stderr)
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
    # datasheets (GrimSlate profiles/abilities) - separate file so rules-text changes never touch the points hash
    dsb = {"source": "GrimSlate (profiles, abilities, keywords); Codex: Space Marines 11th ed. override (scraper/overrides)", "gs_fetched_at": gs.get("fetched_at"),
           "data_version": gs.get("data_version"), "data_hash": gs.get("data_hash"), "game_system": gs.get("game_system"),
           "weapon_keywords": gs.get("weapon_keywords") or {}, "factions": merge.datasheets}
    # hash the content only (not the fetch time) so an unchanged GrimSlate isn't republished every day
    dsc = json.dumps({k: v for k, v in dsb.items() if k != "gs_fetched_at"}, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    dsh = hashlib.sha256(dsc.encode()).hexdigest()[:16]
    dsj = os.path.join(a.outdir, "datasheets.json")
    with open(dsj + ".tmp", "w", encoding="utf-8") as f:
        f.write(json.dumps({"hash": dsh, **dsb}, ensure_ascii=False, separators=(",", ":")))
    os.replace(dsj + ".tmp", dsj)
    version["datasheets_hash"] = dsh
    version["datasheets_version"] = gs.get("data_version")
    print(f"datasheets.json: {os.path.getsize(dsj)/1024:.0f} KB, hash {dsh}", file=sys.stderr)
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
    print(f"  datasheets: {s['units_with_datasheet']}/{s['units']} units, weapon profiles {s['units_with_weapon_profiles']}, "
          f"abilities {s['units_with_abilities']}", file=sys.stderr)
    print(f"  units with loadout data (GrimSlate composition): {s['units_with_loadout']}/{s['units']}, "
          f"{s['loadout_options']} options; MFM priced wargear linked to options: {s['wargear_linked']}/{s['wargear_priced']}", file=sys.stderr)
    print(f"  duplicate unit names disambiguated: {s['renamed_duplicate_units']}", file=sys.stderr)
    print(f"  factions with artwork: {s['factions_with_images']}/{len(factions)}", file=sys.stderr)
    print(f"  codex override: {s['codex_datasheets']} datasheets, {s['codex_detachments']} detachments, "
          f"{s['codex_stratagems']} stratagems, {s['codex_enhancements']} enhancement texts", file=sys.stderr)
    json.dump(merge.codex_report, open(os.path.join(ROOT, "data", "codex_report.json"), "w"), indent=1, ensure_ascii=False)
    stats_path = os.path.join(ROOT, "data", "build_stats.json")
    json.dump({"stats": dict(s), "unmatched_mfm_detachments": unmatched}, open(stats_path, "w"), indent=1)


if __name__ == "__main__":
    main()
