"""Datasheets from the Warhammer 40,000 app (via 40k.app unit pages) as a committed override.

The secondary rules source still carries pre-codex profiles for chapter-specific units (e.g. Dark Angels: Lion El'Jonson
T9/W10, S4 Pistol bolt weapons) that the Space Marines codex override does not cover. This layer replaces stats,
invulnerable save, weapons, unit/wargear abilities, core/faction abilities and wargear-option text of units with the
same name, for the factions listed in overrides/gwapp_datasheets.json. Points are untouched (MFM stays authoritative).

  python3 scraper/gwapp_datasheets.py compile <faction-id> <dir of 40k.app unit page texts> [version]
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "overrides", "gwapp_datasheets.json")
VAL = re.compile(r'^(Melee|-|N/A|\d+"|[0-9D+\-]+)$')
STATS = ["M", "T", "SV", "W", "LD", "OC"]
SECTIONS = {"CORE ABILITIES", "FACTION ABILITIES", "UNIT ABILITIES", "WARGEAR", "WARGEAR OPTIONS", "DAMAGED",
            "Become a supporter", "SUPREME COMMANDER", "Discover more", "KEYWORDS", "COSTS", "UNIT COMPOSITION"}
SMALL = {"of", "the", "in", "from", "to", "and", "a"}


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower().replace("’", "'"))


def kw_case(k):
    """'CLOSE-QUARTERS' -> 'Close-quarters', 'ANTI-MONSTER/VEHICLE 4+' -> 'Anti-Monster/Vehicle 4+' (codex style)."""
    if k.startswith("ANTI-"):
        return "Anti-" + "/".join(x.title() for x in k[5:].split(" ")[0].split("/")) + " " + " ".join(k.split(" ")[1:])
    if k.startswith("HUNTER:"):
        return "Hunter: " + "/".join(x.title() for x in k[7:].strip().split("/"))
    w = k.lower().split(" ")
    return " ".join(x if x[:1].isdigit() else x[:1].upper() + x[1:] for x in w).strip()


def title_case(k):
    return " ".join((x.lower() if i and x.lower() in SMALL else x[:1] + x[1:].lower()) for i, x in enumerate(k.split(" ")))


def is_title(line, nxt):
    return (nxt is not None and len(line) < 70 and line[:1].isupper() and not re.search(r"[.:;,]$", line)
            and not line.startswith(("▪", "■", "▫", "•", "Designer")) and not line.isupper())


def blocks(lines):
    """[title, text] pairs from an ability section."""
    out = []
    for i, l in enumerate(lines):
        nxt = lines[i + 1] if i + 1 < len(lines) else None
        if is_title(l, nxt) or not out:
            out.append([l, []]); continue
        prev = out[-1][1][-1] if out[-1][1] else ""
        out[-1][1].append(("■ " + l) if prev.endswith(":") or (prev.startswith("■ ") and not l.startswith("On a")) and len(l) < 120 else l)
    return [[t, "\n".join(b)] for t, b in out if b]


def parse(text):
    raw = [l.strip() for l in text.split("\n")]
    L = [l for l in raw if l]
    name = L[L.index("DATASHEET") - 1]
    i = L.index("OC")
    inv = next((l.split(": ")[1] for l in L[i:i + 4] if l.startswith("Invulnerable save")), None)
    j, vals = i + 1, []
    while len(vals) < 6:
        vals = vals + [L[j]] if (VAL.match(L[j]) or re.match(r"^\d+\+$", L[j])) else []
        j += 1
    ds = {"name": name, "s": dict(zip(STATS, vals)), "wp": []}
    if inv:
        ds["inv"] = inv
    k = j
    while L[k] != "KEYWORDS":
        if L[k] in ("RANGED WEAPONS", "MELEE WEAPONS"):
            rm = "r" if L[k] == "RANGED WEAPONS" else "m"
            k += 1; cols = []
            while L[k] in ("RNG", "A", "BS", "WS", "S", "AP", "D"):
                cols.append(L[k]); k += 1
            while L[k] not in ("MELEE WEAPONS", "KEYWORDS"):
                nm = L[k].lstrip("➤ ").strip(); k += 1; kws = []
                while not VAL.match(L[k]):
                    kws.append(L[k]); k += 1
                v = L[k:k + len(cols)]; k += len(cols)
                m = re.match(r"^(.*?)\s*\(([^)]+)\)$", nm)
                base, prof = (m.group(1), m.group(2)) if m and m.group(2).lower() not in ("ranged", "melee") else (re.sub(r"\s*\((ranged|melee)\)$", "", nm), None)
                row = [prof, v[0] if rm == "r" else "Melee"] + v[-5:]
                row[3] = "N/A" if row[3] == "-" else row[3]
                row.append([kw_case(x) for x in kws])
                g = next((w for w in ds["wp"] if w[0] == base and w[1] == rm), None)
                if g:
                    g[2].append(row)
                else:
                    ds["wp"].append([base, rm, [row]])
            continue
        k += 1

    def section(h):
        if h not in L:
            return []
        a = L.index(h) + 1
        b = next(x for x in range(a, len(L)) if L[x] in SECTIONS)
        return L[a:b]
    ds["cr"] = [title_case(x) for x in section("CORE ABILITIES")]
    ds["fa"] = [title_case(x) for x in section("FACTION ABILITIES")]
    ds["ab"] = blocks(section("UNIT ABILITIES"))
    if "SUPREME COMMANDER" in L:
        ds["ab"].append(["Supreme Commander", L[L.index("SUPREME COMMANDER") + 1]])
    ds["wa"] = [[t, t, x] for t, x in blocks([l for l in section("WARGEAR") if not l.startswith("Designer")])]
    ds["wo"] = section("WARGEAR OPTIONS")
    return ds


def compile_dir(fid, d, version=None):
    data = json.load(open(PATH)) if os.path.exists(PATH) else {"note": __doc__.strip().split("\n")[0], "factions": {}}
    units = {}
    for f in sorted(os.listdir(d)):
        if f.endswith(".txt"):
            ds = parse(open(os.path.join(d, f)).read())
            units[ds.pop("name")] = ds
    data["factions"][fid] = {"source": "Warhammer 40,000 app via https://www.40k.app/factions/%s" % fid, "version": version, "units": units}
    json.dump(data, open(PATH, "w"), indent=1, ensure_ascii=False)
    return units


def apply(fid, units, f_ds, stats, report):
    if not os.path.exists(PATH):
        return
    ov = json.load(open(PATH))["factions"].get(fid)
    if not ov:
        return
    by = {norm(k): v for k, v in ov["units"].items()}
    rep = report.setdefault(fid, [])
    for u in units:
        d = by.get(norm(u["n"]))
        old = f_ds.get(u["n"])
        if not d or old is None or u.get("cx"):  # codex-covered generic units keep the codex datasheet
            continue
        new = dict(old)
        for key in ("s", "wp", "ab", "cr", "fa"):
            new[key] = json.loads(json.dumps(d[key]))
        if d.get("inv"):
            new["inv"] = d["inv"]
        if d.get("wa"):
            new["wa"] = d["wa"]
        if d.get("wo"):
            new["wo"] = d["wo"]
        new["src"] = "gwapp"
        f_ds[u["n"]] = new
        rep.append(u["n"])
        stats["gwapp_datasheets"] = stats.get("gwapp_datasheets", 0) + 1


if __name__ == "__main__":
    if sys.argv[1] == "compile":
        u = compile_dir(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None)
        print(len(u), "datasheets ->", PATH)
