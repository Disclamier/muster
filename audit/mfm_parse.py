#!/usr/bin/env python3
"""
INDEPENDENT Munitorum Field Manual parser for the points audit (does not share code with scraper/).
Input: fully rendered DOM of every faction page (audit/mfm_dump.py drives headless Chrome with the
"Show Legends" cookie, so streamed/suspended sections are in place), parsed with BeautifulSoup.
Output JSON: {factions: {id: {units: [...], detachments: [...], unknown: [...]}}}
  unit: {name, legends, group, tiers: [{label, rows: [[label, points]]}], wargear: [[text, points]], other: [[section, [[label, pts]]]]}
  detachment: {name, dp, enhancements: [[name, points]]}
"""
import json, os, re, sys
from bs4 import BeautifulSoup

PTS = re.compile(r"(?<![\d,.])(-?\d{1,3}(?:[,.\s]\d{3})+|-?\d+)\s*pts\s*$", re.I)


def pts_of(text):
    m = PTS.search(text.strip())
    return int(re.sub(r"[,.\s]", "", m.group(1))) if m else None


def parse_page(html):
    s = BeautifulSoup(html, "lxml")
    main = s.find("main")
    out = {"units": [], "detachments": [], "unknown": []}
    heading = None
    for el in main.find_all(True):
        if el.name in ("h1", "h2", "h3", "h4"):
            heading = el.get_text(" ", strip=True)
            continue
        cls = el.get("class") or []
        if "print:break-inside-avoid-page" not in cls:
            continue
        head = el.find("div", recursive=False)
        spans = head.find_all("span", recursive=False)
        name = (spans[0] if spans else head).get_text(" ", strip=True)
        right = spans[1].get_text(" ", strip=True) if len(spans) > 1 else ""
        sections = []
        for sec in el.find_all("div", class_="space-y-1", recursive=False):
            st = sec.find("div", recursive=False)
            title = st.get_text(" ", strip=True) if st else ""
            rows = []
            for li in sec.find_all("li"):
                parts = [x for x in li.find_all("span") if not x.find("span")]
                txts = [p.get_text(" ", strip=True) for p in parts if p.get_text(strip=True)]
                if not txts:
                    txts = [li.get_text(" ", strip=True)]
                p = pts_of(txts[-1]) if len(txts) > 1 else None
                if p is None and re.search(r"\bpts\b", " ".join(txts), re.I):
                    out["unknown"].append(f"{name}: unparsed points text {' | '.join(txts)!r}")
                rows.append([" ".join(txts[:-1]) if p is not None else " ".join(txts), p])
            sections.append([title, rows])
        dpm = re.match(r"^(\d+)\s*DP", right.replace(" ", ""))
        if dpm or any(t.upper() == "ENHANCEMENTS" for t, _ in sections):
            enh = [r for t, rows in sections if t.upper() == "ENHANCEMENTS" for r in rows]
            if not dpm:
                out["unknown"].append(f"detachment {name}: no DP value")
            for r in enh:
                if r[1] is None:
                    out["unknown"].append(f"detachment {name}: enhancement {r[0]!r} without points")
            out["detachments"].append({"name": name, "dp": int(dpm.group(1)) if dpm else None, "enhancements": enh, "group": heading})
            continue
        u = {"name": name, "legends": (heading or "").upper() == "LEGENDS", "group": heading, "tiers": [], "wargear": [], "other": []}
        for t, rows in sections:
            T = t.upper()
            if T.startswith("YOUR") and "COST" in T:
                u["tiers"].append({"label": t, "rows": rows})
            elif T.startswith("WARGEAR"):
                u["wargear"] += rows
            else:
                u["other"].append([t, rows])
                if any(r[1] is not None for r in rows):
                    out["unknown"].append(f"{name}: points in unexpected section {t!r}")
        if not u["tiers"] or not any(r[1] is not None for t in u["tiers"] for r in t["rows"]):
            out["unknown"].append(f"{name}: unit card without points")
        out["units"].append(u)
    if len(out["units"]) < 3:
        out["unknown"].append(f"only {len(out['units'])} unit cards on the page - layout changed?")
    v = s.find(string=re.compile(r"^\s*v\d+(\.\d+)*\s*$"))
    out["version"] = v.strip() if v else None
    return out


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "audit/out/dom"
    res = {"source": "https://mfm.warhammer-community.com/en (rendered DOM)", "factions": {}}
    for fn in sorted(os.listdir(d)):
        if fn.endswith(".html"):
            res["factions"][fn[:-5]] = parse_page(open(os.path.join(d, fn), encoding="utf-8").read())
    json.dump(res, sys.stdout, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
