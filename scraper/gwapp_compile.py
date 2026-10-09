"""
Compile the Warhammer 40,000 app detachment pages (as text, saved from 40k.app by a headless browser) into
scraper/overrides/gwapp_detachments.json: per 40k.app faction slug, every detachment's rule, enhancement text and
stratagems (name, CP, category, WHEN/TARGET/EFFECT). gwapp_override.py applies it in build_data.py after GrimSlate
and the codex override, so the newest published rules text wins on every daily refresh. Text only: points, DP,
enhancement names/costs and detachment lists stay MFM.

usage: python3 scraper/gwapp_compile.py PAGES_DIR APP_VERSION RELEASED   (pages: <faction>__<detachment>.txt)
"""
import glob, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "overrides", "gwapp_detachments.json")
SECTION = ("TARGET", "WHEN", "EFFECT", "RESTRICTIONS")
# obvious typos in the app data (kept out of Muster's names)
TYPOS = {"FEROICITY": "FEROCITY", "UPSTOPPABLE": "UNSTOPPABLE", "UPGARDE": "UPGRADE", "MANOEUVERS": "MANOEUVRES", "VOIDDRAGON": "VOID DRAGON", "CHAPLIN": "CHAPLAIN", "SKITARlI": "SKITARII", "INQUISTOR": "INQUISITOR"}
SMALL = {"of", "the", "and", "a", "an", "to", "in", "on", "for", "by", "at", "or", "from", "with", "unto", "upon", "into", "vs"}


def fix(s):
    for a, b in TYPOS.items():
        s = re.sub(r"\b" + a + r"\b" if a.isupper() and len(a) < 9 else a, b, s, flags=0 if a == "SKITARlI" else re.I)
    s = re.sub(r"\[([^\[\]]*)\[([^\]]*)\]\]\(#\w+\)", r"[\1\2]", s)   # '[ANTI-non-[VEHICLE 4+]](#kw)' -> '[ANTI-non-VEHICLE 4+]'
    s = re.sub(r"\]\(#\w+\)", "]", s)
    s = re.sub("[\u2010\u2011\u2012]", "-", s)   # typographic hyphens (keyword matching needs '-')
    return s.replace("\u2011", "-").replace("’", "'").replace("‘", "'").replace("”", '"').replace("“", '"').strip()


def title(s):
    s = fix(s)
    if s != s.upper():
        return s
    w = s.lower().split(" ")
    out = []
    for i, x in enumerate(w):
        if i and x in SMALL:
            out.append(x); continue
        out.append("-".join(p[:1].upper() + p[1:] for p in x.split("-")))
    t = " ".join(out)
    return re.sub(r"'S\b", "'s", t)


WEAPON_COLS = {"RANGE", "RNG", "A", "WS", "BS", "S", "AP", "D"}
VAL = re.compile(r'(?:Melee|[0-9D+\-"”.]+(?:\+?[0-9D]*)?)')


def tables(lines):
    """'MELEE WEAPONS / A / WS / S / AP / D / Imperium's Sword / 6 / 2+ / 7 / -3 / 3' (a weapon table flattened to
    lines) -> "Imperium's Sword (melee): A 6, WS 2+, S 7, AP -3, D 3"."""
    out, i = [], 0
    while i < len(lines):
        l = lines[i]
        if l.upper() in ("MELEE WEAPONS", "RANGED WEAPONS") and i + 1 < len(lines) and lines[i + 1].upper() in WEAPON_COLS:
            kind = "melee" if l.upper().startswith("MELEE") else "ranged"
            j, cols = i + 1, []
            while j < len(lines) and lines[j].upper() in WEAPON_COLS:
                cols.append(lines[j].upper()); j += 1
            while j < len(lines):
                name, k, kws = lines[j], j + 1, []
                while k < len(lines) and lines[k] == lines[k].upper() and not VAL.fullmatch(lines[k]) and re.search(r"[A-Z]", lines[k]):
                    kws.append(lines[k]); k += 1      # weapon abilities printed under the name
                vals = lines[k:k + len(cols)]
                if len(vals) < len(cols) or not all(VAL.fullmatch(v) for v in vals):
                    break
                row = f"{name} ({kind}): " + ", ".join(f"{'Range' if c in ('RANGE', 'RNG') else c} {v}" for c, v in zip(cols, vals))
                if kws:
                    row += " [" + ", ".join(kws) + "]"
                j = k + len(cols)
                if j < len(lines) and lines[j].startswith("["):
                    row += " " + lines[j]; j += 1
                out.append(row)
            i = j
            continue
        out.append(l); i += 1
    return out


def is_heading(l):
    return bool(l) and len(l) < 70 and l == l.upper() and re.search(r"[A-Z]", l) and not l.endswith(".") and not re.fullmatch(r"[\d\s+\-\"”]+", l)


def parse(path):
    L = [l.strip() for l in open(path, encoding="utf-8").read().split("\n")]
    url = L[0]
    if "Become a supporter" in L:                       # site footer
        L = L[:L.index("Become a supporter")]
    SHOP = {"Discover more", "Warhammer 40,000 miniatures", "Warhammer 40,000 books", "Warhammer merchandise", "Shop Miniatures", "Forge World models"}
    L = [l for l in L if l not in SHOP]                 # shop-link block the site inserts between sections
    i = L.index("CREATE LIST")
    hdr = L[:i]
    dpl = next(l for l in hdr if re.search(r"\d+DP", l))
    name = hdr[hdr.index(dpl) - 1]
    body = L[i + 1:]
    ei = body.index("ENHANCEMENTS") if "ENHANCEMENTS" in body else len(body)
    si = body.index("STRATAGEMS") if "STRATAGEMS" in body else len(body)
    # rule: headed blocks; the first real heading names the rule, later ones become "Heading: text" lines
    blocks, cur = [], None
    for l in body[:min(ei, si)]:
        if not l:
            continue
        if is_heading(l):
            cur = [l, []]; blocks.append(cur)
        else:
            if cur is None:
                cur = ["", []]; blocks.append(cur)
            cur[1].append(fix(l))
    # the rule is kept as headed blocks; gwapp_override picks the block named like the current rule (else the first)
    rule = {"blocks": [[title(b[0]) if b[0] not in ("KEYWORDS",) else "Keywords", "\n".join(b[1])] for b in blocks]} if blocks else None
    enh = []
    seg = [x for x in body[ei + 1:si] if x] if ei < len(body) else []
    k = 0
    while k < len(seg):
        if k + 1 < len(seg) and re.fullmatch(r"\d+ pts", seg[k + 1]):
            enh.append({"name": title(seg[k]), "pts": int(seg[k + 1].split()[0]), "text": ""}); k += 2
        else:
            enh[-1]["text"] += ("\n" if enh[-1]["text"] else "") + fix(seg[k]); k += 1
    st = []
    seg = [x for x in body[si + 1:] if x] if si < len(body) else []
    k = 0
    while k < len(seg):
        n, ph = seg[k], seg[k + 1]; k += 2
        d = {}
        while k < len(seg) and seg[k] in SECTION:
            key = seg[k]; k += 1; txt = []
            while k < len(seg) and seg[k] not in SECTION and not re.fullmatch(r"\d", seg[k]):
                txt.append(fix(seg[k])); k += 1
            d[key] = "\n".join(txt)
        cp = None
        if k < len(seg) and re.fullmatch(r"\d", seg[k]):
            cp = int(seg[k]); k += 1
        cat = ph.split(" - ", 1)[1].strip() if " - " in ph else None
        text = "\n".join(f"{x}: {d[x]}" for x in ("WHEN", "TARGET", "EFFECT", "RESTRICTIONS") if d.get(x))
        st.append({"name": title(n), "cp": cp, "category": cat.title() if cat else None, "text": text})
    tb = lambda t: "\n".join(tables(t.split("\n"))) if t else t
    if rule:
        rule["blocks"] = [[h, tb(t)] for h, t in rule["blocks"]]
    for e in enh:
        e["text"] = tb(e["text"])
    for x in st:
        x["text"] = tb(x["text"])
    return {"name": fix(name), "dp": int(re.match(r"(\d+)DP", dpl).group(1)), "url": url, "rule": rule, "enhancements": enh, "stratagems": st}


def main():
    d, ver, rel = sys.argv[1], sys.argv[2], sys.argv[3]
    out = {"source": "Warhammer 40,000 app data (via 40k.app)", "app_version": ver, "released": rel, "factions": {}}
    for p in sorted(glob.glob(os.path.join(d, "*__*.txt"))):
        fid = os.path.basename(p).split("__")[0]
        out["factions"].setdefault(fid, []).append(parse(p))
    for f in out["factions"].values():
        f.sort(key=lambda x: x["name"].lower())
    json.dump(out, open(OUT, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print(f"{OUT}: {sum(len(v) for v in out['factions'].values())} detachments, {len(out['factions'])} factions")


if __name__ == "__main__":
    main()
