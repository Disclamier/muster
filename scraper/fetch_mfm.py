#!/usr/bin/env python3
"""
Scrape the official Warhammer 40,000 Munitorum Field Manual (https://mfm.warhammer-community.com)
into a clean JSON file.

How the site works (as of Oct 2026): it is a Next.js App Router site hosted on Vercel, statically
prerendered (ISR). There is no public JSON API. Every faction page embeds its full data as a React
Server Components ("Flight") payload. Requesting the page with the header `RSC: 1` returns that
payload directly (text/x-component). We parse it into a React element tree and walk it.

Legends units are only rendered when the cookie `isLegendsDisplayed=true` is sent (that is what the
"Show Legends" toggle sets), so we always send it and tag those units with legends=true.

Usage:  python3 fetch_mfm.py [--out PATH] [--lang en] [--delay 1.0] [--only necrons,orks]
"""
import argparse, datetime as dt, json, os, re, sys, time, urllib.request, urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsc import parse_rows, resolve, is_el, text_of  # noqa: E402

BASE = "https://mfm.warhammer-community.com"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/126.0 Safari/537.36 w40k-list-tool/1.0")
CARD_CLS = "print:break-inside-avoid-page"


# ---------------------------------------------------------------- HTTP
def http_get(url, headers=None, retries=4, timeout=30):
    h = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
    h.update(headers or {})
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace"), dict(r.headers)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
            code = getattr(e, "code", None)
            if code and 400 <= code < 500 and code != 429:
                raise
            wait = 2 ** attempt * 2
            print(f"  ! {url}: {e} (retry {attempt+1}/{retries} in {wait}s)", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"failed to fetch {url}: {last}")


def html_to_flight(html):
    """Fallback: reassemble the Flight payload embedded in the HTML via self.__next_f.push()."""
    out = []
    for c in re.findall(r'self\.__next_f\.push\((\[.*?\])\)</script>', html, flags=re.S):
        try:
            a = json.loads(c)
            if len(a) > 1 and isinstance(a[1], str):
                out.append(a[1])
        except Exception:
            pass
    return "".join(out)


def fetch_tree(path, lang):
    url = f"{BASE}/{lang}/{path}".rstrip("/")
    headers = {"Cookie": "isLegendsDisplayed=true"}
    try:
        body, _ = http_get(url, {**headers, "RSC": "1", "Accept": "text/x-component"})
        if not re.match(r'^[0-9a-f]+:', body):
            raise ValueError("not a flight payload")
    except Exception as e:
        print(f"  ! RSC fetch failed for {url} ({e}); falling back to HTML", file=sys.stderr)
        html, _ = http_get(url, headers)
        body = html_to_flight(html)
    rows = parse_rows(body)
    if "0" not in rows:
        raise RuntimeError(f"no root row in payload for {url}")
    return url, resolve(rows, rows["0"])


# ---------------------------------------------------------------- tree helpers
def props(el):
    return el[3] if is_el(el) else {}


def cls(el):
    c = props(el).get("className")
    return c if isinstance(c, str) else ""


def kids(el):
    c = props(el).get("children") if is_el(el) else el
    if c is None or isinstance(c, (str, bool, int, float)):
        return []
    if is_el(c):
        return [c]
    out = []
    for x in c:
        if is_el(x):
            out.append(x)
        elif isinstance(x, list):
            out.extend(kids(x))
    return out


def iter_elements(node):
    """Depth-first over all React elements anywhere in node."""
    stack = [node]
    while stack:
        x = stack.pop()
        if is_el(x):
            yield x
            stack.append(x[3])
        elif isinstance(x, list):
            stack.extend(reversed(x))
        elif isinstance(x, dict):
            stack.extend(reversed(list(x.values())))


def clean(s):
    return re.sub(r"\s+", " ", (s or "").replace("\u00a0", " ")).strip()


def find_all(node, pred):
    return [e for e in iter_elements(node) if pred(e)]


# ---------------------------------------------------------------- value parsers
PTS_RE = re.compile(r"(?:(▲|▼)\s*)?(?:\(([+-]?[\d,]+)\)\s*)?(\d[\d,]*)\s*pts", re.I)


def parse_points(txt):
    m = PTS_RE.search(txt or "")
    if not m:
        return None, None
    change = int(m.group(2).replace(",", "")) if m.group(2) else None
    return int(m.group(3).replace(",", "")), change


def parse_models(label):
    m = re.match(r"\s*(\d+)\s+models?\b", label or "", re.I)
    return int(m.group(1)) if m else None


def count_models(label):
    """'1 Sword Brother, 4 Neophytes, 5 Initiates' -> 10; '10 Gretchin' -> 10."""
    n = parse_models(label)
    if n is not None:
        return n
    nums = re.findall(r"(?:^|,)\s*(\d+)\s+\D", label or "")
    return sum(map(int, nums)) if nums else None


ORD = r"(\d+)(?:ST|ND|RD|TH)"


def parse_tier(label):
    """'YOUR 1ST TO 2ND UNITS COST' -> (1, 2); 'YOUR 3RD + UNIT COSTS' -> (3, None)."""
    L = label.upper()
    m = re.search(ORD + r"\s*TO\s*" + ORD, L)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(ORD + r"\s*\+", L)
    if m:
        return int(m.group(1)), None
    m = re.search(ORD, L)
    if m:
        n = int(m.group(1))
        return n, n
    return 1, None


def change_from_header(el):
    c = cls(el)
    if "bg-red" in c:
        return "increased"
    if "bg-emerald" in c or "bg-green" in c:
        return "decreased"
    return None


# ---------------------------------------------------------------- card parsers
def parse_unit_card(card, legends, group_name):
    ch = kids(card)
    header = ch[0] if ch else None
    spans = [k for k in kids(header) if "text-xl" in cls(k)]
    name = clean(text_of(spans[0] if spans else header)).rstrip("▲▼ ").strip()
    unit = {"name": name, "id": card[2], "legends": legends, "costs": [], "cost_tiers": [],
            "points_change": change_from_header(header), "leader_of": [], "support_for": [],
            "wargear_costs": [], "notes": []}
    if group_name:
        unit["group"] = group_name
    for blk in ch[1:]:
        bk = kids(blk)
        if not bk:
            t = clean(text_of(blk))
            if t:
                unit["notes"].append(t)
            continue
        head = clean(text_of(bk[0]))
        if re.search(r"\bCOSTS?\b", head) and head.upper().startswith("YOUR"):
            frm, to = parse_tier(head)
            costs = []
            for li in find_all(blk, lambda e: e[1] == "li"):
                parts = kids(li)
                label = clean(text_of(parts[0])) if parts else ""
                ptxt = clean(text_of(parts[1])) if len(parts) > 1 else clean(text_of(li))
                pts, chg = parse_points(ptxt)
                c = {"models": count_models(label), "points": pts}
                if parse_models(label) is None:
                    c["label"] = label  # composition text, e.g. "3 Headtakers, 3 Hunting Wolves"
                if chg is not None:
                    c["change"] = chg
                costs.append(c)
            unit["cost_tiers"].append({"label": head, "from_unit": frm, "to_unit": to, "costs": costs})
        elif head.upper().startswith("LEADER") or head.upper().startswith("SUPPORT"):
            targets = clean(text_of(bk[1:])) if len(bk) > 1 else ""
            lst = [clean(x) for x in targets.split(",") if clean(x)]
            unit["leader_of" if head.upper().startswith("LEADER") else "support_for"] += lst
        elif head.upper().startswith("WARGEAR"):
            for li in find_all(blk, lambda e: e[1] == "li"):
                parts = kids(li)
                wname = clean(text_of(parts[0])) if parts else clean(text_of(li))
                pts, chg = parse_points(clean(text_of(parts[-1])) if parts else "")
                w = {"name": re.sub(r"^per\s+", "", wname, flags=re.I), "points": pts,
                     "per_item": wname.lower().startswith("per ")}
                if chg is not None:
                    w["change"] = chg
                unit["wargear_costs"].append(w)
        else:
            t = clean(" | ".join(clean(text_of(k)) for k in bk if clean(text_of(k))))
            if t:
                unit["notes"].append(t)
    # standalone banners such as "UPDATED", "BODYGUARD UNITS UPDATED" are change markers
    unit["changes"] = [n for n in unit["notes"] if re.search(r"UPDATED|CHANGED|REMOVED|^NEW$|ADDED", n)]
    unit["notes"] = [n for n in unit["notes"] if n not in unit["changes"]]
    if unit["cost_tiers"]:
        unit["costs"] = [{"models": c["models"], "points": c["points"]}
                         for c in unit["cost_tiers"][0]["costs"]]
    for k in ("leader_of", "support_for", "wargear_costs", "changes", "notes", "points_change"):
        if not unit[k]:
            unit.pop(k)
    return unit


def parse_detachment_card(card):
    ch = kids(card)
    header = ch[0] if ch else None
    hs = kids(header)
    name = clean(text_of(hs[0])) if hs else clean(text_of(header))
    dp_txt = clean(text_of(hs[1:])) if len(hs) > 1 else ""
    m = re.search(r"(\d+)\s*DP", dp_txt, re.I)
    det = {"name": name, "id": card[2],
           "detachment_points": int(m.group(1)) if m else None,
           "force_dispositions": [], "restrictions": [], "support": [], "enhancements": [],
           "changes": [], "notes": []}
    chg = change_from_header(header)
    if chg:
        det["changes"].append(f"DETACHMENT POINTS {chg.upper()}" if m else chg)
    for blk in ch[1:]:
        c = cls(blk)
        t = clean(text_of(blk))
        bk = kids(blk)
        if "text-white" in c and not bk:
            det["force_dispositions"].append(t)
        elif bk and clean(text_of(bk[0])) == "ENHANCEMENTS":
            for li in find_all(blk, lambda e: e[1] == "li"):
                sp = [s for s in iter_elements(li) if s[1] == "span"]
                if len(sp) >= 2:
                    ename = clean(text_of(sp[0]))
                    pts, d = parse_points(clean(text_of(sp[-1])))
                else:
                    ename, (pts, d) = clean(text_of(li)), (None, None)
                e = {"name": ename, "points": pts}
                if d is not None:
                    e["change"] = d
                det["enhancements"].append(e)
        elif t.upper().startswith("UNIQUE"):
            det["restrictions"].append(t)
        elif t.upper().startswith("SUPPORT"):
            rest = clean(re.sub(r"^SUPPORT:?", "", t, flags=re.I))
            det["support"] += [clean(x) for x in rest.split(",") if clean(x)]
        elif t.upper() in ("UPDATED", "NEW") or "CHANGED" in t.upper():
            det["changes"].append(t)
        elif t:
            det["notes"].append(t)
    for k in ("restrictions", "support", "changes", "notes"):
        if not det[k]:
            det.pop(k)
    return det


# ---------------------------------------------------------------- page parsers
def section_blocks(tree):
    """Yield (section_title, section_element) for each <h3> section on the page."""
    for el in iter_elements(tree):
        ks = kids(el)
        if ks and ks[0][1] == "h3":
            yield clean(text_of(ks[0])), el


def parse_faction_page(tree, uuid_names):
    units, detachments = [], []
    _, page_uuids = parse_index(tree)
    uuid_names.update(page_uuids)
    version = None
    for el in iter_elements(tree):
        if el[1] == "h2" and re.fullmatch(r"v[\d.]+", clean(text_of(el))):
            version = clean(text_of(el))
            break
    seen = set()
    for title, sec in section_blocks(tree):
        T = title.upper()
        if T in ("UNITS", "LEGENDS"):
            legends = T == "LEGENDS"
            # Units are grouped by faction-uuid wrapper divs (e.g. allied/shared datasheets)
            for card in find_all(sec, lambda e: CARD_CLS in cls(e) and e[1] == "div"):
                if card[2] in seen:
                    continue
                seen.add(card[2])
                units.append(parse_unit_card(card, legends, None))
            for grp in kids(sec)[1:]:
                gname = uuid_names.get(re.sub(r"-sub$", "", grp[2] or ""))
                if gname:
                    ids = {c[2] for c in find_all(grp, lambda e: CARD_CLS in cls(e))}
                    for u in units:
                        if u["id"] in ids:
                            u["_group"] = gname
        elif T == "DETACHMENTS":
            for card in find_all(sec, lambda e: CARD_CLS in cls(e) and e[1] == "div"):
                if card[2] in seen:
                    continue
                seen.add(card[2])
                detachments.append(parse_detachment_card(card))
    return version, units, detachments


def parse_index(tree):
    """Faction slugs/names from the home page plus uuid->name map from the nav menu."""
    factions, uuid_names = [], {}
    for el in iter_elements(tree):
        p = props(el)
        href = p.get("href")
        if isinstance(href, dict):
            href = href.get("pathname")
        if isinstance(href, str):
            slug = href.strip("/").split("/")[-1]
            name = clean(text_of(el))
            if slug and name and not any(f["id"] == slug for f in factions) and slug not in ("en",):
                factions.append({"id": slug, "name": name})
        if el[2] and re.fullmatch(r"[0-9a-f-]{36}", str(el[2])) and "navigation-menu" in str(p.get("data-slot", "")):
            uuid_names[el[2]] = clean(text_of(el))
    return factions, uuid_names


def parse_muster(tree):
    """'Muster Armies' rules shown on every page: battle-size table + rule text lines."""
    sizes = []
    for t in find_all(tree, lambda e: e[1] == "table"):
        trs = [[clean(text_of(td)) for td in kids(tr)] for tr in find_all(t, lambda e: e[1] == "tr")]
        if trs and "Battle Size" in trs[0][0]:
            for r in trs[1:]:
                if len(r) >= 5 and r[1].isdigit():
                    sizes.append({"name": r[0].title(), "points": int(r[1]), "detachment_points": int(r[2]),
                                  "enhancement_limit": int(r[3]), "unit_limit": int(r[4])})
    text = []
    for el in iter_elements(tree):
        t = text_of(el)
        if "FILL YOUR ARMY ROSTER" in t and "SELECT ENHANCEMENTS" in t:
            lines = []
            def walk(x):
                if isinstance(x, str):
                    if x != "$undefined":
                        lines.append(x)
                elif is_el(x):
                    if x[1] in ("tr", "br", "li", "div"):
                        lines.append("\n")
                    if x[1] == "td":
                        lines.append(" | ")
                    walk(x[3].get("children"))
                elif isinstance(x, list):
                    for y in x:
                        walk(y)
            walk(el)
            text = [clean(l) for l in "".join(lines).split("\n") if clean(l)]
    return {"battle_sizes": sizes, "rules_text": text}


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--out", default=os.path.join(here, "..", "data", "mfm.json"))
    ap.add_argument("--lang", default="en")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests")
    ap.add_argument("--only", default="", help="comma-separated faction slugs")
    a = ap.parse_args()
    t0 = time.time()

    # The home page HTML has nice display names (e.g. "T’au Empire"); the nav has upper-case + uuids.
    home_html, _ = http_get(f"{BASE}/{a.lang}")
    pretty = {}
    for slug, inner in re.findall(r'href="/%s/([a-z0-9-]+)"[^>]*>(.*?)</a>' % a.lang, home_html, flags=re.S):
        txt = clean(re.sub(r"<[^>]+>", " ", inner))
        if txt and slug not in pretty:
            pretty[slug] = txt
    _, home_tree = fetch_tree("", a.lang)
    factions_idx, uuid_names = parse_index(home_tree)
    slugs = list(dict.fromkeys(list(pretty) + [f["id"] for f in factions_idx]))
    if a.only:
        slugs = [s for s in slugs if s in a.only.split(",")]
    print(f"{len(slugs)} factions found", file=sys.stderr)

    result = {"source": BASE, "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
              "source_version": None, "language": a.lang, "factions": [], "errors": []}
    versions = set()
    for slug in slugs:
        time.sleep(a.delay)
        try:
            url, tree = fetch_tree(slug, a.lang)
            version, units, dets = parse_faction_page(tree, uuid_names)
            if not result.get("muster", {}).get("battle_sizes"):
                result["muster"] = parse_muster(tree)
            versions.add(version)
            for u in units:
                g = u.pop("_group", None)
                if g:
                    u["source_group"] = g
            enh = [{"detachment": d["name"], "name": e["name"], "points": e["points"]}
                   for d in dets for e in d["enhancements"]]
            fac_uuid = next((k for k, v in uuid_names.items()
                             if v.upper() == (pretty.get(slug) or slug).upper()), None)
            result["factions"].append({
                "id": slug, "uuid": fac_uuid, "name": pretty.get(slug, slug.replace("-", " ").title()),
                "url": url, "version": version,
                "units": units, "detachments": dets, "enhancements": enh,
            })
            nleg = sum(u["legends"] for u in units)
            print(f"  {slug:24s} units={len(units)-nleg:3d} legends={nleg:3d} detachments={len(dets):3d} "
                  f"enhancements={len(enh):3d}", file=sys.stderr)
            if not units:
                result["errors"].append({"faction": slug, "error": "no units parsed"})
        except Exception as e:
            print(f"  ! {slug}: {e}", file=sys.stderr)
            result["errors"].append({"faction": slug, "error": str(e)})
    versions.discard(None)
    result["source_version"] = ", ".join(sorted(versions)) or None
    result["elapsed_seconds"] = round(time.time() - t0, 1)

    out = os.path.abspath(a.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    os.replace(tmp, out)
    nu = sum(len(f["units"]) for f in result["factions"])
    print(f"wrote {out}: {len(result['factions'])} factions, {nu} units, "
          f"version={result['source_version']}, {result['elapsed_seconds']}s, errors={len(result['errors'])}",
          file=sys.stderr)
    return 0 if not result["errors"] else 1


if __name__ == "__main__":
    sys.exit(main())
