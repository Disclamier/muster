#!/usr/bin/env python3
"""Fetch every live Munitorum Field Manual faction page as the browser RENDERS it (headless Chrome over CDP), with the
site's own "show Legends" cookie set, so the audit sees exactly what a player sees. Deliberately independent of
scraper/fetch_mfm.py (which reads the RSC payload): a bug in one can't hide in the other.

usage: python3 audit/mfm_dump.py OUTDIR [slug,slug,...]
Faction slugs are discovered from https://mfm.warhammer-community.com/en unless given. Exits non-zero on any failure.
"""
import json, os, re, shutil, subprocess, sys, tempfile, time, urllib.request

import websocket  # pip install websocket-client

BASE = "https://mfm.warhammer-community.com"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 muster-audit"


def chrome_bin():
    for b in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        if shutil.which(b):
            return b
    sys.exit("audit: no Chrome/Chromium found")


def slugs():
    html = urllib.request.urlopen(urllib.request.Request(BASE + "/en", headers={"User-Agent": UA}), timeout=60).read().decode()
    out = sorted(set(re.findall(r'href="/en/([a-z0-9-]+)"', html)))
    if len(out) < 25:
        sys.exit(f"audit: only {len(out)} faction links on the MFM index - site layout changed?")
    return out


def main():
    outdir = sys.argv[1]
    facs = sys.argv[2].split(",") if len(sys.argv) > 2 else slugs()
    os.makedirs(outdir, exist_ok=True)
    prof = tempfile.mkdtemp(prefix="mfm-audit-")
    port = 9444
    p = subprocess.Popen([chrome_bin(), "--headless=new", "--disable-gpu", "--no-sandbox", f"--remote-debugging-port={port}",
                          "--remote-allow-origins=*", f"--user-data-dir={prof}", f"--user-agent={UA}", "about:blank"],
                         stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    try:
        tabs = None
        for _ in range(100):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json")); break
            except Exception:
                time.sleep(0.2)
        if not tabs:
            sys.exit("audit: Chrome did not start")
        ws = websocket.create_connection([t for t in tabs if t["type"] == "page"][0]["webSocketDebuggerUrl"], timeout=120)
        n = [0]

        def cmd(m, **pr):
            n[0] += 1; ws.send(json.dumps({"id": n[0], "method": m, "params": pr}))
            while True:
                r = json.loads(ws.recv())
                if r.get("id") == n[0]:
                    return r.get("result") or {}

        def text_len():
            return cmd("Runtime.evaluate", expression="document.body ? document.body.innerText.length : 0", returnByValue=True)["result"].get("value", 0)

        cmd("Network.enable")
        cmd("Network.setCookie", name="isLegendsDisplayed", value="true", domain=BASE.split("//")[1], path="/")
        for f in facs:
            ok = False
            for attempt in range(3):
                cmd("Page.navigate", url=f"{BASE}/en/{f}")
                last = -1
                for _ in range(60):
                    time.sleep(1)
                    cur = text_len()
                    if cur == last and cur > 1000:
                        break
                    last = cur
                html = cmd("Runtime.evaluate", expression="document.documentElement.outerHTML", returnByValue=True)["result"]["value"]
                if html.count(" pts") > 5 and "print:break-inside-avoid-page" in html:
                    ok = True; break
            if not ok:
                sys.exit(f"audit: {f} did not render points after 3 tries")
            with open(os.path.join(outdir, f + ".html"), "w") as fh:
                fh.write(html)
            print(f"{f}: {len(html)} bytes", flush=True)
    finally:
        p.kill()
        shutil.rmtree(prof, ignore_errors=True)


if __name__ == "__main__":
    main()
