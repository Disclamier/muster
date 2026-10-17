"""Wargear options the secondary loadout data misses, from Wahapedia's data export (wh40k11ed/Datasheets_options.csv).

compile: downloads the export and writes overrides/wahapedia_options.json with, per faction and unit, the option lines
that the built loadout (app/data/points.json) cannot represent yet, translated into loadout slots:
  * "<model> can be equipped with N additional <item>"      -> optional slot "Additional <item>" (max N)
  * "<model> can be equipped with 1 <item> / one of: ..."   -> optional slot with those items (when none exists)
  * "<model>'s <item> can be replaced with 1 <a> / one of"  -> a swap slot (default = the replaced item) when the
                                                              replacements are missing and <item> is fixed gear
Counts: 'This model' / '1 model' / 'One ...' = 1; 'Up to N' = N; 'For every K models, (up to) M' = M per K models;
'Any number' / 'each' = every model. Lines that can't be mapped safely are listed under "skipped" for review.
apply: adds those slots at build time. Points never change (MFM stays authoritative).

  python3 scraper/wahapedia_options.py compile
"""
import csv, html, io, json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PATH = os.path.join(HERE, "overrides", "wahapedia_options.json")
BASE = "https://wahapedia.ru/wh40k11ed/"
csv.field_size_limit(10 ** 9)
N = lambda s: re.sub(r"[^a-z0-9]", "", str(s).lower().replace("’", "'"))
K = lambda s: N(s).rstrip("s")


def rd(name, cache=None):
    if cache and os.path.exists(os.path.join(cache, name)):
        raw = open(os.path.join(cache, name), encoding="utf-8-sig").read()
    else:
        raw = urllib.request.urlopen(urllib.request.Request(BASE + name, headers={"User-Agent": "Mozilla/5.0 Muster"}), timeout=60).read().decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(raw), delimiter="|"))


def items_list(rest):
    alt = bool(re.match(r"^\s*(?:one|1) of the following", rest.strip(), re.I))
    rest = re.sub(r"^\s*(?:one|1) of the following:?", "", rest.strip())
    if alt and ";" not in rest.strip(" ;"):   # 'one of the following: 1 A, 1 B' = alternatives
        rest = rest.replace(",", ";")
    out = []
    for part in rest.split(";"):
        part = part.strip(" .*")
        if not part:
            continue
        its = []
        for p in re.split(r",\s*|\s+and\s+(?=\d)", part):
            m = re.match(r"(\d+)\s+(.+)$", p.strip(" .*"))
            if not m or re.search(r"following|model|cannot|\(", m.group(2)):
                return None
            its.append([int(m.group(1)), m.group(2).strip(" .*")])
        if its:
            out.append(its)
    return out or None


def count_rule(who):
    w = who.lower()
    m = re.search(r"for every (\d+) models.*?(?:up to )?(\d+|one)", w)
    if m:
        return {"per": int(m.group(1)), "n": 1 if m.group(2) == "one" else int(m.group(2))}
    if re.search(r"any number|all models|every model|models in this unit can each", w):
        return {"each": True}
    m = re.search(r"up to (\d+)", w)
    if m:
        return {"n": int(m.group(1))}
    return {"n": 1}


def model_type(lo, who):
    ms = lo.get("m") or []
    if len(ms) == 1:
        return ms[0]
    w = N(who)
    c = [m for m in ms if K(m[0].split("(")[0]) and K(m[0].split("(")[0]) in w]
    if c:
        return max(c, key=lambda m: len(m[0]))
    # 'The Deathshroud Champion' ~ 'Deathshroud Terminator Champion': every word of the role in the type name
    words = [x for x in re.findall(r"[a-z]+", who.lower().replace("’s", "").replace("'s", "")) if x not in ("the", "this", "unit", "model", "s")]
    c = [m for m in ms if words and all(x.rstrip("s") in m[0].lower() for x in words[-2:])]
    if len(c) == 1:
        return c[0]
    if re.search(r"any number of models|for every \d+ models|up to \d+ models|^\d+ models?|^one model", who, re.I):
        base = [m for m in ms if not m[5] and (m[2] or 0) > 1]
        return base[0] if len(base) == 1 else None
    return None


def have_names(lo):
    s = set()
    for m in lo.get("m") or []:
        s |= {K(x) for x in m[3]}
        for sl in m[4]:
            s |= {K(o[0]) for o in sl[1]}
    for sl in lo.get("u") or []:
        s |= {K(o[0]) for o in sl[1]}
    return s


def known(name, have):
    k = K(name)
    return k in have or any(len(h) > 5 and (k in h or h in k) for h in have)


FAC = {"imperial-agents": "AoI", "astra-militarum": "AM", "genestealer-cults": "GC", "necrons": "NEC", "aeldari": "AE",
       "titan-legions": "TL", "chaos-titan-legions": "TL", "orks": "ORK", "grey-knights": "GK", "tau-empire": "TAU",
       "leagues-of-votann": "LoV", "adeptus-mechanicus": "AdM", "thousand-sons": "TS", "death-guard": "DG",
       "emperors-children": "EC", "world-eaters": "WE", "chaos-knights": "QT", "chaos-daemons": "CD", "imperial-knights": "QI",
       "space-marines": "SM", "tyranids": "TYR", "adeptus-custodes": "AC", "adepta-sororitas": "AS",
       "chaos-space-marines": "CSM", "drukhari": "DRU", "black-templars": "SM", "blood-angels": "SM", "dark-angels": "SM",
       "deathwatch": "SM", "space-wolves": "SM"}


def base_loadout(u, d, wargear, comp, lines):
    """A unit with no loadout at all (e.g. a datasheet that only exists in the GW app / new codex): one model type,
    size from the MFM tiers, default gear = the Wahapedia loadout line, else its wargear minus the items the options offer."""
    if len(comp) != 1:
        return None
    m = re.match(r"^\s*(\d+)(?:-(\d+))?\s+(.+?)(?:\s+models?)?\s*$", comp[0].strip())
    if not m:
        return None
    sizes = [c[0] for t in u.get("t") or [] for c in t[2] if isinstance(c[0], int)]
    lo_n, hi_n = (min(sizes), max(sizes)) if sizes else (int(m.group(1)), int(m.group(2) or m.group(1)))
    gear = []
    ld = re.sub(r"<[^>]+>", "", html.unescape(d.get("loadout") or ""))
    lm = re.search(r"equipped with:?\s*(.*)$", ld)
    if lm:
        for x in lm.group(1).split(";"):
            x = x.strip(" .")
            mc = re.match(r"^(\d+)\s+(.+)$", x)
            if x:
                gear += [mc.group(2)] * int(mc.group(1)) if mc else [x]
    if not gear:
        offered = set()
        for t in lines:
            mm = re.search(r"(?:replaced with|equipped with)(.*)$", t)
            if mm:
                for x in re.split(r"[;▫•]|\bone of the following:?", mm.group(1)):
                    x = re.sub(r"^\s*\d+\s+", "", x).strip(" .*")
                    if x:
                        offered.add(K(x))
        seen = []
        for w in wargear:
            b = re.split(r"\s+[–-]\s+", w)[0].strip()
            if b and K(b) not in offered and b not in seen:
                seen.append(b)
        gear = seen
    if not gear:
        return None
    bases = [re.split(r"\s+[–-]\s+", w)[0].strip() for w in wargear]
    sing = lambda x: re.sub(r"s$", "", re.sub(r"ies$", "y", N(x)))
    gear = [next((b for b in bases if sing(b) == sing(g) or K(b) == K(g)), g) for g in gear]   # '3 ardex-defensor maulers' -> profile name
    gear = [g[:1].upper() + g[1:] for g in gear]
    return {"m": [[u["n"], lo_n, hi_n, gear, [], None, None, 0]], "mn": lo_n, "mx": hi_n}


def compile_options(cache=None):
    P = json.load(open(os.path.join(ROOT, "app", "data", "points.json")))
    DS, OP = rd("Datasheets.csv", cache), rd("Datasheets_options.csv", cache)
    try:
        last = rd("Last_update.csv", cache)
    except Exception:
        last = []
    ops = {}
    for o in OP:
        ops.setdefault(o["datasheet_id"], []).append(re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ; ", o["description"]))).strip())
    WG = {}
    for w in rd("Datasheets_wargear.csv", cache):
        WG.setdefault(w["datasheet_id"], []).append(w["name"])
    COMP = {}
    for c in rd("Datasheets_unit_composition.csv", cache):
        COMP.setdefault(c["datasheet_id"], []).append(re.sub(r"<[^>]+>", "", c["description"]))
    by, anyn = {}, {}
    for d in DS:
        if d.get("virtual") == "true":
            continue
        by.setdefault((d["faction_id"], N(d["name"])), d)
        anyn.setdefault(N(d["name"]), []).append(d)
    prev = json.load(open(PATH)) if os.path.exists(PATH) else {"factions": {}}
    out, skipped, n = {}, [], 0
    # every Muster unit (every faction, incl. chapter/ally copies) gets the option lines of ITS faction's Wahapedia datasheet
    pairs = []
    for f in P["factions"]:
        for u in f["units"]:
            k = N(re.sub(r"\s*\[Legends\]", "", u["n"].replace("\u2011", "-")))
            if f["id"] == "chaos-titan-legions":
                k = re.sub(r"^chaos", "", k)
            d = by.get((FAC.get(f["id"]), k)) or (anyn[k][0] if len(anyn.get(k, [])) == 1 else None)
            if d:
                pairs.append((d, f["id"], u))
    for d, fid, u in pairs:
        if True:
            lo = u.get("lo") or {}
            if not lo.get("m"):
                lo = base_loadout(u, d, WG.get(d["id"], []), COMP.get(d["id"], []), ops.get(d["id"], []))
                if not lo:
                    continue
                out.setdefault(fid, {}).setdefault(u["n"], []).append({"base": lo, "text": "base loadout (Wahapedia wargear/composition)"})
                lo = json.loads(json.dumps(lo)); n += 1
            have = have_names(lo)
            for t in ops.get(d["id"], []):
                patch = None
                m = re.search(r"^(.*?) can (?:each )?be equipped with (\d|one|two) additional ([^.;*]+)", t)
                if m:
                    mt = model_type(lo, m.group(1))
                    cnt = {"one": 1, "two": 2}.get(m.group(2), None) or int(m.group(2))
                    item = m.group(3).strip()
                    if mt and (known(item, {K(x) for x in mt[3]}) or known(item, {K(o[0]) for s in mt[4] for o in s[1]})):
                        patch = {"model": mt[0], "slot": "Additional " + item, "opts": [[item, cnt]], "count": count_rule(m.group(1)), "max_each": cnt}
                else:
                    m = re.search(r"^(.*?)(?:’s|'s) (.+?) can be replaced with (.*)$", t) or re.search(r"^(.*?) can (?:each )?have (?:their|its) (.+?) replaced with (.*)$", t)
                    if m:
                        who, rep, rest = m.groups()
                        lst = items_list(rest)
                        mt = model_type(lo, who)
                        if lst and mt and not all(all(known(x[1], have) for x in o) for o in lst):
                            fixed = [x for x in mt[3] if K(x) == K(rep)]
                            if fixed:
                                patch = {"model": mt[0], "swap": fixed[0], "slot": rep[:1].upper() + rep[1:],
                                         "opts": [[" + ".join(x[1] for x in o), None] for o in lst], "count": count_rule(who)}
                    else:
                        m = re.search(r"^(.*?) can (?:each )?be equipped with (.*)$", t)
                        if m:
                            lst = items_list(m.group(2))
                            mt = model_type(lo, m.group(1))
                            if lst and mt and not any(all(known(x[1], have) for x in o) for o in lst):
                                patch = {"model": mt[0], "slot": " / ".join(" + ".join(x[1] for x in o) for o in lst)[:60],
                                         "opts": [[" + ".join(x[1] for x in o), None] for o in lst], "count": count_rule(m.group(1))}
                if patch and any(x.get("text") == t for x in out.get(fid, {}).get(u["n"], [])):
                    patch = None
                if patch:
                    patch["text"] = t
                    out.setdefault(fid, {}).setdefault(u["n"], []).append(patch); n += 1
                elif m and not (lst if "lst" in dir() else None):
                    pass
    for fid, us in prev.get("factions", {}).items():
        for un, ps in us.items():
            cur = out.setdefault(fid, {}).setdefault(un, [])
            for p in ps:
                if not any(x.get("text") == p.get("text") for x in cur):
                    cur.append(p)
    json.dump({"note": __doc__.strip().split("\n")[0], "source": BASE + "Datasheets_options.csv",
               "wahapedia_updated": last[0].get("last_update") if last else None, "factions": out}, open(PATH, "w"), indent=1, ensure_ascii=False)
    return n


def apply(fid, units, stats):
    if not os.path.exists(PATH):
        return
    ov = json.load(open(PATH))["factions"].get(fid) or {}
    for u in units:
        for p in ov.get(u["n"], []):
            if "base" in p:
                if not (u.get("lo") or {}).get("m"):
                    u["lo"] = json.loads(json.dumps(p["base"]))
                    stats["wahapedia_base_loadouts"] = stats.get("wahapedia_base_loadouts", 0) + 1
                continue
            lo = u.get("lo") or {}
            mt = next((m for m in lo.get("m") or [] if m[0] == p["model"]), None)
            if not mt or any(s[0] == p["slot"] for s in mt[4]):
                continue
            c = p["count"]
            if c.get("each"):
                omax, mas = None, None
            elif c.get("per"):
                omax, mas = c["n"], [[c["per"] * j, c["n"] * j] for j in range(2, 5)]
            else:
                omax, mas = c["n"], None
            if p.get("swap"):
                if p["swap"] not in mt[3]:
                    continue
                mt[3].remove(p["swap"])
                opts = [[p["swap"], None, None, None, None]] + [[o[0], omax, None, None, mas] for o in p["opts"]]
                mt[4].append([p["slot"], opts, [p["swap"]], 1, 1, 0])
            else:
                each = p.get("max_each") or 1
                opts = [[o[0], omax * (o[1] or 1) if omax else None, None, None, mas] for o in p["opts"]]
                mt[4].append([p["slot"], opts, [], 0, each, 1])
            # MFM per-item priced wargear (u["w"], e.g. Black Templars "Multi-melta +10") is charged when picked
            wi = {N(w[0]): i for i, w in enumerate(u.get("w") or [])}
            for o in mt[4][-1][1]:
                if o[3] is None and N(o[0]) in wi:
                    o[3] = wi[N(o[0])]; stats["wahapedia_option_costs"] = stats.get("wahapedia_option_costs", 0) + 1
            stats["wahapedia_option_slots"] = stats.get("wahapedia_option_slots", 0) + 1


if __name__ == "__main__":
    if sys.argv[1] == "compile":
        print(compile_options(sys.argv[2] if len(sys.argv) > 2 else None), "option slots ->", PATH)
