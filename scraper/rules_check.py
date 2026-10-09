"""
Weekly rules-text check: re-fetch the Warhammer 40,000 app detachment pages (via 40k.app, headless Chrome), compile
them and diff against the committed override (scraper/overrides/gwapp_detachments.json). Never commits or pushes.

  python3 scraper/rules_check.py              # fetch + compile + report (exit 0 = no changes, 1 = changes, 2 = fetch problem)
  python3 scraper/rules_check.py --apply      # also write the override and run scripts/refresh.sh (fresh MFM + GrimSlate rebuild of app/data) (review, test, commit yourself)
  python3 scraper/rules_check.py --pages DIR  # reuse already fetched pages

Report: data/rules_check.txt (also printed). `make rules-check` / `make rules-apply`.
"""
import argparse, datetime as dt, json, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CUR = os.path.join(HERE, "overrides", "gwapp_detachments.json")
REPORT = os.path.join(ROOT, "data", "rules_check.txt")
sys.path.insert(0, HERE)
import gwapp_override  # noqa: E402

K = gwapp_override.key


def diff(old, new):
    lines, n = [], 0
    for slug in sorted(set(old["factions"]) | set(new["factions"])):
        o = {K(d["name"]): d for d in old["factions"].get(slug, [])}
        w = {K(d["name"]): d for d in new["factions"].get(slug, [])}
        out = []
        out += [f"  + detachment {w[k]['name']} ({w[k]['dp']}DP)" for k in sorted(set(w) - set(o))]
        out += [f"  - detachment {o[k]['name']}" for k in sorted(set(o) - set(w))]
        for k in sorted(set(o) & set(w)):
            a, b, dn, ch = o[k], w[k], w[k]["name"], []
            if a["dp"] != b["dp"]:
                ch.append(f"DP {a['dp']} -> {b['dp']}")
            if a.get("rule") != b.get("rule"):
                ch.append("rule text changed")
            ae = {K(e["name"]): e for e in a["enhancements"]}; be = {K(e["name"]): e for e in b["enhancements"]}
            ch += [f"+ enhancement {be[x]['name']} ({be[x]['pts']} pts)" for x in sorted(set(be) - set(ae))]
            ch += [f"- enhancement {ae[x]['name']}" for x in sorted(set(ae) - set(be))]
            for x in sorted(set(ae) & set(be)):
                if ae[x]["pts"] != be[x]["pts"]:
                    ch.append(f"enhancement {be[x]['name']} {ae[x]['pts']} -> {be[x]['pts']} pts (points stay MFM; check the MFM)")
                if ae[x]["text"] != be[x]["text"]:
                    ch.append(f"enhancement {be[x]['name']} text changed")
            ast = {K(s["name"]): s for s in a["stratagems"]}; bst = {K(s["name"]): s for s in b["stratagems"]}
            ch += [f"+ stratagem {bst[x]['name']} ({bst[x]['cp']}CP)" for x in sorted(set(bst) - set(ast))]
            ch += [f"- stratagem {ast[x]['name']}" for x in sorted(set(ast) - set(bst))]
            for x in sorted(set(ast) & set(bst)):
                if ast[x]["cp"] != bst[x]["cp"]:
                    ch.append(f"stratagem {bst[x]['name']} {ast[x]['cp']} -> {bst[x]['cp']} CP")
                if ast[x]["text"] != bst[x]["text"]:
                    ch.append(f"stratagem {bst[x]['name']} text changed")
            if ch:
                out.append(f"  {dn}: " + "; ".join(ch))
        if out:
            n += len(out)
            lines.append(f"{slug}:"); lines += out
    return n, lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--pages")
    a = ap.parse_args()
    pages = a.pages or os.path.join(tempfile.gettempdir(), "muster-rules-check-" + dt.date.today().isoformat())
    if not a.pages:
        shutil.rmtree(pages, ignore_errors=True)
        r = subprocess.run([sys.executable, os.path.join(HERE, "fetch_gwapp.py"), pages])
        if r.returncode:
            print("fetch failed", file=sys.stderr); return 2
    ver = json.load(open(os.path.join(pages, "version.json"))) if os.path.exists(os.path.join(pages, "version.json")) else {}
    tmp = os.path.join(pages, "compiled.json")
    subprocess.run([sys.executable, os.path.join(HERE, "gwapp_compile.py"), pages, str(ver.get("version") or "?"),
                    str(ver.get("released") or "?"), tmp], check=True)
    old, new = json.load(open(CUR, encoding="utf-8")), json.load(open(tmp, encoding="utf-8"))
    # sanity: a broken fetch (bot check, layout change) must not look like "everything was removed"
    nold = sum(len(v) for v in old["factions"].values()); nnew = sum(len(v) for v in new["factions"].values())
    nst = sum(len(d["stratagems"]) for v in new["factions"].values() for d in v)
    if nnew < 0.9 * nold or nst < 1000:
        print(f"suspicious fetch: {nnew} detachments / {nst} stratagems (committed: {nold}) - nothing applied", file=sys.stderr)
        return 2
    n, lines = diff(old, new)
    head = [f"Rules-text check {dt.datetime.now().strftime('%Y-%m-%d %H:%M')} ({dt.datetime.now().astimezone().tzname()})",
            f"committed: app v{old.get('app_version')} ({old.get('released')}), {nold} detachments",
            f"fetched:   app v{new.get('app_version')} ({new.get('released')}), {nnew} detachments",
            f"{n} detachment(s) with changes" if n else "no changes"]
    txt = "\n".join(head + lines) + "\n"
    open(REPORT, "w", encoding="utf-8").write(txt)
    print(txt)
    if a.apply and n:
        shutil.copy(tmp, CUR)
        # full refresh (fresh MFM + GrimSlate), so app/data is not rebuilt from stale local scrapes
        subprocess.run(["bash", os.path.join(ROOT, "scripts", "refresh.sh")], check=True)
        print(f"applied: {CUR} + app/data refreshed. Review `git diff`, run `make test` + `make audit`, bump sw.js, commit. Not pushed.")
    return 1 if n else 0


if __name__ == "__main__":
    sys.exit(main())
