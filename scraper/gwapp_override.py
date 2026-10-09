"""
Warhammer 40,000 app detachment layer (the newest published rules text; applied last by build_data.py, after
GrimSlate and the codex override, so it wins on every daily refresh).

scraper/overrides/gwapp_detachments.json (compiled by gwapp_compile.py from the app's detachment pages) replaces, for
every detachment the current MFM lists (matched by name, per faction; Space Marines also looks in the app's
Ultramarines / Imperial Fists / Iron Hands / Raven Guard / Salamanders / White Scars pages, and the allied
Daemon / Ynnari / Harlequins pages likewise, see EXTRA):
  * the detachment rule,
  * the stratagems (name, CP, phase, category, WHEN/TARGET/EFFECT),
  * the enhancement rules text (which also drives enhancement eligibility).
Points, DP, the detachment list, enhancement names/costs/upgrade flags and restrictions stay MFM.
"""
import difflib, json, os, re

import codex_override

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "overrides", "gwapp_detachments.json")
# app factions whose detachments Muster lists under another faction (the faction's own page always wins)
EXTRA = {"space-marines": ["ultramarines", "imperial-fists", "iron-hands", "raven-guard", "salamanders", "white-scars"],
         "aeldari": ["harlequins", "ynnari"], "death-guard": ["plague-legions"], "emperors-children": ["legions-of-excess"],
         "thousand-sons": ["scintillating-legions"], "world-eaters": ["blood-legions"]}
_cache = None


def load():
    global _cache
    if _cache is None:
        _cache = json.load(open(PATH, encoding="utf-8")) if os.path.exists(PATH) else {"factions": {}}
    return _cache


def key(s):
    s = (s or "").lower().replace("’", "'").replace("‘", "'")
    s = re.sub(r"\((?:upgrade|upgarde|aura|psychic)\)", "", s)
    return re.sub(r"[^a-z0-9]", "", s)


def det_index(fid):
    ov = load()["factions"]
    idx = {}
    for slug in EXTRA.get(fid, []) + [fid]:        # the faction's own page last = wins
        for d in ov.get(slug, []):
            idx[key(d["name"])] = d
    return idx


def find_enh(name, app_enh):
    k = key(name)
    by = {key(e["name"]): e for e in app_enh}
    if k in by:
        return by[k]
    best = difflib.get_close_matches(k, list(by), n=1, cutoff=0.85)
    return by[best[0]] if best else None


def rule(blocks, old_name):
    """[name, text]: the block named like the current rule (else the first named one) leads; the others follow as
    'Heading: text' (army-composition blocks such as 'Travelling Players' or 'Harlequins' included)."""
    named = [b for b in blocks if b[0] and b[0] != "Keywords"]
    lead = None
    if old_name:
        ks = [key(b[0]) for b in named]
        m = difflib.get_close_matches(key(old_name), ks, n=1, cutoff=0.8)
        if m:
            lead = named[ks.index(m[0])]
    lead = lead or (named[0] if named else None)
    parts = [lead[1]] if lead else []
    for b in blocks:
        if b is lead:
            continue
        parts.append(f"{b[0]}: {b[1]}" if b[0] else b[1])
    return [lead[0] if lead else (old_name or "Detachment rule"), "\n".join(p for p in parts if p)]


def stratagem(det_name, s, old_names):
    phase, turn = codex_override._phase_turn(s["text"])
    nm = s["name"]
    o = old_names.get(key(nm))
    if o and o != o.upper():       # keep the existing (non-shouting) spelling of the same name
        nm = o
    typ = f'{det_name} – {s["category"]} Stratagem' if s.get("category") else f"{det_name} Stratagem"
    return [nm, s["cp"], phase, typ, turn, s["text"]]


def apply(fid, dets, stats, report):
    idx = det_index(fid)
    if not idx:
        return
    rep = report.setdefault(fid, {"applied": [], "not_in_app": [], "enh_unmatched": [], "enh_cost_diff": [], "strat_cp_missing": []})
    names = {key(d["n"]) for d in dets}
    rep["app_only"] = sorted(d["name"] for k, d in det_index(fid).items()
                             if k not in names and fid in load()["factions"] and d in load()["factions"][fid])
    for cd in dets:
        a = idx.get(key(cd["n"]))
        if not a:
            rep["not_in_app"].append(cd["n"]); continue
        rep["applied"].append(cd["n"])
        stats["gwapp_detachments"] += 1
        if a.get("rule") and a["rule"]["blocks"]:
            cd["rule"] = rule(a["rule"]["blocks"], (cd.get("rule") or [None])[0])
        if a["stratagems"]:
            old = {key(s[0]): s[0] for s in cd.get("st") or []}
            st = []
            for s in a["stratagems"]:
                if s["cp"] is None:
                    rep["strat_cp_missing"].append(f'{cd["n"]}: {s["name"]}')
                    s = dict(s, cp=next((x[1] for x in cd.get("st") or [] if key(x[0]) == key(s["name"])), None))
                st.append(stratagem(cd["n"], s, old))
            cd["st"] = st
            stats["gwapp_stratagems"] += len(st)
        for en in cd.get("enh") or []:
            e = find_enh(en[0], a["enhancements"])
            if not e:
                rep["enh_unmatched"].append(f'{cd["n"]}: {en[0]}'); continue
            en[2] = e["text"]
            stats["gwapp_enhancements"] += 1
            if e["pts"] != en[1]:
                rep["enh_cost_diff"].append(f'{cd["n"]}: {en[0]} MFM {en[1]} vs app {e["pts"]} (MFM kept)')
        cd["ga"] = 1
