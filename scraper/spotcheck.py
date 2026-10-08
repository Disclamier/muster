"""Independent spot-check: reconstruct the server-rendered HTML (inline React streamed segments)
and read unit costs as plain text, then compare with data/mfm.json."""
import re, html, json, sys, urllib.request
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
def rendered_lines(slug):
    req = urllib.request.Request(f"https://mfm.warhammer-community.com/en/{slug}",
                                 headers={"User-Agent": UA, "Cookie": "isLegendsDisplayed=true"})
    t = urllib.request.urlopen(req, timeout=30).read().decode()
    segs = {m.group(1): m.group(2) for m in re.finditer(
        r'<div hidden id="S:([0-9a-f]+)">(.*?)</div><script>\$RS\("S:\1"', t, flags=re.S)}
    for _ in range(5):
        t2 = re.sub(r'<template id="P:([0-9a-f]+)"></template>', lambda m: segs.get(m.group(1), ""), t)
        if t2 == t: break
        t = t2
    t = re.sub(r'<div hidden id="S:([0-9a-f]+)">.*?</div><script>(?=\$RS\("S:\1")', '<script>', t, flags=re.S)
    s = re.sub(r'<script.*?</script>', '', t, flags=re.S); s = re.sub(r'<[^>]+>', '\n', s)
    return [l.strip() for l in html.unescape(s).split('\n') if l.strip()]
d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "/workspace/w40k/data/mfm.json"))
for slug, name in [("necrons", "LOKHUST DESTROYERS"), ("space-marines", "DESOLATION SQUAD"),
                   ("orks", "GRETCHIN"), ("tyranids", "HIVE TYRANT")]:
    L = rendered_lines(slug)
    i = L.index(name)
    j = i + 1
    while j < len(L) and not (L[j].isupper() and "COST" not in L[j] and "pts" not in L[j]
                              and not re.match(r"^\d", L[j]) and L[j] not in ("▲", "▼", "▲▼", "UPDATED")):
        j += 1
    print(f"== {slug} / {name}\n  live: {' | '.join(L[i:j])}")
    u = [u for f in d["factions"] if f["id"] == slug for u in f["units"] if u["name"] == name][0]
    print("  json:", " | ".join(f'{t["label"]}: ' + ", ".join(f'{c["models"]}m={c["points"]}' for c in t["costs"])
                                for t in u["cost_tiers"]), u.get("wargear_costs", ""))
