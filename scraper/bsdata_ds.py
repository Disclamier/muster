"""BSData wh40k-11e (New Recruit's data, JSON export) -> Muster-style datasheet facts per unit:
stats (per model profile), weapons (name, kind, profiles), abilities, rules (core), keywords, model counts.
usage: bsdata_ds.py <bsdata_json_dir> <out.json>"""
import glob, json, os, re, sys

def load(d):
    cats = {}
    for f in glob.glob(os.path.join(d, "*.json")):
        j = json.load(open(f)); c = j.get("catalogue") or j.get("gameSystem"); cats[c["id"]] = c
    return cats

def index(cats):
    ids = {}
    def walk(x):
        if isinstance(x, dict):
            if "id" in x: ids.setdefault(x["id"], x)
            for v in x.values(): walk(v)
        elif isinstance(x, list):
            for i in x: walk(i)
    for c in cats.values(): walk(c)
    return ids

SKIP = re.compile(r"crusade|enhancement|warlord|weapon modification|battle honour|battle scar", re.I)
ch = lambda p: {c["name"]: c.get("$text", "") for c in p.get("characteristics") or []}

def unit_facts(e, ids):
    out = {"stats": {}, "wp": {}, "ab": {}, "rules": set(), "kw": [], "models": {}}
    out["kw"] = sorted({cl["name"] for cl in e.get("categoryLinks") or [] if not cl["name"].startswith("Faction:")})
    seen = set()
    def prof(p):
        t = (p.get("typeName") or ""); c = ch(p)
        if t == "Unit": out["stats"][p["name"]] = c
        elif "Weapons" in t:
            nm = p["name"]; base, _, pr = nm.partition(" ➤ ")
            out["wp"].setdefault((base.strip(), "m" if t.startswith("Melee") else "r"), {})[pr.strip() or None] = c
        elif t == "Abilities": out["ab"][p["name"]] = c.get("Description", "")
    def walk(x, depth=0):
        if depth > 8 or id(x) in seen: return
        seen.add(id(x))
        if SKIP.search(x.get("name") or ""): return
        for p in x.get("profiles") or []: prof(p)
        for il in x.get("infoLinks") or []:
            t = ids.get(il.get("targetId"))
            if not t: continue
            if il.get("type") == "profile": prof({**t, "name": t.get("name")})
            elif il.get("type") == "rule": out["rules"].add(il.get("name") or t.get("name"))
            elif il.get("type") == "infoGroup":
                for p in t.get("profiles") or []: prof(p)
                for r in t.get("rules") or []: out["rules"].add(r["name"])
        for r in x.get("rules") or []: out["rules"].add(r["name"])
        for se in x.get("selectionEntries") or []:
            if se.get("type") == "model":
                mn = mx = None
                for cs in se.get("constraints") or []:
                    if cs.get("field") == "selections" and cs.get("scope") == "parent":
                        if cs["type"] == "min": mn = cs["value"]
                        if cs["type"] == "max": mx = cs["value"]
                out["models"][se["name"]] = [mn, mx]
            walk(se, depth + 1)
        for g in x.get("selectionEntryGroups") or []: walk(g, depth + 1)
        for el in x.get("entryLinks") or []:
            t = ids.get(el.get("targetId"))
            if t and not SKIP.search(el.get("name") or ""): walk(t, depth + 1)
    walk(e)
    out["rules"] = sorted(out["rules"])
    out["wp"] = [[k[0], k[1], v] for k, v in out["wp"].items()]
    return out

def extract(d):
    cats = load(d); ids = index(cats); res = {}
    for cid, c in cats.items():
        if c.get("library") or c.get("type") != "catalogue": continue
        scope = [c] + [cats[l["targetId"]] for l in c.get("catalogueLinks", []) if l["targetId"] in cats]
        roots = {}
        for s in scope:
            for e in s.get("sharedSelectionEntries") or []:
                if e.get("type") in ("unit", "model"): roots[e["id"]] = e
        for el in c.get("entryLinks") or []:
            t = ids.get(el.get("targetId"))
            if t and t.get("type") in ("unit", "model"): roots[t["id"]] = t
        res[c["name"]] = {e["name"]: unit_facts(e, ids) for e in roots.values()}
    return res

if __name__ == "__main__":
    r = extract(sys.argv[1]); json.dump(r, open(sys.argv[2], "w"), indent=0, ensure_ascii=False)
    print({k: len(v) for k, v in r.items()})
