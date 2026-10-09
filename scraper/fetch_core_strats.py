#!/usr/bin/env python3
"""Core Stratagems (Warhammer 40,000 11th edition Core Rules, section 15) -> data/core_stratagems.json.

Source: Wahapedia's reproduction of the GW Core Rules (https://wahapedia.ru/wh40k11ed/the-rules/core-rules/,
"Warhammer 40,000 Core Rules, Rulebook, edition 11"); the same ten stratagems are listed by GrimSlate's 11th-edition
core stratagems guide. Robots.txt allows /wh40k11ed/the-rules/. One page, fetched once per refresh.
A transcribed copy lives in scraper/overrides/core_stratagems.json and is used whenever a fetch fails or looks wrong.

Output stratagems use the app's detachment stratagem tuple: [NAME, CP, phase, "Core Stratagem", turn, "WHEN: ...\nTARGET: ...\nEFFECT: ..."].
usage: python3 scraper/fetch_core_strats.py [--out data/core_stratagems.json]
"""
import json, re, sys, urllib.request
from datetime import datetime, timezone
from bs4 import BeautifulSoup

URL = "https://wahapedia.ru/wh40k11ed/the-rules/core-rules/"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 muster-data"
TURN = {"str11ColorEither": "Either player’s turn", "str11ColorYour": "Your turn", "str11ColorEnemy": "Opponent’s turn"}
PHASES = ["Command phase", "Movement phase", "Shooting phase", "Charge phase", "Fight phase"]


def text_of(el):
    for li in el.find_all("li"):
        li.insert_before("\n• "); li.unwrap()
    for br in el.find_all("br"):
        br.replace_with("\n")
    t = el.get_text("")
    t = re.sub(r"[ \t\xa0]+", " ", t)
    t = re.sub(r" *\n *", "\n", t)
    t = re.sub(r"\n{2,}", "\n", t).strip()
    # one line per section, list items joined
    t = re.sub(r"\n(?=• )", " ", t)
    t = re.sub(r"\n(?!(WHEN|TARGET|EFFECT|RESTRICTIONS|Leap to Defend|Into the Fray|\+\d ?CP):)", " ", t)
    # Heroic Intervention: "...distance.+1CP • Into the Fray: • When ..." -> "... distance. • Into the Fray (+1CP): When ..."
    t = re.sub(r"\s*\+(\d)\s?CP\s*• ([A-Z][\w ’']+):\s*•?\s*", r" • \2 (+\1CP): ", t)
    return re.sub(r" {2,}", " ", t).strip()


def parse(html):
    s = BeautifulSoup(html, "lxml")
    out, seen = [], set()
    for wrap in s.select("div.str11Wrap"):
        typ = wrap.select_one(".str11Type")
        if not typ or "Core Stratagem" not in typ.get_text():
            continue
        name_el = wrap.select_one(".str11Name")
        for x in name_el.select(".h_number"):
            x.decompose()
        name = name_el.get_text(" ", strip=True)
        if name in seen:          # the page repeats some stratagems in FAQ/errata boxes
            continue
        seen.add(name)
        cp = int(re.sub(r"\D", "", wrap.select_one(".str11CP").get_text()) or 0)
        turn = next((v for k, v in TURN.items() if k in (typ.get("class") or [])), "")
        body = text_of(wrap.select_one(".str11Text"))
        when = re.search(r"WHEN:\s*(.*)", body)
        w = when.group(1) if when else ""
        phase = "Any phase" if re.match(r"any phase", w, re.I) else next((p for p in PHASES if p.lower() in w.lower()), "")
        out.append([name, cp, phase, "Core Stratagem", turn, body])
    return out


def valid(st):
    names = {x[0] for x in st}
    return len(st) >= 8 and all("TARGET:" in x[5] and "EFFECT:" in x[5] for x in st) and \
        {"COMMAND RE-ROLL", "COUNTEROFFENSIVE", "INSANE BRAVERY"} <= names


def main():
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else "data/core_stratagems.json"
    html = urllib.request.urlopen(urllib.request.Request(URL, headers={"User-Agent": UA}), timeout=60).read().decode("utf-8")
    st = parse(html)
    if not valid(st):
        sys.exit(f"core stratagems: parsed {len(st)} - page layout changed? keeping previous data")
    doc = {"source": "Warhammer 40,000 Core Rules (11th edition), section 15 Core Stratagems – via Wahapedia " + URL,
           "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "stratagems": st}
    json.dump(doc, open(out, "w"), ensure_ascii=False, indent=1)
    print(f"core stratagems: {len(st)} -> {out}: " + ", ".join(x[0] for x in st))


if __name__ == "__main__":
    main()
