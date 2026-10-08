#!/usr/bin/env bash
# Refresh all data: scrape MFM (primary) + GrimSlate (secondary) + listhammer win rates, sanity-check, then rebuild app/data.
# Fails safely: scrapes go to a temp dir; existing data is only replaced when the new data passes checks.
#   MFM failure / too few factions or units  -> abort, keep old data, exit 1
#   GrimSlate failure / too few factions     -> keep old grimslate.json (CI: restored from the Actions cache),
#                                               still rebuild with fresh MFM; with NO GrimSlate data at all -> abort
#   Win rates failure                        -> keep the previously published winrates
#   Built data unchanged (same content hash) -> app/data left untouched (no daily commit churn)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="${PYTHON:-python3}"
MIN_FACTIONS="${MIN_FACTIONS:-25}"
MIN_UNITS="${MIN_UNITS:-1400}"
MIN_GS_FACTIONS="${MIN_GS_FACTIONS:-25}"
MIN_LOADOUT_UNITS="${MIN_LOADOUT_UNITS:-1000}"   # built units that must carry GrimSlate keywords/loadouts
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p data app/data

check() {  # check <file> <min_factions> <min_units|0>
  "$PY" - "$@" <<'PYEOF'
import json, sys
f, minf, minu = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
try:
    d = json.load(open(f))
except Exception as e:
    print(f"  invalid JSON: {e}"); sys.exit(1)
nf = len(d.get("factions", [])); nu = sum(len(x.get("units", [])) for x in d.get("factions", []))
print(f"  {f}: {nf} factions, {nu} units, errors={len(d.get('errors', []))}")
sys.exit(0 if nf >= minf and nu >= minu else 1)
PYEOF
}

echo "== MFM (primary)"
if "$PY" scraper/fetch_mfm.py --out "$TMP/mfm.json" && check "$TMP/mfm.json" "$MIN_FACTIONS" "$MIN_UNITS"; then
  cp "$TMP/mfm.json" data/mfm.json
else
  echo "!! MFM scrape failed or looks incomplete - keeping previous data, nothing rebuilt." >&2
  exit 1
fi

echo "== GrimSlate (stratagems / rules text / roles)"
if "$PY" scraper/fetch_grimslate.py --out "$TMP/grimslate.json" --mfm data/mfm.json && \
   check "$TMP/grimslate.json" "$MIN_GS_FACTIONS" 0; then
  cp "$TMP/grimslate.json" data/grimslate.json
else
  echo "!! GrimSlate scrape failed or looks incomplete - keeping previous grimslate.json" >&2
fi

if [ ! -s data/grimslate.json ]; then
  echo "!! no GrimSlate data available (fresh or previous) - not rebuilding; published app data unchanged." >&2
  exit 1
fi

echo "== Faction artwork (MFM tiles -> app/assets/factions, existing images kept on failure)"
"$PY" scraper/fetch_images.py || echo "!! image download failed - keeping existing images" >&2

echo "== Meta win rates (listhammer.info, non-fatal; previous winrates.json kept on failure)"
if "$PY" scraper/fetch_winrates.py --out "$TMP/winrates.json" && "$PY" - "$TMP/winrates.json" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1])); n = len([f for f in d["factions"] if f.get("matchups")])
ds = d.get("datasets") or {}
print(f"  winrates: {len(d['factions'])} factions, {n} with matchups, range {d['date_range']}, "
      f"views {sorted(ds)}, {len([f for f in d['factions'] if f.get('rtt')])} with RTT detail")
sys.exit(0 if len(d["factions"]) >= 20 and n >= 15 and "weekend" in ds else 1)
PYEOF
then
  cp "$TMP/winrates.json" data/winrates.json
else
  echo "!! win-rate fetch failed or looks incomplete - keeping previous winrates.json" >&2
fi

echo "== Build app/data"
if "$PY" scraper/build_data.py --outdir "$TMP/appdata" && check "$TMP/appdata/points.json" "$MIN_FACTIONS" "$MIN_UNITS" && \
   "$PY" - "$TMP/appdata/points.json" "$MIN_LOADOUT_UNITS" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1])); n = sum(1 for f in d["factions"] for u in f["units"] if u.get("lo"))
st = sum(1 for f in d["factions"] for x in f["dets"] if x.get("st"))
print(f"  GrimSlate merge: {n} units with loadouts, {st} detachments with stratagems")
sys.exit(0 if n >= int(sys.argv[2]) and st >= 100 else 1)
PYEOF
then
  "$PY" - "$TMP/appdata" app/data <<'PYEOF'
import json, os, shutil, sys
new, cur = sys.argv[1], sys.argv[2]
nv = json.load(open(os.path.join(new, "version.json")))
try:
    cv = json.load(open(os.path.join(cur, "version.json")))
except Exception:
    cv = {}
def put(name):
    shutil.copyfile(os.path.join(new, name), os.path.join(cur, name + ".new"))
    os.replace(os.path.join(cur, name + ".new"), os.path.join(cur, name))
pts_changed = nv.get("hash") != cv.get("hash") or not os.path.exists(os.path.join(cur, "points.json"))
wr_changed = os.path.exists(os.path.join(new, "winrates.json")) and nv.get("winrates_hash") != cv.get("winrates_hash")
if pts_changed:
    put("points.json")
else:  # keep the published points.json and its timestamps
    for k in ("fetched_at", "gs_fetched_at", "built_at"):
        if k in cv: nv[k] = cv[k]
def ds_units(path):
    try:
        return sum(len(f.get("units", {})) for f in json.load(open(path))["factions"].values())
    except Exception:
        return 0
# datasheets only replace the published ones when they look complete (a stale/partial GrimSlate copy must not wipe them)
ds_ok = ds_units(os.path.join(new, "datasheets.json")) >= int(os.environ.get("MIN_DATASHEETS", "1000"))
if not ds_ok:
    print("  !! datasheets look incomplete - keeping the published datasheets.json", file=sys.stderr)
ds_changed = ds_ok and os.path.exists(os.path.join(new, "datasheets.json")) and (nv.get("datasheets_hash") != cv.get("datasheets_hash") or not os.path.exists(os.path.join(cur, "datasheets.json")))
if ds_changed:
    put("datasheets.json")
elif cv.get("datasheets_hash"):
    nv["datasheets_hash"] = cv["datasheets_hash"]
if wr_changed:
    put("winrates.json")
elif cv.get("winrates_hash"):
    for k in ("winrates_fetched_at", "winrates_range", "winrates_hash"):
        if k in cv: nv[k] = cv[k]
# per-faction recent tournament lists (data/meta-lists/<slug>.json): replace the published set only when the new
# build has a full set, and only with new win rates or when published files are missing
nl, cl = os.path.join(new, "meta-lists"), os.path.join(cur, "meta-lists")
files = sorted(f for f in os.listdir(nl) if f.endswith(".json")) if os.path.isdir(nl) else []
have = set(os.listdir(cl)) if os.path.isdir(cl) else set()
if len(files) >= 15 and (wr_changed or not set(files) <= have):
    os.makedirs(cl, exist_ok=True)
    for f in files:
        shutil.copyfile(os.path.join(nl, f), os.path.join(cl, f + ".new"))
        os.replace(os.path.join(cl, f + ".new"), os.path.join(cl, f))
    for f in os.listdir(cl):
        if f.endswith(".json") and f not in files:
            os.remove(os.path.join(cl, f))
if pts_changed or wr_changed or ds_changed:
    with open(os.path.join(cur, "version.json.new"), "w", encoding="utf-8") as f:
        json.dump(nv, f, ensure_ascii=False, indent=1)
    os.replace(os.path.join(cur, "version.json.new"), os.path.join(cur, "version.json"))
print(f"  points: {'UPDATED ' + str(cv.get('hash')) + ' -> ' + nv['hash'] if pts_changed else 'unchanged (' + nv['hash'] + ')'}; "
      f"winrates: {'updated' if wr_changed else 'unchanged'}; datasheets: {'updated' if ds_changed else 'unchanged'}")
PYEOF
  echo "OK: $(tr -d '\n ' < app/data/version.json)"
else
  echo "!! build failed or GrimSlate merge looks incomplete - app data unchanged" >&2
  exit 1
fi
