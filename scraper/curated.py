"""Curated datasheet layer (scraper/overrides/curated_datasheets.json), applied last by build_data.py:
- factions.<fid>.<unit>: full datasheet for units no source covers (only fills a unit that still has none; 'kw' fills empty unit keywords)
- fixes.<fid|*>.<unit>: corrections confirmed by two sources ('s'/'sx' stat patch, 'replace' whole datasheet, 'lo' loadout model, 'wa_add'/'ab_add' missing ability cards)"""
import json, os

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "overrides", "curated_datasheets.json")
def load(): return json.load(open(PATH, encoding="utf-8"))

def apply(fid, units, f_ds, stats=None, C=None):
    """comp must be a list of lines (the stats view maps it)"""
    C = C or load(); stats = stats if stats is not None else {}
    for n, rec in (C["factions"].get(fid) or {}).items():
        u = next((x for x in units if x["n"] == n), None)
        if not u: continue
        if not f_ds.get(n):
            f_ds[n] = json.loads(json.dumps({k: v for k, v in rec.items() if k not in ("kw", "r")})); stats["curated_datasheets"] = stats.get("curated_datasheets", 0) + 1
        if not u.get("kw") and rec.get("kw"): u["kw"] = [n] + rec["kw"]
        if rec.get("r") and u.get("r") in (None, "", "Other"): u["r"] = rec["r"]
    fx = C.get("fixes") or {}
    for scope in (fid, "*"):
        for n, p in (fx.get(scope) or {}).items():
            if not isinstance(p, dict): continue
            u = next((x for x in units if x["n"] == n), None)
            if not u: continue
            if "replace" in p: f_ds[n] = json.loads(json.dumps(p["replace"]))
            d = f_ds.get(n)
            if d is not None:
                if "s" in p: d["s"] = {**(d.get("s") or {}), **p["s"]}
                if "sx" in p: d["sx"] = json.loads(json.dumps(p["sx"]))
                for a in p.get("wa_add") or []:
                    if not any(x[0] == a[0] for x in d.setdefault("wa", [])): d["wa"].append(a)
                for a in p.get("ab_add") or []:
                    if not any(x[0] == a[0] for x in d.setdefault("ab", [])): d["ab"].append(a)
            if "lo" in p: u["lo"] = json.loads(json.dumps(p["lo"]))
            stats["curated_fixes"] = stats.get("curated_fixes", 0) + 1
