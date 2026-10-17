"""Wahapedia wh40k11ed CSV export -> Muster datasheet records (s, inv, wp, ab, cr, fa, wa, wo, ml, kw).
Used offline to curate datasheets for units no other source covers (scraper/overrides/curated_datasheets.json).
usage: wahapedia_ds.py <csv_dir> "<Datasheet name>" [faction_id]"""
import csv, html, json, os, re, sys
csv.field_size_limit(10 ** 9)

def rd(d, f): return list(csv.DictReader(open(os.path.join(d, f + ".csv"), encoding="utf-8-sig"), delimiter="|"))
def txt(s):
    s = re.sub(r"<li>", "\n■ ", s or ""); s = re.sub(r"<br\s*/?>", "\n", s); s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\n{2,}", "\n", html.unescape(s)).strip()
def tc(s): return " ".join(w if w.isupper() and len(w) <= 3 else w.capitalize() for w in s.split())

class W:
    def __init__(s, d):
        s.ds = rd(d, "Datasheets"); s.models = rd(d, "Datasheets_models"); s.wg = rd(d, "Datasheets_wargear")
        s.dab = rd(d, "Datasheets_abilities"); s.ab = {r["id"]: r for r in rd(d, "Abilities")}; s.kw = rd(d, "Datasheets_keywords")
    def find(s, name, fac=None):
        r = [x for x in s.ds if x["name"].lower() == name.lower() and (not fac or x["faction_id"] == fac)]
        return r[0] if r else None
    def record(s, name, fac=None):
        d = s.find(name, fac)
        if not d: return None
        i = d["id"]
        ms = [m for m in s.models if m["datasheet_id"] == i]
        m0 = ms[0]
        st = {"M": m0["M"], "T": m0["T"], "SV": m0["Sv"], "W": m0["W"], "LD": m0["Ld"], "OC": m0["OC"]}
        rec = {"s": st, "wp": [], "ab": [], "cr": [], "fa": [], "wa": [], "wo": [], "ml": [], "src": "wahapedia"}
        if m0["inv_sv"] and m0["inv_sv"] != "-": rec["inv"] = m0["inv_sv"] + ("+" if not m0["inv_sv"].endswith("+") else "")
        if len(ms) > 1: rec["sx"] = [[x["name"], {"M": x["M"], "T": x["T"], "SV": x["Sv"], "W": x["W"], "LD": x["Ld"], "OC": x["OC"]}, None] for x in ms[1:]]
        wps = {}
        for w in [w for w in s.wg if w["datasheet_id"] == i]:
            nm = w["name"]; prof = None
            mm = re.match(r"^(.*?)\s[–-]\s(.+)$", nm)
            if mm: nm, prof = mm.group(1), mm.group(2).lower()
            kind = "m" if w["type"] == "Melee" else "r"
            rng = "Melee" if kind == "m" else (w["range"] + '"' if w["range"] and not w["range"].endswith('"') else w["range"])
            skill = w["BS_WS"] if w["BS_WS"] in ("-", "N/A", "") else w["BS_WS"] + "+"
            kws = [tc(k.strip()) for k in txt(w["description"]).split(",") if k.strip()]
            key = (nm.strip(), kind)
            wps.setdefault(key, []).append([prof, rng, w["A"], skill if skill not in ("-", "") else "N/A", w["S"], w["AP"], w["D"], kws])
        rec["wp"] = [[k[0], k[1], v] for k, v in wps.items()]
        for a in [a for a in s.dab if a["datasheet_id"] == i]:
            if a["ability_id"]:
                g = s.ab.get(a["ability_id"]); nm = (g or {}).get("name", "")
                if a["type"].startswith("Core"): rec["cr"].append(nm + (" " + a["parameter"] if a["parameter"] else ""))
                elif a["type"] == "Faction": rec["fa"].append(nm)
                else: rec["ab"].append([nm, txt((g or {}).get("description", ""))])
            elif a["type"].startswith("Wargear"): rec["wa"].append([a["name"], a["name"], txt(a["description"])])
            else: rec["ab"].append([a["name"], txt(a["description"])])
        rec["kw"] = [k["keyword"] for k in s.kw if k["datasheet_id"] == i and k["is_faction_keyword"] != "true"]
        return rec

if __name__ == "__main__":
    print(json.dumps(W(sys.argv[1]).record(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None), indent=1, ensure_ascii=False))
