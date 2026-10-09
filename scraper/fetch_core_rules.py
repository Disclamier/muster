#!/usr/bin/env python3
"""Warhammer 40,000 11th-edition Core Rules (+ Rules Appendix: definitions, clarifications, FAQ/errata) -> core_rules.json
for Muster's searchable "Core Rules" tab.

Source: Wahapedia's reproduction of the GW Core Rules (the same page fetch_core_strats.py reads):
  https://wahapedia.ru/wh40k11ed/the-rules/core-rules/     (Core Rules, incl. FAQ / errata boxes, Core Abilities,
                                                             weapon abilities, Core Stratagems)
  https://wahapedia.ru/wh40k11ed/the-rules/rules-appendix/ (Rules Appendix: the "See also" definitions, e.g. Starting
                                                             Strength, Lone Operative, [EXTRA ATTACKS] ...)
robots.txt allows /wh40k11ed/the-rules/. Two pages, fetched once per refresh.

Output: {"source": [...], "fetched_at", "hash", "sections": [{"id", "t" title, "n" number, "l" level, "p" parent index,
"h" sanitized HTML (p/ul/ol/li/table/b/i + FAQ boxes)}]}; the app builds its search text from "h". Sections are in page order; levels:
0 book, 1 part (BASIC RULES ...), 2 chapter, 3 section, 4 sub-rule / ability / stratagem.

usage: python3 scraper/fetch_core_rules.py --out data/core_rules.json [--publish app/data/core_rules.json]
       --publish copies the result there only when the rules content changed (no daily churn).
"""
import hashlib, html, json, os, re, sys, urllib.request
from datetime import datetime, timezone
from bs4 import BeautifulSoup, NavigableString, Tag

PAGES = [("Core Rules", "https://wahapedia.ru/wh40k11ed/the-rules/core-rules/"),
         ("Rules Appendix", "https://wahapedia.ru/wh40k11ed/the-rules/rules-appendix/")]
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 muster-data"
SKIP_CLS = {"noprint", "page_breaker_ads", "contentsWrap", "tooltip_templates", "CornerSeeAlso", "btnFaqErrataToggle",
            "ShowFluff", "h_number", "abIcon", "tooltip_link", "outline_header_book"}
INLINE_OK = {"b": "b", "strong": "b", "i": "i", "em": "i", "u": "u", "sup": "sup", "sub": "sub"}
NUM_RX = re.compile(r"^\s*(\d\d(?:\.\d\d)+)\s+|\s+(\d\d(?:\.\d\d)*)\s*$")


def classes(t):
    return set(t.get("class") or []) if isinstance(t, Tag) else set()


def esc(s):
    return html.escape(s, quote=False)


class Builder:
    def __init__(self):
        self.secs, self.ids = [], set()
        self.cur = None

    def uid(self, title, n):
        base = re.sub(r"[^a-z0-9]+", "-", (title + (" " + n if n else "")).lower()).strip("-")[:60] or "s"
        i, u = 1, base
        while u in self.ids:
            i += 1; u = f"{base}-{i}"
        self.ids.add(u); return u

    def open(self, title, n, level):
        title = re.sub(r"\s+", " ", title).strip()
        parent = None
        for j in range(len(self.secs) - 1, -1, -1):
            if self.secs[j]["l"] < level:
                parent = j; break
        s = {"id": self.uid(title, n), "t": title, "n": n or "", "l": level, "p": parent, "h": []}
        self.secs.append(s); self.cur = s
        return s

    def add(self, frag):
        if self.cur is not None and frag:
            self.cur["h"].append(frag)


def heading_parts(el):
    num = ""
    hn = el.select_one(".h_number")
    if hn:
        num = hn.get_text(strip=True)
    for x in el.select(".h_number"):
        x.extract()
    t = el.get_text(" ", strip=True)
    m = NUM_RX.search(t)
    if m and not num:
        num = m.group(1) or m.group(2)
    t = NUM_RX.sub("", t).strip()
    return t, num


def inline(node):
    """sanitized inline/flow HTML of a node (no structure-changing headings expected inside)"""
    if isinstance(node, NavigableString):
        if node.__class__.__name__ in ("Comment", "Doctype", "Declaration", "ProcessingInstruction"):
            return ""
        return esc(str(node))
    if not isinstance(node, Tag):
        return ""
    if node.name in ("script", "style", "noscript", "img", "svg", "input", "button") or classes(node) & SKIP_CLS:
        return ""
    inner = "".join(inline(c) for c in node.children)
    nm = node.name
    if nm == "br":
        return "<br>"
    if nm in INLINE_OK:
        return f"<{INLINE_OK[nm]}>{inner}</{INLINE_OK[nm]}>" if inner.strip() else inner
    if nm in ("ul", "ol"):
        return f"<{nm}>{inner}</{nm}>"
    if nm == "li":
        return f"<li>{inner}</li>"
    if nm == "table":
        return table(node)
    if nm in ("p",):
        return f'<p class="lead">{inner}</p>' if "legend" in classes(node) else f"<p>{inner}</p>"
    if nm == "div":
        c = classes(node)
        if "faqErrataSpoiler" in c:
            return faq_box(node)
        if c & {"frameDark", "frameLight", "redExample", "greenExample", "BoxNoFluff"} or any(k.startswith("frame") for k in c):
            return f'<div class="box">{inner}</div>'
        return f"<div>{inner}</div>" if inner.strip() else ""
    if nm in ("h2", "h3", "h4", "h5"):
        t, n = heading_parts(node)
        return f"<p><b>{esc(t)}</b></p>"
    return inner  # a, span, font, ... -> their text


def table(t):
    rows = t.find_all("tr", recursive=False) or [tr for tb in t.find_all(["tbody", "thead"], recursive=False) for tr in tb.find_all("tr", recursive=False)]
    # layout wrapper: one row, one cell holding the real table
    if len(rows) == 1:
        cells = rows[0].find_all(["td", "th"], recursive=False)
        if len(cells) == 1 and cells[0].find("table"):
            return "".join(inline(c) for c in cells[0].children)
    out = []
    for tr in rows:
        cells = []
        for td in tr.find_all(["td", "th"], recursive=False):
            tag = "th" if td.name == "th" or (td.find("b") and td.get_text(strip=True) == td.find("b").get_text(strip=True) and tr is rows[0]) else "td"
            span = "".join(f' {a}="{int(td.get(a))}"' for a in ("colspan", "rowspan") if str(td.get(a) or "").isdigit() and int(td.get(a)) > 1)
            cells.append(f"<{tag}{span}>{''.join(inline(c) for c in td.children).strip()}</{tag}>")
        if cells:
            out.append("<tr>" + "".join(cells) + "</tr>")
    return f'<table>{"".join(out)}</table>' if out else ""


def faq_box(node):
    head = node.select_one(".faqErrataHead h3")
    kind = head.get_text(" ", strip=True) if head else "FAQ"
    body = node.select_one(".faqErrataSpoilerBody") or node
    items = []
    for f in body.find_all("div", class_="faq"):
        q = f.select_one("td.faq_Q"); a = f.select_one("td.faq_A")
        qt = q.find_next_sibling("td") if q else None; at = a.find_next_sibling("td") if a else None
        if qt is not None or at is not None:
            items.append(f'<p class="q"><b>Q:</b> {"".join(inline(c) for c in qt.children).strip() if qt else ""}</p>'
                         f'<p class="a"><b>A:</b> {"".join(inline(c) for c in at.children).strip() if at else ""}</p>')
        f.extract()
    rest = "".join(inline(c) for c in body.children).strip()
    return f'<div class="faq"><div class="faq-h">{esc(kind)}</div>{"".join(items)}{rest}</div>'


STRUCT_SEL = "h1,h2,h3,h4,div.abWrap,div.str11Wrap,div.faqErrataSpoiler"


def walk(node, b, book_level):
    for c in list(node.children):
        if isinstance(c, NavigableString):
            if c.__class__.__name__ == "NavigableString" and str(c).strip():
                b.add(esc(str(c)))
            elif c.__class__.__name__ == "NavigableString" and "\n" not in str(c) and str(c):
                b.add(" ")
            continue
        if not isinstance(c, Tag):
            continue
        cl = classes(c)
        if c.name in ("script", "style", "noscript", "hr", "img", "a") and not c.select(STRUCT_SEL):
            if c.name == "a" and c.get_text(strip=True):
                b.add(esc(c.get_text()))
            continue
        if cl & SKIP_CLS:
            continue
        if c.name in ("h1", "h2", "h3", "h4", "h5"):
            if "page_header" in cl:
                continue
            t, n = heading_parts(c)
            if not t or t in ("Disable Ads", "Books"):
                continue
            lvl = book_level + (1 if "super_header" in cl else 2 if "outline_header" in cl else 3 if c.name == "h2" else 4)
            b.open(t, n, lvl)
            continue
        if "faqErrataSpoiler" in cl:
            b.add(faq_box(c)); continue
        if "abWrap" in cl or "str11Wrap" in cl:
            parent = b.cur
            if "abWrap" in cl:
                nm = c.select_one(".abName")
                nums = [x.get_text(strip=True) for x in nm.select(".h_number")] if nm else []
                t = heading_parts(nm)[0] if nm else "Ability"
                for x in c.select(".abNameWrap"):
                    x.extract()
                body = "".join(inline(x) for x in c.children)
            else:
                nm = c.select_one(".str11Name")
                nums = [x.get_text(strip=True) for x in nm.select(".h_number")] if nm else []
                for x in (nm.select(".h_number") if nm else []):
                    x.extract()
                t = nm.get_text(" ", strip=True).title() if nm else "Stratagem"
                cp = c.select_one(".str11CP"); typ = c.select_one(".str11Type")
                txt = c.select_one(".str11Text")
                cp, typ = (cp.get_text(" ", strip=True) if cp else ""), (typ.get_text(" ", strip=True) if typ else "")
                # stratagems: "1CP · Battle Tactic"; move/shoot types use the same card layout without either
                head = f'<p><b>{esc(cp)}</b>{" · " if cp and typ else ""}{esc(typ)}</p>' if (cp or typ) else ""
                body = head + ("".join(inline(x) for x in txt.children) if txt else "")
            lvl = max(b.cur["l"] + 1 if b.cur and b.cur["l"] < book_level + 4 else book_level + 4, book_level + 3)
            b.open(t, " / ".join(nums), lvl)
            b.add(body)
            b.cur = parent
            continue
        if c.select(STRUCT_SEL):
            walk(c, b, book_level)       # container with headings inside: keep walking in order
        else:
            b.add(inline(c))


def clean_html(parts):
    h = "".join(parts)
    h = re.sub(r"(<br>\s*){3,}", "<br><br>", h)
    h = re.sub(r"^(\s|<br>)+|(\s|<br>)+$", "", h)
    h = re.sub(r"<div>\s*(<br>)?\s*</div>", "", h)
    h = re.sub(r"[ \t\r\n\xa0]+", " ", h)
    return h.strip()


def plain(h):
    t = re.sub(r"<br>|</p>|</li>|</tr>|</div>", "\n", h)
    t = re.sub(r"<[^>]+>", " ", t)
    t = html.unescape(t)
    return re.sub(r"[ \t]+", " ", re.sub(r"\s*\n\s*", "\n", t)).strip()


def parse(pages):
    b = Builder()
    for book, url, src in pages:
        s = BeautifulSoup(src, "lxml")
        main = s.find(id="wahMainContent")
        if not main:
            raise SystemExit(f"{book}: page layout changed (no #wahMainContent)")
        for t in main.select("div.tooltip_templates, .noprint, script, style"):
            t.decompose()
        b.open(book, "", 0)["u"] = url
        walk(main, b, 0)
    secs = []
    for s in b.secs:
        h = clean_html(s.pop("h"))
        if s["l"] == 0:   # Wahapedia's book info table -> one line + "updated" for the source credit
            m = re.search(r"<table>.*?Last update.*?</tr>.*?<tr><td>([^<]*)</td><td>([^<]*)</td><td>([^<]*)</td><td>([^<]*)</td><td>([^<]*)</td></tr></table>", h, re.S)
            if m:
                name, kind, ed, ver, upd = (x.strip() for x in m.groups())
                s["upd"] = upd
                bits = [name, kind, f"{ed}th edition" if ed.isdigit() else ed, f"version {ver}" if ver else "", f"last updated {upd}" if upd else ""]
                h = h[:m.start()] + '<p class="lead">' + " · ".join(esc(x) for x in bits if x) + "</p>" + h[m.end():]
        s["h"] = h; s["x"] = plain(h)
        secs.append(s)
    # drop empty leaf sections that only repeat a heading (e.g. page nav remnants), re-index parents
    keep = [i for i, s in enumerate(secs) if s["l"] < 4 or s["x"] or any(x["p"] == i for x in secs)]
    remap = {old: new for new, old in enumerate(keep)}
    out = []
    for i in keep:
        s = dict(secs[i]); p = s["p"]
        while p is not None and p not in remap:
            p = secs[p]["p"]
        s["p"] = remap.get(p) if p is not None else None
        out.append(s)
    # Wahapedia lists a phase's move/shoot types (Remain Stationary, Normal Move, Advance...) after its last step, so they
    # land under "3. End of Movement Phase". They are sections of the phase itself: move them up to the chapter; a numbered
    # x.y.z rule that follows one of them (e.g. 09.05.01 after Normal Move) stays under that one.
    for e, s in enumerate(out):
        if s["l"] == 3 and re.match(r"^\d+\.\s*End of .*Phase$", s["t"]):
            prev = None
            for c in out:
                if c["p"] != e:
                    continue
                if c["n"] and c["n"].count(".") == 2 and prev is not None:
                    c["p"], c["l"] = prev, 4
                else:
                    c["p"], c["l"] = s["p"], 3
                    prev = out.index(c)
    return out


MUST = ["Lethal Hits", "Deep Strike", "Feel No Pain", "Fire Overwatch", "Battle-shock", "Strategic Reserves", "Devastating Wounds",
        "Sustained Hits", "Leader", "Benefit of Cover", "Engagement"]


def valid(secs):
    allt = " ".join(s["t"] + " " + s["x"] for s in secs).lower()
    miss = [m for m in MUST if m.lower() not in allt]
    return (len(secs) >= 250 and sum(len(s["x"]) for s in secs) >= 150000 and not miss), miss


def content_hash(doc):
    return hashlib.sha256(json.dumps(doc["sections"], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]


def main():
    a = sys.argv
    out = a[a.index("--out") + 1] if "--out" in a else "data/core_rules.json"
    pub = a[a.index("--publish") + 1] if "--publish" in a else None
    src = a[a.index("--html") + 1].split(",") if "--html" in a else None   # offline: saved pages (tests)
    pages = []
    for i, (book, url) in enumerate(PAGES):
        txt = open(src[i], encoding="utf-8").read() if src else \
            urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60).read().decode("utf-8")
        pages.append((book, url, txt))
    secs = parse(pages)
    ok, miss = valid(secs)
    if not ok:
        sys.exit(f"core rules: {len(secs)} sections, missing {miss} - page layout changed? keeping previous data")
    for x in secs:
        x["_x"] = x.pop("x")
    upd = {x["t"]: x.get("upd", "") for x in secs if x["l"] == 0}
    doc = {"source": [{"book": b, "url": u, "updated": upd.get(b, ""), "by": "Wahapedia reproduction of the GW Warhammer 40,000 Core Rules (11th edition)"} for b, u in PAGES],
           "edition": "11th", "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "sections": secs}
    doc["chars"] = sum(len(x.pop("_x")) for x in secs)
    doc["hash"] = content_hash(doc)
    json.dump(doc, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    nfaq = sum(s["h"].count('class="faq"') for s in secs)
    print(f"core rules: {len(secs)} sections ({sum(1 for s in secs if s['l'] == 2)} chapters), {nfaq} FAQ/errata boxes, "
          f"{doc['chars'] // 1000}k chars -> {out} (hash {doc['hash']})")
    if pub:
        try:
            cur = json.load(open(pub, encoding="utf-8"))
        except Exception:
            cur = {}
        if cur.get("hash") == doc["hash"]:
            print(f"  {pub}: unchanged")
        else:
            os.makedirs(os.path.dirname(pub) or ".", exist_ok=True)
            json.dump(doc, open(pub + ".new", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
            os.replace(pub + ".new", pub)
            print(f"  {pub}: UPDATED {cur.get('hash')} -> {doc['hash']}")


if __name__ == "__main__":
    main()
