#!/usr/bin/env python3
"""
Codex override compiler: transcribed codex text (scraper/overrides/<name>/*.txt) -> scraper/overrides/<name>.json

The Space Marines 11th-edition codex arrived as an image-only scan, so it was transcribed (OCR + manual check against
the page images) into a small line-oriented format:

  ## ARMYRULE <name>            army rule; following lines = text
  ## DET <name>                 detachment
     UNIQUE <tag>               detachment uniqueness tag (informational; MFM restrictions stay authoritative)
     RULE <name>                detachment rule; following lines = text
     ENH <name> [| upgrade]     enhancement; following lines = text
     STRAT <name> | <cp>        stratagem; following lines = WHEN:/TARGET:/EFFECT:/RESTRICTIONS: text
  ## DS <name>                  datasheet
     STATS M T Sv W Ld OC | <invuln>
     SX <model> | M T Sv W Ld OC | <invuln>     extra model statline
     R <weapon>[ - <profile>] | <range> A BS S AP D | kw, kw     ranged weapon profile
     M <weapon>[ - <profile>] | Melee A WS S AP D | kw, kw      melee weapon profile
     CORE a, b   ARMY a, b      core abilities / army (faction) rules
     AB <name>: <text>          datasheet ability ("(Aura)" in the name marks an aura)
     PSY <name>: <text>         psychic ability
     WA <name>: <text>          wargear ability
     TRANS <text>  WO <text>  COMP <text>
     KW a; b   FKW a; b         keywords / faction keywords
Lines that start with none of the tags continue the previous entry (bullets "■ ..." included).
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))


def split_weapon(name):
    m = re.match(r"^(.*?)\s+-\s+(.+)$", name)
    return (m.group(1).strip(), m.group(2).strip()) if m else (name.strip(), None)


def parse_stats(s):
    parts = [p.strip() for p in s.split("|")]
    v = parts[0].split()
    if len(v) != 6:
        raise ValueError(f"bad statline: {s!r}")
    st = dict(zip(["M", "T", "SV", "W", "LD", "OC"], v))
    inv = parts[1] if len(parts) > 1 and parts[1] else None
    return st, inv


def parse_profile(rest, kind):
    body, _, kws = rest.partition("|")
    body = body.strip()
    if kind == "m":
        if not body.startswith("Melee"):
            raise ValueError(f"melee profile without 'Melee': {rest!r}")
        rng, vals = "Melee", body[len("Melee"):].split()
    else:
        tok = body.split()
        rng, vals = tok[0], tok[1:]
    if len(vals) != 5:
        raise ValueError(f"bad weapon profile: {rest!r}")
    a, sk, s, ap, d = vals
    kw = [k.strip() for k in kws.split(",") if k.strip()]
    return [rng, a, sk, s, ap, d, kw]


def name_text(s):
    n, sep, t = s.partition(":")
    return (n.strip(), t.strip()) if sep else (s.strip(), "")


def compile_dir(src):
    out = {"army_rules": [], "detachments": [], "datasheets": []}
    cur = None      # current block dict
    last = None     # list that receives continuation lines: [container, index-or-key]

    def cont(line):
        if last is None:
            raise ValueError(f"orphan line: {line!r}")
        obj, key = last
        obj[key] = (obj[key] + "\n" + line) if obj[key] else line

    for fn in sorted(os.listdir(src)):
        if not fn.endswith(".txt"):
            continue
        for ln, raw in enumerate(open(os.path.join(src, fn), encoding="utf-8"), 1):
            line = raw.rstrip("\n").strip()
            if not line:
                continue
            try:
                tag, _, rest = line.partition(" ")
                rest = rest.strip()
                if line.startswith("## "):
                    kind, _, name = line[3:].partition(" ")
                    name = name.strip()
                    if kind == "ARMYRULE":
                        cur = {"name": name, "text": ""}
                        out["army_rules"].append(cur)
                        last = (cur, "text")
                    elif kind == "DET":
                        cur = {"name": name, "unique": None, "rule": None, "enhancements": [], "stratagems": []}
                        out["detachments"].append(cur)
                        last = None
                    elif kind == "DS":
                        cur = {"name": name, "stats": None, "inv": None, "extra_stats": [], "weapons": [], "core": [],
                               "army": [], "abilities": [], "psychic": [], "wargear_abilities": [], "transport": None,
                               "wargear_options": [], "composition": [], "keywords": [], "faction_keywords": [],
                               "src": fn}
                        out["datasheets"].append(cur)
                        last = None
                    else:
                        raise ValueError(f"unknown block {kind}")
                    continue
                if cur is None:
                    raise ValueError("line outside a block")
                if "enhancements" in cur:  # detachment
                    if tag == "UNIQUE":
                        cur["unique"] = rest; last = None
                    elif tag == "RULE":
                        cur["rule"] = {"name": rest, "text": ""}; last = (cur["rule"], "text")
                    elif tag == "ENH":
                        n, _, flag = rest.partition("|")
                        e = {"name": n.strip(), "upgrade": flag.strip().lower() == "upgrade", "text": ""}
                        cur["enhancements"].append(e); last = (e, "text")
                    elif tag == "STRAT":
                        n, _, cp = rest.rpartition("|")
                        s = {"name": n.strip(), "cp": int(cp.strip()), "text": ""}
                        cur["stratagems"].append(s); last = (s, "text")
                    else:
                        cont(line)
                    continue
                if "weapons" not in cur:  # army rule
                    cont(line)
                    continue
                ds = cur
                if tag == "STATS":
                    ds["stats"], ds["inv"] = parse_stats(rest); last = None
                elif tag == "SX":
                    model, _, st = rest.partition("|")
                    s, inv = parse_stats(st)
                    ds["extra_stats"].append([model.strip(), s, inv]); last = None
                elif tag in ("R", "M"):
                    nm, _, prof = rest.partition("|")
                    wn, pn = split_weapon(nm)
                    kind = "r" if tag == "R" else "m"
                    p = [pn] + parse_profile(prof, kind)
                    w = next((x for x in ds["weapons"] if x[0] == wn and x[1] == kind), None)
                    if w is None:
                        w = [wn, kind, []]; ds["weapons"].append(w)
                    w[2].append(p); last = None
                elif tag == "CORE":
                    ds["core"] += [x.strip() for x in rest.split(",") if x.strip()]; last = None
                elif tag == "ARMY":
                    ds["army"] += [x.strip() for x in rest.split(",") if x.strip()]; last = None
                elif tag in ("AB", "PSY", "WA"):
                    n, t = name_text(rest)
                    lst = {"AB": "abilities", "PSY": "psychic", "WA": "wargear_abilities"}[tag]
                    ds[lst].append([n, t]); last = (ds[lst][-1], 1)
                elif tag == "TRANS":
                    ds["transport"] = rest; last = (ds, "transport")
                elif tag == "WO":
                    ds["wargear_options"].append(rest); last = (ds["wargear_options"], len(ds["wargear_options"]) - 1)
                elif tag == "COMP":
                    ds["composition"].append(rest.lstrip("■ ").strip() if rest.startswith("■") else rest)
                    last = (ds["composition"], len(ds["composition"]) - 1)
                elif tag == "KW":
                    # "All models: A; B | Chapter Ancient: C; D" -> keywords (all models) + per-model keywords
                    for seg in rest.split("|"):
                        who, sep, kws = seg.partition(":")
                        if not sep:
                            who, kws = "All models", seg
                        lst = [x.strip() for x in kws.split(";") if x.strip()]
                        if who.strip().lower() == "all models":
                            ds["keywords"] = lst
                        else:
                            ds.setdefault("model_keywords", []).append([who.strip(), lst])
                    last = None
                elif tag == "FKW":
                    ds["faction_keywords"] = [x.strip() for x in rest.split(";") if x.strip()]; last = None
                else:
                    cont(line)
            except Exception as e:  # noqa: BLE001
                raise SystemExit(f"{fn}:{ln}: {e}\n  {line}")
    return out


def validate(data):
    errs = []
    names = set()
    for d in data["datasheets"]:
        if d["name"] in names:
            errs.append(f"duplicate datasheet {d['name']}")
        names.add(d["name"])
        if not d["stats"]:
            errs.append(f"{d['name']}: no statline")
        if not d["keywords"] or not d["faction_keywords"]:
            errs.append(f"{d['name']}: missing keywords")
        for w in d["weapons"]:
            for p in w[2]:
                if not re.fullmatch(r'(\d+"|Melee)', p[1]):
                    errs.append(f"{d['name']}: {w[0]} range {p[1]}")
                if not re.fullmatch(r"(\d+|D\d(\+\d+)?|\dD\d)", p[2]):
                    errs.append(f"{d['name']}: {w[0]} A {p[2]}")
                if not re.fullmatch(r"([2-6]\+|N/A)", p[3]):
                    errs.append(f"{d['name']}: {w[0]} skill {p[3]}")
                if not re.fullmatch(r"\d+", p[4]):
                    errs.append(f"{d['name']}: {w[0]} S {p[4]}")
                if not re.fullmatch(r"(0|-\d)", p[5]):
                    errs.append(f"{d['name']}: {w[0]} AP {p[5]}")
                if not re.fullmatch(r"(\d+|D\d(\+\d+)?|\dD\d)", p[6]):
                    errs.append(f"{d['name']}: {w[0]} D {p[6]}")
        st = d["stats"] or {}
        for k, rx in (("M", r'(\d+"|-)'), ("T", r"\d+"), ("SV", r"[2-6]\+"), ("W", r"\d+"), ("LD", r"[4-9]\+"), ("OC", r"(\d+|-)")):
            if st and not re.fullmatch(rx, st.get(k, "")):
                errs.append(f"{d['name']}: stat {k}={st.get(k)}")
    for d in data["detachments"]:
        if not d["rule"]:
            errs.append(f"{d['name']}: no detachment rule")
        for s in d["stratagems"]:
            if not all(x in s["text"] for x in ("WHEN:", "TARGET:", "EFFECT:")):
                errs.append(f"{d['name']}: stratagem {s['name']} missing WHEN/TARGET/EFFECT")
            if not 0 <= s["cp"] <= 3:
                errs.append(f"{d['name']}: stratagem {s['name']} cp {s['cp']}")
    return errs


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "space_marines_codex"
    src = os.path.join(HERE, "overrides", name)
    data = compile_dir(src)
    errs = validate(data)
    if errs:
        raise SystemExit("validation failed:\n  " + "\n  ".join(errs))
    meta = json.load(open(os.path.join(src, "meta.json"))) if os.path.exists(os.path.join(src, "meta.json")) else {}
    data = {**meta, **data}
    dst = os.path.join(HERE, "overrides", f"{name}.json")
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"{dst}: {len(data['army_rules'])} army rules, {len(data['detachments'])} detachments "
          f"({sum(len(d['stratagems']) for d in data['detachments'])} stratagems, "
          f"{sum(len(d['enhancements']) for d in data['detachments'])} enhancements), {len(data['datasheets'])} datasheets",
          file=sys.stderr)


if __name__ == "__main__":
    main()
