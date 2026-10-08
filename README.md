# Muster – offline 40K army list builder (unofficial)

Personal-use Progressive Web App with current **Munitorum Field Manual** points, laid out like New Recruit.
Static files only (no backend, no CDN); works offline once loaded. Not affiliated with Games Workshop –
faction names/artwork are © Games Workshop and are mirrored here for personal use only.

```
app/                    the PWA (deploy this folder)
  index.html  manifest.webmanifest  sw.js
  css/app.css  js/core.js (pure logic, UMD)  js/app.js (UI)
  icons/  assets/factions/ (MFM artwork, 30 factions)  data/{points,version,winrates}.json
scraper/                fetch_mfm.py · fetch_grimslate.py · fetch_winrates.py · fetch_images.py · build_data.py
scripts/refresh.sh      one-command, fail-safe refresh
tests/                  node:test unit tests + jsdom smoke tests + refresh fail-safe test
.github/workflows/refresh.yml   daily refresh + GitHub Pages publish (prepared, not pushed)
```

## Use locally
    make serve            # = cd app && python3 -m http.server 8765  ->  http://localhost:8765/
    make test             # cd tests && npm install (once) && npm test

## Data sources and merge
| Source | Used for | Notes |
|---|---|---|
| MFM (mfm.warhammer-community.com) | **all legal points**: units (cost tiers per copy), wargear add-ons, enhancements, detachment points, Muster battle sizes | primary; Next.js RSC payload |
| GrimSlate | stratagems, detachment rules, enhancement text, unit keywords/roles, **unit compositions + wargear options/default loadouts** (never points); DP for detachments MFM lacks | secondary; MFM always wins; GrimSlate-only detachments are flagged "GrimSlate" and warn |
| listhammer.info | Meta Win Rates tab | server-rendered `__NUXT_DATA__` from `/stats`, `/stats?range=4weeks`, `/factions/<slug>`; `/api/` is never touched (robots.txt) |

`build_data.py` merges `data/mfm.json` + `data/grimslate.json` into `app/data/points.json` (compact keys), writes
`app/data/version.json` (MFM version, fetched_at, content hash, win-rate hash) and copies `data/winrates.json`.

## Refresh
    make refresh          # = scripts/refresh.sh
1. MFM → temp file; must have ≥ MIN_FACTIONS (25) factions and ≥ MIN_UNITS (1400) units, else **abort, old data kept, exit 1**
2. GrimSlate → temp; failure keeps the previous grimslate.json
3. faction artwork (existing images kept on failure)
4. listhammer win rates → temp; needs ≥ 20 factions / 15 with matchups, else previous winrates.json kept
5. build into a temp dir, re-check, then atomically move into `app/data`

Individual steps: `python3 scraper/fetch_mfm.py` (~45–70 s), `fetch_grimslate.py` (~3 min), `fetch_winrates.py` (~50 s), `fetch_images.py`, `build_data.py`.

## In the app: loadouts
Unit options panel shows a New Recruit-style tree from GrimSlate compositions: each model type with its count
(upgrade models such as "Intercessor w/ Grenade Launcher" trade with their base model, min/max incl. size-dependent
maxima), fixed weapons, and each weapon slot as radios (one per model), checkboxes (optional) or counters (multi-model).
Defaults come from GrimSlate's default choices. Options whose name/weapon matches an MFM wargear cost
(e.g. Macro Plasma Incinerator +10) are priced automatically from the MFM. Roster rows and all exports show loadout lines
("1x Intercessor Sergeant: Bolt pistol, Bolt Rifle, Close combat weapon"). Loadout problems are warnings, not errors.

## In the app: list-building rules
* **Multiple detachments**: every selected detachment's rule, enhancements and stratagems are shown, grouped under
  its name (Detachment panel, Configuration card, unit Stratagems, Stratagems export).
* **Detachment-locked units** (`u.req`): neither source has an explicit field, so `build_data.py` derives it from
  the MFM page's named sub-groups (e.g. World Eaters "BLOOD LEGIONS"), the GrimSlate faction keyword, and the
  detachment whose rule names that group. Currently: Blood Legions → Khorne Daemonkin, Plague Legions → Tallyband
  Summoners, Scintillating Legions → Changehost of Deceit, Legions of Excess → Carnival of Excess. Hidden in the
  catalog unless the detachment is selected (toggle shows them greyed); an error if the detachment is removed.
* **Leaders / Support** (MFM "Leader"/"Support" lists): "Attach to" in the unit panel, one Leader + one Support per
  bodyguard, nested in the roster, "Attached to: …" in exports, warnings for invalid attachments.
* **Enhancements**: keyword restrictions parsed from the text ("WORLD EATERS INFANTRY model only", "(excluding …)"),
  each once per army, one per attached unit, the battle-size limit, no Epic Heroes (unless the text names them).
  Restrictions whose wording can't be mapped to keywords fall back to the basic rules.

## In the app: points updates
On start the app shows cached data (IndexedDB) immediately, then fetches `data/version.json` network-first.
If the hash changed it downloads the new `points.json`, recalculates every saved list and shows a banner:
which lists changed (old → new total, per unit/enhancement/detachment) plus all unit/enhancement/detachment
changes. Offline it keeps using the cached data; the service worker also serves the last data files.
Saved lists live in localStorage on the device (export/import JSON to move them).

## Deploy (GitHub Pages) – prepared, not pushed
This folder is already a git repo (branch `main`, one local commit, no remote). What gets committed:
`app/` (the whole site incl. `app/data` and faction art), `scraper/`, `scripts/`, `tests/`, the workflow, and
`data/build_stats.json`. Raw scraper output (`data/mfm.json`, `data/grimslate.json` ~11 MB, `data/winrates.json`,
logs, `raw/`) is git-ignored: the workflow regenerates it, and keeps the last good copy in the Actions cache.

1. Create an empty GitHub repo (public = free Pages on any plan; private Pages needs a paid plan) and push:
   `git remote add origin https://github.com/<user>/<repo>.git && git push -u origin main`.
2. Repo → Settings → Pages → *Build and deployment*: **Source = GitHub Actions**.
3. Settings → Actions → General → *Workflow permissions*: **Read and write permissions**.
4. Run *Refresh points & publish* once from the Actions tab (workflow_dispatch). It then runs daily at 09:37 UTC
   (04:37 CDT / 03:37 CST): restore cached scrapes → `scripts/refresh.sh` → tests → commit changed `app/data` →
   publish `app/` to Pages. Every push to `main` re-runs tests + publishes (no scrape).
5. Open `https://<user>.github.io/<repo>/` on the phone and "Add to Home Screen" / "Install app".

Fail-safe behaviour (covered by `tests/refresh_failsafe.sh`):
* MFM scrape fails / looks incomplete → refresh exits 1 before rebuilding; `app/data` untouched.
* GrimSlate fails → previous `grimslate.json` (cache) is used; if there is none at all → exit 1, `app/data` untouched.
* listhammer fails → previously published win rates are kept.
* Built data must pass sanity checks (factions, units, ≥1000 units with loadouts, ≥100 detachments with stratagems).
* Same content hash as the published data → nothing is rewritten or committed (no daily 2 MB churn).
* The refresh step may fail without failing the job; the tests then run on whatever is on disk. If tests fail,
  nothing is committed and the site is not redeployed (the previous deploy stays live).
Note: GitHub pauses scheduled workflows in a repo with no activity for 60 days; re-enable from the Actions tab.
All asset paths are relative, so the app works from a sub-path. Any static host works the same way: upload `app/`.

## mfm.json
{source, fetched_at (UTC), source_version ("v1.5"), language, elapsed_seconds, errors[],
 factions:[{id (slug), uuid, name, url, version,
   units:[{name, id, legends, source_group?, points_change? ("increased"/"decreased"),
           costs:[{models, points}]                # first tier = what you pay for your 1st copy
           cost_tiers:[{label, from_unit, to_unit|null, costs:[{models, points, change?, label?}]}],
           wargear_costs?:[{name, points, per_item}], leader_of?:[], support_for?:[], changes?:[]}],
   detachments:[{name, id, detachment_points, force_dispositions[], restrictions?, support?, changes?,
                 enhancements:[{name, points, change?}]}],
   enhancements:[{detachment, name, points}]}]}
`change` = delta vs previous MFM as shown by the site (e.g. -10). `label` is kept when the site lists a
composition instead of "N models" (models is then summed from the label; null for add-ons like
"+ 1 Tidewall Defence Platform").

## grimslate.json
{source, fetched_at, factions:[{id, name, source_roster, url,
   detachments:[{name, detachment_points, force_disposition, unique_tag, rule{name,text},
                 enhancements:[{name, points, is_upgrade, text}],
                 stratagems:[{name, cp, phase, turn, type, text}]}],
   units:[{name, keywords, faction_keyword, costs:[{models, points}], model_constraints{minModels,maxModels},
           composition:[{name, min, max, fixed[], upgrades_from, max_at_size, add_on,
                         options:[{slot, default[], min_total, max_total, optional, options:[{name, max, grants[], text, max_at_size}]}]}],
           unit_wargear_options:[slot…], wargear_costs:[{item, points, match_names}]}]}],
 comparison_with_mfm:{dp_disagreements, dp_filled_from_grimslate, enhancement_disagreements,
                      detachments_missing_in_grimslate, detachments_only_in_grimslate}}

## winrates.json
{source, source_url, date_range{label, dates}, ranges{weekend, 4weeks}, notes, fetched_at, dispositions_4weeks[],
 factions:[{name, slug, url, mfm_id, win_rate, games, wins, losses, players, x0, x1, event_wins, event_count, overrep,
   last_4_weeks{win_rate, games, players, x0, x1, top4, event_wins, overrep}, overall_6mo{win_rate, games},
   weekly[{week, win_rate, games}],
   detachments[{name ("A | B" combination), parts[], win_rate, games, wins, losses, players, field_pct, mfm[{faction, name, src}]}],
   detachments_single[{name, win_rate, games, wins, losses, players, mfm}]   # derived: sums combos containing it
   matchups[{opponent, opponent_mfm_id, opponent_slug, win_rate, games, wins, losses, avg_diff, go_first{win_rate, games, avg_diff}}],
   dispositions{name: players}}]}
