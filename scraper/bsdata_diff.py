"""Diff BSData (New Recruit) facts against Muster's built data. usage: bsdata_diff.py <bsd_ex.json> <out.json>"""
import json, re, sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from bsdata import norm as _n
norm = lambda x: _n(re.sub(r"\s*\[Legends\]", "", x or ""))
B = json.load(open(sys.argv[1])); P = json.load(open("app/data/points.json"))
def fid_of(cat):
    n = norm(re.sub(r"^(Imperium|Chaos|Xenos)( - Adeptus Astartes)? - ", "", cat)).replace(" ", "-")
    return {"t-au-empire": "tau-empire", "aeldari": "aeldari", "emperor-s-children": "emperors-children"}.get(n, n)
res = {}
for cat, b in B.items():
    fid = fid_of(cat); F = next((f for f in P["factions"] if f["id"] == fid), None)
    if not F: res[cat] = {"unmapped": True}; continue
    bu = {norm(k): (k, v) for k, v in b["units"].items()}
    mu = {norm(u["n"]): u for u in F["units"] if not u.get("af")}
    r = res.setdefault(fid, {"leaders_add": [], "leaders_extra": [], "multi": [], "units_missing_in_bs": [], "units_missing_in_muster": [], "enh_missing": [], "enh_extra": [], "opts_missing": []})
    for k, u in mu.items():
        if k not in bu: r["units_missing_in_bs"].append(u["n"]); continue
        bn, v = bu[k]
        ml = {norm(x) for x in u.get("ldr") or []} | {norm(x) for x in u.get("sup") or []}
        isch = lambda n: "Character" in (mu[n].get("kw") or []) and not mu[n].get("ldr")
        bl = {norm(x): x for x in v["leads"] if norm(x) in mu and norm(x) != k and not isch(norm(x))}
        granted = {norm(t) for d in F["dets"] for e in d.get("enh", []) if len(e) > 4 and e[4] for t in e[4].get("u", [])}
        if v["leads"]:
            for n, x in bl.items():
                if n not in ml:
                    (r.setdefault("leaders_via_enh", []) if n in granted else r["leaders_add"]).append([u["n"], mu[n]["n"]])
        allb = {norm(x) for x in v["leads"] + v.get("leads_cat", [])}
        if allb:
            for n in ml:
                if n not in allb and n in mu: r["leaders_extra"].append([u["n"], mu[n]["n"]])
        for x in v.get("leads_cat", []):
            n = norm(x)
            if n in mu and n not in ml and n != k and not isch(n):
                (r.setdefault("leaders_via_enh", []) if n in granted else r.setdefault("leaders_review", [])).append([u["n"], mu[n]["n"]])
        for mm in v["ml_mod"] or []:
            w = [mu[norm(x)]["n"] for x in mm["when"] if norm(x) in mu]
            covered = bool(u.get("ml")) or any(mu[norm(x)].get("xl") for x in w)
            if not covered: r["multi"].append({"body": u["n"], "n": mm["n"], "when": mm["when"]})
        mopts = set()
        def addo(x):
            for part in re.split(r",| and |\+|&| w/ | with ", x):
                n = re.sub(r"^\d+x? |^(one|two|an?) ", "", norm(part)).strip()
                mopts.add(n); mopts.add(n.rstrip("s")); mopts.add(re.sub(r"(\w+)s\b", r"\1", n))
        lo = u.get("lo") or {}
        for m in (lo.get("m") or []):
            addo(m[0])
            for sl in m[4] or []:
                for o in sl[1]: addo(o[0])
            for w in m[3] or []: addo(w)
        for sl in lo.get("u") or []:
            for o in sl[1]: addo(o[0])
        on = lambda o: re.sub(r"(\w+)s\b", r"\1", re.sub(r"^(\d+x?|one|two|three|four|an?) ", "", norm(o)))
        miss = [o for o in v["opts"] if norm(o) not in mopts and on(o) not in mopts and norm(o).rstrip("s") not in mopts and not all(on(p) in mopts or norm(p) in mopts for p in re.split(r",| and |&", o)) and not re.search(r"warlord|enhancement|crusade|mark of|icon of|^\d", o, re.I)]
        if miss: r["opts_missing"].append([u["n"], miss])
    menh = {norm(e[0].split(" (")[0]): (d["n"], e[0]) for d in F["dets"] for e in d.get("enh", [])}
    benh = {norm(e): (dn, e) for dn, es in b["enh"].items() for e in es}
    if len(benh) > 16:
        r["enh_missing"] = [v for k, v in benh.items() if k not in menh]
        r["enh_extra"] = [v for k, v in menh.items() if k not in benh]
json.dump(res, open(sys.argv[2], "w"), indent=1, ensure_ascii=False)
for f, r in res.items():
    if "unmapped" in r: print("UNMAPPED", f); continue
    print(f, {k: len(v) for k, v in r.items()})
