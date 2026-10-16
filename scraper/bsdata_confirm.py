"""Second-source check of BSData leader 'review' pairs against Wahapedia Datasheets_leader.csv -> overrides/bsdata_leaders.json
usage: bsdata_confirm.py <bsd_diff.json> <wahapedia_dir>"""
import csv, json, re, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bsdata import norm
D = json.load(open(sys.argv[1])); W = sys.argv[2]
rd = lambda f: list(csv.DictReader(open(os.path.join(W, f), encoding="utf-8-sig"), delimiter="|"))
ds = {r["id"]: r for r in rd("Datasheets.csv")}
L = set()
for r in rd("Datasheets_leader.csv"):
    a, b = ds.get(r["leader_id"]), ds.get(r["attached_id"])
    if a and b: L.add((norm(a["name"]), norm(b["name"])))
add, rest = {}, {}
for fid, r in D.items():
    for ldr, body in r.get("leaders_review", []) + r.get("leaders_add", []):
        if (norm(ldr), norm(body)) in L: add.setdefault(fid, {}).setdefault(ldr, []).append(body)
        else: rest.setdefault(fid, []).append([ldr, body])
P = json.load(open("app/data/points.json"))
noldr = {}
for F in P["factions"]:
    for u in F["units"]:
        if "Leader" in (u.get("kw") or []) and not u.get("ldr") and not u.get("sup"):
            hits = sorted(b for (a, b) in L if a == norm(u["n"]))
            noldr.setdefault(F["id"], []).append([u["n"], hits])
json.dump({"note": "Leader targets New Recruit (BSData wh40k-11e) allows that Muster lacked, confirmed by Wahapedia's leader table",
           "add": add}, open("scraper/overrides/bsdata_leaders.json", "w"), indent=1, ensure_ascii=False)
json.dump({"unconfirmed": rest, "leader_kw_without_targets": noldr}, open("/tmp/bsd_rest.json", "w"), indent=1, ensure_ascii=False)
print("confirmed", sum(len(v) for f in add.values() for v in f.values()), "unconfirmed", sum(len(v) for v in rest.values()))
print(json.dumps(add, ensure_ascii=False)[:3000]); print(json.dumps(noldr, ensure_ascii=False)[:2500])
