"""
Codex override layer (applied by build_data.py on top of GrimSlate; MFM points always win).

POINTS SOURCE (James's rule): the Munitorum Field Manual is the only points source for every faction, Space Marines
and chapters included: unit costs, wargear costs, enhancement points and detachment DP. This layer never touches
points (the transcribed codex has none); it only replaces datasheets, loadout options, rules and text.

scraper/overrides/space_marines_codex.json (compiled by codex_parse.py from the transcribed codex) replaces, for the
Adeptus Astartes factions listed in its "factions" field:
  * datasheets (stats, weapons, abilities, keywords, composition, wargear options) of units with the same name
    (in the non-home factions only generic ADEPTUS ASTARTES units, never chapter-specific ones),
  * the loadout picker of those units (rebuilt from the codex composition + wargear options),
  * detachment rule, stratagems and enhancement rules text of detachments with the same name
    (detachment points, enhancement names/points/upgrade flags and restrictions stay MFM),
  * army rules (added to the faction rules shown on datasheets).
"""
import itertools, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OVERRIDES = [os.path.join(HERE, "overrides", "space_marines_codex.json")]

# keywords the app's rules logic depends on (roles, enhancement eligibility): kept from the previous data when the
# printed codex keyword line lacks them (e.g. a misprint), so no unit silently loses eligibility
KEEP_KW = {"character", "epic hero", "battleline", "dedicated transport", "captain", "chapter master", "lieutenant",
           "chaplain", "librarian", "ancient", "apothecary", "techmarine", "judiciar", "psyker"}


def norm(s):
    s = (s or "").lower().replace("’", "'").replace("‘", "'")
    return re.sub(r"[^a-z0-9]", "", s)


def enh_key(n):
    return norm(re.sub(r"\((?:upgrade|aura)\)", "", n or "", flags=re.I))


def load():
    out = []
    for p in OVERRIDES:
        if os.path.exists(p):
            out.append(json.load(open(p, encoding="utf-8")))
    return out


# ------------------------------------------------------------------------------------------------ loadouts
def _items(s):
    """'1 Thunder Hammer and 1 Relic Shield' -> ['Thunder Hammer', 'Relic Shield'] (count >1 kept as 'N x')."""
    s = re.sub(r"\s*\([^)]*\)", "", s).strip().rstrip(".")
    out = []
    for part in re.split(r"\s+and\s+(?=\d+\s)|\s*;\s*", s):
        m = re.match(r"^(?:(\d+)\s+)?(.+)$", part.strip())
        if not m or not m.group(2).strip():
            return None
        out += [m.group(2).strip()] * int(m.group(1) or 1)
    return out


def _options(s):
    s = re.sub(r"^one of the following:\s*", "", s.strip())
    opts = []
    for o in s.split(";"):
        it = _items(o)
        if not it:
            return None
        opts.append(it)
    return opts


def _replaced(s, known):
    s = s.strip()
    if norm(s) in known:
        return [s]
    parts = [p.strip() for p in re.split(r"\s+and\s+", s)]
    return parts


def codex_loadout(ds, wargear_costs):
    """codex composition + wargear options -> compact loadout (see core.js loModel). Returns (lo, unparsed lines)."""
    types, notes = [], []
    for c in ds["composition"]:
        m = re.match(r"^(\d+)(?:-(\d+))?\s+(.+?)\s+models?$", c)
        if m:
            types.append({"name": m.group(3), "min": int(m.group(1)), "max": int(m.group(2) or m.group(1)), "fixed": [], "rules": [], "add": []})
    if not types:
        return None, ["no composition"]
    unit_slots = []
    total_max = sum(t["max"] for t in types)

    def tn(t):
        return norm(t["name"]).rstrip("s")

    def find_types(phrase):
        p = re.sub(r"^(the|every|all|any number of|this|up to \d+|\d+)\s+", "", phrase.strip(), flags=re.I)
        p = re.sub(r"^(up to \d+|\d+)\s+", "", p, flags=re.I)
        p = re.sub(r"\s*(models?|in this unit)\s*$", "", p, flags=re.I).strip()
        p = re.sub(r"\s*(models?|in this unit)\s*$", "", p, flags=re.I).strip()
        if not p or norm(p) in ("model", "unit"):
            return list(types)
        k = norm(p).rstrip("s")
        return [t for t in types if tn(t) == k]

    for c in ds["composition"]:
        m = re.match(r"^(.+?) (?:is|are) equipped with:\s*(.+)$", c)
        if not m:
            continue
        who, gear = m.group(1), _items(m.group(2))
        if gear is None:
            notes.append(c); continue
        tt = list(types) if re.match(r"^(every model|this model|all models)$", who, re.I) else find_types(who)
        if not tt:
            notes.append(c); continue
        for t in tt:
            t["fixed"] += gear

    def per_n(n, k):
        """'for every n models, k ...' -> (max, max_at_size)"""
        mas = [[n * i, k * i] for i in range(2, total_max // n + 1)]
        return k, (mas or None)

    pending = list(ds["wargear_options"])
    for _pass in range(2):  # 2nd pass: options that replace gear only reachable through a later line
      lines, pending, notes_before = pending, [], len(notes)
      for line in lines:
        L = line.strip()
        known = {norm(x) for t in types for x in t["fixed"]}
        m = re.match(r"^If this model is equipped with .+?, it can be equipped with (.+?)(?:\s*\(.*\))?\.$", L)
        if m and len(types) == 1:
            types[0]["add"].append((_options(m.group(1)), None, None, L)); continue
        m = re.match(r"^This (model|unit) can be equipped with (.+?)\.$", L)
        if m:
            opts = _options(m.group(2))
            if opts:
                if m.group(1) == "unit" or len(types) > 1:
                    unit_slots.append((opts, L))
                else:
                    types[0]["add"].append((opts, None, None, L))
                continue
        m = re.match(r"^1 model can be equipped with (.+?)\.$", L)
        if m and _options(m.group(1)):
            unit_slots.append((_options(m.group(1)), L)); continue
        m = re.match(r"^For every (\d+) models in this unit, (?:up to )?(\d+) (.+?) can (?:each )?be equipped with (.+?)\.$", L)
        if m:
            tt, opts = find_types(m.group(3)), _options(m.group(4))
            if tt and opts:
                mx, mas = per_n(int(m.group(1)), int(m.group(2)))
                for t in tt:
                    t["add"].append((opts, mx, mas, L))
                continue
        rep = None
        m = re.match(r"^This model's (.+?) can be replaced with (.+?)\.$", L)
        if m:
            rep = (types if len(types) == 1 else [], m.group(1), m.group(2), None, None)
        m = m or None
        if not rep:
            m = re.match(r"^The (.+?) can have their (.+?) replaced with (.+?)\.$", L)
            if m:
                rep = (find_types(m.group(1)), m.group(2), m.group(3), 1, None)
                rep = (rep[0], rep[1], rep[2], None, None)
        if not rep:
            m = re.match(r"^For every (\d+) models in this unit, (?:up to )?(\d+) (.*?)can (?:each )?have their (.+?) replaced with (.+?)\.$", L)
            if m:
                mx, mas = per_n(int(m.group(1)), int(m.group(2)))
                rep = (find_types(m.group(3) or "model"), m.group(4), m.group(5), mx, mas)
        if not rep:
            m = re.match(r"^(?:Any number of|All) (.*?)can each have their (.+?) replaced with (.+?)\.$", L)
            if m:
                rep = (find_types(m.group(1) or "models"), m.group(2), m.group(3), None, None)
        if rep:
            tt, what, opts_s, mx, mas = rep
            R, opts = _replaced(what, known), _options(opts_s)
            def has(t, r):  # in the starting gear, or reachable through an earlier option on this model
                return any(norm(x) == norm(r) for x in t["fixed"]) or any(norm(i) == norm(r) for rr in t["rules"] for o in rr[1] for i in o)
            tt = [t for t in tt if all(has(t, r) for r in R)] if R else []
            if tt and opts:
                for t in tt:
                    t["rules"].append((tuple(R), opts, mx, mas, L))
                continue
        (pending if _pass == 0 else notes).append(L)

    wn = [norm(w["name"]) for w in wargear_costs or []]

    def widx(names):
        for n in names:
            if norm(n) in wn:
                return wn.index(norm(n))
        return None

    def opt(name, mx, names, mas):
        """[name, max, text, wIdx, maxAtSize(, count)]: count = copies of the MFM-priced item one pick gives
        (e.g. '2 Multi-meltas' -> 2 x the per-item cost)."""
        i = widx(names)
        o = [name, mx, None, i, mas]
        n = sum(1 for x in names if i is not None and norm(x) == wn[i])
        if n > 1:
            o.append(n)
        return o

    J = " + ".join

    def build_slots(t):
        slots, comps = [], []
        fixed_n = [norm(x) for x in t["fixed"]]
        for r in t["rules"]:  # group rules whose replaced items overlap (directly or through a chained option)
            hit = [c for c in comps if {norm(x) for x in r[0]} & {norm(i) for rr in c for i in list(rr[0]) + [y for o in rr[1] for y in o]}]
            merged = [x for c in hit for x in c] + [r]
            comps = [c for c in comps if c not in hit] + [merged]
        for comp in comps:
            comp = sorted(comp, key=lambda r: t["rules"].index(r))
            U = []
            for r in comp:
                for x in r[0]:
                    if norm(x) in fixed_n and x not in U:
                        U.append(x)
            if not U:
                continue
            for x in U:
                t["fixed"].remove(next(y for y in t["fixed"] if norm(y) == norm(x)))
            opts = {J(U): opt(J(U), None, U, None)}
            if len({r[0] for r in comp}) == 1 and set(comp[0][0]) == set(U):
                for r in comp:
                    for o in r[1]:
                        k = J(o)
                        cur = opts.get(k)
                        if cur is None:
                            opts[k] = opt(k, r[2], o, r[3])
                        elif cur[1] is not None and (r[2] is None or r[2] > cur[1]):
                            cur[1], cur[4] = r[2], r[3]
            else:  # overlapping / chained replacements on one model: every reachable combination is one choice
                configs = [list(U)]
                for _ in range(3):
                    for r in comp:
                        for c in list(configs):
                            if all(sum(1 for y in c if norm(y) == norm(x)) for x in r[0]):
                                for o in r[1]:
                                    n = list(c)
                                    for x in r[0]:
                                        n.remove(next(y for y in n if norm(y) == norm(x)))
                                    n += list(o)
                                    if n not in configs and len(configs) < 60:
                                        configs.append(n)
                for c in configs[1:]:
                    opts.setdefault(J(c), opt(J(c), None, c, None))
            slots.append([J(U), list(opts.values()), [J(U)], 1, 1, 0])
        for x in list(t["fixed"]):
            if widx([x]) is not None:
                t["fixed"].remove(x)
                slots.append([x, [[x, None, None, widx([x]), None]], [x], 1, 1, 0])
        for opts, mx, mas, _L in t["add"]:
            if not opts:
                continue
            nm = opts[0][0] if len(opts) == 1 else "Optional wargear"
            slots.append([nm, [opt(J(o), mx, o, mas) for o in opts], [], 0, 1, 1])
        return slots

    m_out = []
    for t in types:
        m_out.append([t["name"], t["min"], t["max"], [], [], None, None, 0])
    for t, row in zip(types, m_out):
        row[4] = build_slots(t)
        row[3] = list(t["fixed"])
    lo = {"m": m_out}
    if unit_slots:
        lo["u"] = [[(opts[0][0] if len(opts) == 1 else "Optional wargear"), [opt(J(o), 1 if re.match(r"^1 model", L) else None, o, None) for o in opts], [], 0, 1, 1]
                   for opts, L in unit_slots]
    lo["mn"] = sum(t["min"] for t in types)
    lo["mx"] = total_max
    return lo, notes


# ------------------------------------------------------------------------------------------------ datasheets
def compact(ds, old=None):
    """codex datasheet -> app compact datasheet (see build_data.compact_ds) + codex-only keys:
    sx extra statlines, ps psychic abilities, wo wargear options text, comp composition text, fkw faction keywords."""
    out = {"s": dict(ds["stats"]),
           "ab": [list(a) for a in ds["abilities"]],
           "wa": [[a[0], a[0], a[1]] for a in ds["wargear_abilities"]],
           "cr": list(ds["core"]),
           "fa": list(ds["army"]),
           "wp": [[w[0], w[1], [list(p) for p in w[2]]] for w in ds["weapons"]],
           "ml": [],
           "src": "codex"}
    if ds.get("inv"):
        out["inv"] = ds["inv"]
    if ds.get("transport"):
        out["tr"] = ds["transport"]
    if ds.get("extra_stats"):
        out["sx"] = [[m, s, inv] for m, s, inv in ds["extra_stats"]]
    if ds.get("psychic"):
        out["ps"] = [list(a) for a in ds["psychic"]]
    if ds.get("wargear_options"):
        out["wo"] = list(ds["wargear_options"])
    if ds.get("composition"):
        out["comp"] = list(ds["composition"])
    if ds.get("model_keywords"):
        out["kwm"] = [list(x) for x in ds["model_keywords"]]
    if ds.get("faction_keywords"):
        out["fkw"] = list(ds["faction_keywords"])
    return out


def _phase_turn(text):
    when = next((l[5:].strip() for l in text.split("\n") if l.startswith("WHEN:")), "")
    clause = when.split(",")[0]
    c = clause.lower()
    ph = []
    for p in re.findall(r"(command|movement|shooting|charge|fight) phase", c):
        if p.title() + " phase" not in ph:
            ph.append(p.title() + " phase")
    if not ph:
        if re.search(r"deploy|battle formations|start of the battle", c):
            ph = ["Deployment"]
        elif "battle round" in c:
            ph = ["Start of battle round"]
    opp = re.search(r"opponent'?s", c)
    mine = re.search(r"\byour (command|movement|shooting|charge|fight)", c) or c.startswith("end of your ") and not opp
    if opp and " or the " not in c and not mine:
        turn = "Opponent's turn"
    elif mine and not opp and " or the " not in c:
        turn = "Your turn"
    else:
        turn = "Either player's turn"
    return " or ".join(ph) or None, turn


def stratagem(det_name, s):
    phase, turn = _phase_turn(s["text"])
    return [s["name"], s["cp"], phase, f"{det_name} Stratagem", turn, s["text"]]


def _compact_det_rule(d):
    return [d["rule"]["name"], d["rule"]["text"]] if d.get("rule") else None


def apply(fid, units, dets, f_ds, rules, wargear_by_unit, stats, report, role_fn):
    """Mutates units (kw, r, lo), dets (rule, st, enh text), f_ds (datasheets) and rules for faction `fid`."""
    for ov in load():
        if fid not in ov.get("factions", []):
            continue
        home = fid == ov.get("home_faction")
        rep = report.setdefault(fid, {"datasheets": [], "skipped_chapter_units": [], "detachments": [], "enh_missing_in_mfm": [],
                                      "enh_missing_in_codex": [], "upgrade_flag_diff": [], "unique_diff": [], "role_changes": [],
                                      "kw_kept": [], "loadout_notes": {}, "unmatched_codex_units": []})
        by = {norm(d["name"]): d for d in ov["datasheets"]}
        matched = set()
        for u in units:
            d = by.get(norm(u["n"]))
            if not d:
                continue
            generic = [norm(x) for x in d["faction_keywords"]] == ["adeptusastartes"]
            if not home and (not generic or norm(u.get("fk") or "") not in ("", "adeptusastartes")):
                rep["skipped_chapter_units"].append(u["n"]); continue
            matched.add(norm(d["name"]))
            old_kw = u.get("kw") or []
            kw = list(d["keywords"])
            for _m, mk in d.get("model_keywords") or []:
                kw += [k for k in mk if k.lower() != "epic hero" and k not in kw]
            have = {k.lower() for k in kw}
            kept = [k for k in old_kw if k.lower() in KEEP_KW and k.lower() not in have]
            if kept:
                rep["kw_kept"].append(f'{u["n"]}: {", ".join(kept)}')
            u["kw"] = kw + kept
            new_r = role_fn(u["kw"], u["n"], u.get("ldr"))
            if new_r != u["r"]:
                rep["role_changes"].append(f'{u["n"]}: {u["r"]} -> {new_r}')
                u["r"] = new_r
            lo, notes = codex_loadout(d, wargear_by_unit.get(u["n"]))
            if lo:
                u["lo"] = lo
            else:
                u.pop("lo", None)
            if notes:
                rep["loadout_notes"][u["n"]] = notes
            u["cx"] = 1
            f_ds[u["n"]] = compact(d, f_ds.get(u["n"]))
            rep["datasheets"].append(u["n"])
            stats["codex_datasheets"] += 1
        rep["unmatched_codex_units"] = [d["name"] for d in ov["datasheets"] if norm(d["name"]) not in matched] if home else []
        dby = {norm(d["name"]): d for d in ov["detachments"]}
        for cd in dets:
            od = dby.get(norm(cd["n"]))
            if not od:
                continue
            rep["detachments"].append(cd["n"])
            stats["codex_detachments"] += 1
            if od.get("rule"):
                cd["rule"] = _compact_det_rule(od)
            cd["st"] = [stratagem(cd["n"], s) for s in od["stratagems"]]
            stats["codex_stratagems"] += len(cd["st"])
            oe = {enh_key(e["name"]): e for e in od["enhancements"]}
            seen = set()
            for en in cd["enh"]:
                e = oe.get(enh_key(en[0]))
                if not e:
                    rep["enh_missing_in_codex"].append(f'{cd["n"]}: {en[0]}'); continue
                seen.add(enh_key(en[0]))
                en[2] = e["text"]
                stats["codex_enhancements"] += 1
                if bool(e["upgrade"]) != bool(en[3]):
                    rep["upgrade_flag_diff"].append(f'{cd["n"]}: {en[0]} (codex upgrade={e["upgrade"]}, MFM={bool(en[3])})')
            for k, e in oe.items():
                if k not in seen:
                    rep["enh_missing_in_mfm"].append(f'{cd["n"]}: {e["name"]}')
            mu = [r for r in cd.get("rs", []) if r.upper().startswith("UNIQUE")]
            cu = [f'UNIQUE: {od["unique"].upper()}'] if od.get("unique") else []
            if [x.upper() for x in mu] != cu:
                rep["unique_diff"].append(f'{cd["n"]}: MFM {mu or "-"} vs codex {cu or "-"}')
            cd["cx"] = 1
        have = {norm(r[0]) for r in rules}
        new = [[r["name"], r["text"]] for r in ov["army_rules"] if norm(r["name"]) not in have]
        rules[:0] = new
        stats["codex_army_rules"] += len(new)
