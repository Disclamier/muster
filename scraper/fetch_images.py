#!/usr/bin/env python3
"""
Download the per-faction artwork shown on the MFM home page tiles into app/assets/factions/ so the app
works offline. For personal use only (artwork belongs to Games Workshop); the app stays marked unofficial.

For each faction tile  <a href="/en/<slug>"> <img src="/_next/image?url=/factions/<uuid>.jpg ...">
  - <slug>.webp        banner (828 px wide, as served by the site's image optimiser)
  - <slug>-thumb.webp  128x128 centre crop for list rows / picker icons
  - index.json         {slug: {uuid, banner, thumb}} (existing images are reused when the uuid is unchanged)
"""
import argparse, io, json, os, re, sys, time, urllib.request
from PIL import Image

BASE = "https://mfm.warhammer-community.com"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 w40k-list-tool/1.0"
HERE = os.path.dirname(os.path.abspath(__file__))


def get(url, accept="*/*", retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except Exception as e:
            if i == retries - 1:
                raise
            time.sleep(2 * (i + 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default=os.path.join(HERE, "..", "app", "assets", "factions"))
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--delay", type=float, default=0.5)
    a = ap.parse_args()
    out = os.path.abspath(a.outdir); os.makedirs(out, exist_ok=True)
    idx_path = os.path.join(out, "index.json")
    old = json.load(open(idx_path)) if os.path.exists(idx_path) else {}
    html = get(f"{BASE}/en").decode("utf-8", "replace")
    found = {}
    for m in re.finditer(r'<a[^>]+href="/en/([a-z0-9-]+)"[^>]*>(.*?)</a>', html, flags=re.S):
        im = re.search(r'(?:%2F|/)factions(?:%2F|/)([0-9a-f-]{36})\.(jpg|jpeg|png|webp)', m.group(2))
        if im:
            found.setdefault(m.group(1), (im.group(1), im.group(2)))
    print(f"{len(found)} faction images on {BASE}/en", file=sys.stderr)
    index, failed = {}, []
    for slug, (uuid, ext) in found.items():
        banner, thumb = f"{slug}.webp", f"{slug}-thumb.webp"
        if not a.force and old.get(slug, {}).get("uuid") == uuid and \
                os.path.exists(os.path.join(out, banner)) and os.path.exists(os.path.join(out, thumb)):
            index[slug] = old[slug]; continue
        try:
            time.sleep(a.delay)
            src = f"{BASE}/_next/image?url=%2Ffactions%2F{uuid}.{ext}&w=828&q=75"
            img = Image.open(io.BytesIO(get(src, "image/webp,image/*"))).convert("RGB")
            img.save(os.path.join(out, banner), "WEBP", quality=72)
            w, h = img.size; s = min(w, h)
            # tiles are wide banners; the subject is usually centred
            box = ((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s)
            img.crop(box).resize((128, 128), Image.LANCZOS).save(os.path.join(out, thumb), "WEBP", quality=75)
            index[slug] = {"uuid": uuid, "banner": banner, "thumb": thumb, "w": w, "h": h}
            print(f"  {slug}: {w}x{h}", file=sys.stderr)
        except Exception as e:
            failed.append(slug); print(f"  ! {slug}: {e}", file=sys.stderr)
            if slug in old:
                index[slug] = old[slug]
    json.dump(index, open(idx_path, "w"), indent=1)
    print(f"images: {len(index)} factions, failed: {failed or 'none'}", file=sys.stderr)
    return 0 if index else 1


if __name__ == "__main__":
    sys.exit(main())
