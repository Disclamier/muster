"""BSData wh40k-11e (New Recruit's data) -> normalized per-faction facts for parity diffs.
usage: bsdata.py extract <bsdata_dir> <out.json>"""
import json, glob, os, re, sys, collections

def norm(s): return re.sub(r"[^a-z0-9]+", " ", (s or "").lower().replace("’", "'")).strip()

def load(d):
    cats = {}
    for f in glob.glob(os.path.join(d, "*.json")):
        j = json.load(open(f)); c = j.get("catalogue") or j.get("gameSystem")
        cats[c["id"]] = c
    return cats

def index(cats):
    ids = {}
    def walk(x, cat):
        if isinstance(x, dict):
            if "id" in x and "name" in x: ids.setdefault(x["id"], (x, cat))
            for v in x.values(): walk(v, cat)
        elif isinstance(x, list):
            for i in x: walk(i, cat)
    for cid, c in cats.items(): walk(c, cid)
    return ids

def isweap(x):
    ps = list(x.get("profiles") or []) + [p for se in x.get("selectionEntries") or [] for p in se.get("profiles") or []]
    return any("weapon" in (p.get("typeName") or "").lower() for p in ps) or bool(x.get("infoLinks")) and any("weapon" in (i.get("name") or "").lower() or i.get("type") == "profile" for i in x["infoLinks"])

def extract(d):
    cats = load(d); ids = index(cats)
    name_of = lambda i: ids[i][0]["name"] if i in ids else None
    out = {}
    for cid, c in cats.items():
        if c.get("library") or c.get("type") != "catalogue": continue
        scope = [c] + [cats[l["targetId"]] for l in c.get("catalogueLinks", []) if l["targetId"] in cats]
        shared_assoc = {a["id"]: a for s in scope for a in s.get("sharedAssociations", []) or []}
        units, dets = {}, {}
        roots = {}
        for s in scope:
            for e in s.get("sharedSelectionEntries", []) or []:
                if e.get("type") in ("unit", "model"): roots[e["id"]] = e
        for el in c.get("entryLinks", []) or []:
            t = ids.get(el.get("targetId"))
            if t and t[0].get("type") in ("unit", "model"): roots[t[0]["id"]] = t[0]
        bycat = {}
        for e in roots.values():
            for cl in e.get("categoryLinks") or []:
                bycat.setdefault(cl.get("targetId"), set()).add(e["name"])
        for e in roots.values():
            u = {"leads": [], "max_leaders": None, "ml_mod": False, "models": {}, "opts": set()}
            assocs = list(e.get("associations") or []) + [shared_assoc[a["targetId"]] for a in e.get("associationLinks") or [] if a.get("targetId") in shared_assoc]
            def conds(g):
                for cd in g.get("conditions") or []:
                    yield cd
                for sg in g.get("conditionGroups") or []:
                    yield from conds(sg)
            for a in assocs:
                for cd in conds(a):
                    if cd.get("type") in ("instanceOf", "atLeast", "equalTo") and cd.get("value", 1) >= 1:
                        cid_ = cd.get("childId"); t = ids.get(cid_)
                        if t and t[0].get("type") not in ("unit", "model"):
                            if cid_ in bycat and len(bycat[cid_]) <= 8:
                                u.setdefault("leads_cat", []).extend(bycat[cid_])   # keyword (category) condition: review only
                        else:
                            n = cd.get("childName") or name_of(cid_)
                            if n: u["leads"].append(n)
            for cs in e.get("constraints") or []:
                if cs.get("field") == "associations" and cs.get("type") == "max":
                    u["max_leaders"] = cs["value"]
                    for m in (e.get("modifiers") or []) + [m for g in e.get("modifierGroups") or [] for m in g.get("modifiers") or []]:
                        if m.get("field") == cs["id"] and m.get("type") in ("increment", "set"):
                            nv = float(m["value"]) if m["type"] == "set" else cs["value"] + float(m["value"])
                            if nv > cs["value"]:
                                w = sorted({cd.get("childName") or name_of(cd.get("childId")) or "?" for cd in conds(m)})
                                u["ml_mod"] = u["ml_mod"] or []
                                u["ml_mod"].append({"n": int(nv), "when": w})
            def opts(x, depth=0):
                for se in x.get("selectionEntries") or []:
                    if se.get("type") == "model":
                        mn = mx = None
                        for cs in se.get("constraints") or []:
                            if cs.get("field") == "selections" and cs.get("scope") == "parent":
                                if cs["type"] == "min": mn = cs["value"]
                                if cs["type"] == "max": mx = cs["value"]
                        u["models"][se["name"]] = [mn, mx]
                    if se.get("type") == "upgrade" and isweap(se): u["opts"].add(se["name"])
                    opts(se, depth + 1)
                for g in x.get("selectionEntryGroups") or []:
                    if g.get("name") in ("Enhancements", "Crusade", "Warlord") or "crusade" in g.get("name", "").lower(): continue
                    opts(g, depth + 1)
                for el in x.get("entryLinks") or []:
                    t = ids.get(el.get("targetId"))
                    if not t or el.get("name") in ("Enhancements", "Crusade", "Warlord"): continue
                    if "crusade" in (t[0].get("name") or "").lower(): continue
                    if t[0].get("type") == "upgrade" and isweap(t[0]): u["opts"].add(t[0]["name"])
                    elif t[0].get("type") == "model": u["models"].setdefault(t[0]["name"], [None, None])
                    if depth < 4: opts(t[0], depth + 1)
            opts(e)
            u["opts"] = sorted(u["opts"]); u["leads"] = sorted(set(u["leads"])); u["leads_cat"] = sorted(set(u.get("leads_cat", [])) - set(u["leads"]))
            units[e["name"]] = u
        # detachments: entries named after a detachment with child upgrades in an Enhancements group
        def walk(x):
            if isinstance(x, dict):
                if x.get("type") == "upgrade" and x.get("comment") and "Enhancement" not in x.get("name", ""):
                    pass
                for g in x.get("selectionEntryGroups") or []:
                    if g.get("name") == "Enhancements":
                        for se in g.get("selectionEntries") or []:
                            dets.setdefault(se.get("comment") or "?", set()).add(se["name"])
                        for sg in g.get("selectionEntryGroups") or []:
                            for se in sg.get("selectionEntries") or []:
                                dets.setdefault(se.get("comment") or sg["name"], set()).add(se["name"])
                for v in x.values(): walk(v)
            elif isinstance(x, list):
                for i in x: walk(i)
        for s in [c]:
            for g in s.get("sharedSelectionEntryGroups") or []:
                if g.get("name") == "Enhancements":
                    for se in g.get("selectionEntries") or []:
                        dets.setdefault(se.get("comment") or "?", set()).add(se["name"])
        out[c["name"]] = {"units": units, "enh": {k: sorted(v) for k, v in dets.items()}}
    return out

if __name__ == "__main__":
    r = extract(sys.argv[2]); json.dump(r, open(sys.argv[3], "w"), indent=1, ensure_ascii=False)
    print({k: (len(v["units"]), sum(len(x) for x in v["enh"].values())) for k, v in r.items()})
