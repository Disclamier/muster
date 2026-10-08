#!/usr/bin/env bash
# Verifies scripts/refresh.sh fails safe. Runs against a throw-away copy of the repo with the network scrapers faked:
#   1. MFM scrape fails                       -> exit 1, nothing changed
#   2. MFM returns too little                 -> exit 1, nothing changed
#   3. GrimSlate fails and no previous copy   -> exit 1, published app data unchanged
#   4. GrimSlate + win rates fail, previous GrimSlate copy present, same MFM -> exit 0, app/data untouched (no churn)
#   5. MFM points really changed -> exit 0, new points.json/version.json published
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$W/repo/app/assets/factions" "$W/repo/data" "$W/bin"
cp -r "$ROOT/scripts" "$ROOT/scraper" "$W/repo/"; cp -r "$ROOT/app/data" "$W/repo/app/"
cp "$ROOT/app/assets/factions/index.json" "$W/repo/app/assets/factions/" 2>/dev/null || true
[ -f "$ROOT/data/mfm.json" ] && cp "$ROOT/data/mfm.json" "$W/mfm.good.json"
[ -f "$ROOT/data/grimslate.json" ] && cp "$ROOT/data/grimslate.json" "$W/gs.good.json"
R="$W/repo"
sums() { (cd "$R" && find app/data -type f | sort | xargs sha256sum | sha256sum); }
run() {  # run <mfm: fail|tiny|good> <gs: fail|good>
  cat > "$W/bin/python3" <<PY
#!/usr/bin/env bash
case "\$1" in
  scraper/fetch_mfm.py) case "$1" in fail) echo "simulated network failure" >&2; exit 1;;
      tiny) echo '{"factions":[{"id":"x","units":[{"name":"a"}]}],"errors":[]}' > "\$3"; exit 0;;
      good) cp "$W/mfm.good.json" "\$3"; exit 0;; esac;;
  scraper/fetch_grimslate.py) [[ "$2" == good ]] && { cp "$W/gs.good.json" "\$3"; exit 0; }; echo "simulated GrimSlate failure" >&2; exit 1;;
  scraper/fetch_images.py) exit 0;;
  scraper/fetch_winrates.py) echo "simulated listhammer failure" >&2; exit 1;;
esac
exec /usr/bin/env python3 "\$@"
PY
  chmod +x "$W/bin/python3"
  PYTHON="$W/bin/python3" bash "$R/scripts/refresh.sh" > "$W/log" 2>&1
}
expect() {  # expect <name> <rc wanted: 0|nonzero> <rc>
  local after; after=$(sums)
  if [[ ( "$2" == 0 && $3 -eq 0 || "$2" != 0 && $3 -ne 0 ) && "$before" == "$after" ]]; then echo "ok - refresh: $1 (exit $3, app data unchanged)"
  else echo "not ok - refresh: $1 (exit $3)"; cat "$W/log"; exit 1; fi
}
before=$(sums)
run fail fail; expect "MFM scrape fails" nonzero $?
run tiny fail; expect "MFM scrape too small" nonzero $?
if [[ -f "$W/mfm.good.json" && -f "$W/gs.good.json" ]]; then
  rm -f "$R/data/grimslate.json"
  run good fail; expect "GrimSlate fails with no previous copy" nonzero $?
  grep -q "no GrimSlate data available" "$W/log" || { echo "not ok - expected GrimSlate abort message"; cat "$W/log"; exit 1; }
  cp "$W/gs.good.json" "$R/data/grimslate.json"
  # prime: build once from these raw files (they may come from an older scrape than the committed app/data)
  run good fail || { echo "not ok - priming build failed"; cat "$W/log"; exit 1; }
  before=$(sums)
  run good fail; expect "GrimSlate + win rates fail, previous GrimSlate kept, same MFM -> nothing republished" 0 $?
  grep -q "points: unchanged" "$W/log" || { echo "not ok - expected 'points: unchanged'"; cat "$W/log"; exit 1; }
  # 5. a real points change is published
  python3 - "$W/mfm.good.json" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1])); u = d["factions"][0]["units"][0]
for c in u["costs"] + [c for t in u.get("cost_tiers") or [] for c in t["costs"]]: c["points"] += 5
json.dump(d, open(sys.argv[1], "w"))
PYEOF
  run good fail; rc=$?
  if [[ $rc -eq 0 && "$before" != "$(sums)" ]] && grep -q "points: UPDATED" "$W/log"; then echo "ok - refresh: real MFM points change is published (exit 0)"
  else echo "not ok - refresh: points change not published (exit $rc)"; cat "$W/log"; exit 1; fi
else
  echo "ok - refresh: GrimSlate cases skipped (no local data/mfm.json + data/grimslate.json)"
fi
