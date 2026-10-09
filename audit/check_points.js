#!/usr/bin/env node
/* Points audit: freshly scraped Munitorum Field Manual (audit/mfm_parse.py, independent of scraper/) vs what the APP
   computes from app/data/points.json, using the app's own core.js (calcList / modelOptions / addonOptions /
   loadoutWargear), so mapping and multiplier bugs show up the way a player would see them.
   Usage: node audit/check_points.js <mfm_audit.json> [app/data/points.json] [--json out.json]
   Exit 1 on any mismatch (the daily refresh refuses to publish). */
"use strict";
const fs = require("fs"), path = require("path");
const C = require(path.join(__dirname, "../app/js/core.js"));

const norm = (s) => String(s || "").toLowerCase().replace(/[’‘]/g, "'").replace(/\[legends\]/g, "").replace(/\((upgrade|aura)\)/g, "").replace(/[^a-z0-9]/g, "");
const key = (n, lg) => norm(n) + (lg ? "#legends" : "");
const sing = (s) => norm(s).replace(/(es|s)$/, "");
const ORD = { "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5, "6th": 6 };
function tierRange(label) {
  const L = label.toLowerCase();
  let m = /your (\d+(?:st|nd|rd|th)) to (\d+(?:st|nd|rd|th)) units? costs?/.exec(L); if (m) return [ORD[m[1]], ORD[m[2]]];
  m = /your (\d+(?:st|nd|rd|th)) ?\+ units? costs?/.exec(L); if (m) return [ORD[m[1]], null];
  m = /your (\d+(?:st|nd|rd|th)) units? costs?/.exec(L); if (m) return [ORD[m[1]], ORD[m[1]]];
  if (/your units? costs?/.test(L)) return [1, null];
  return null;
}
/* M: audit/mfm_parse.py output, D: app/data/points.json -> {ok, counts, issues, info, spots} */
function audit(M, D, seedIn) {
const I = C.indexData(D);
const SPOT = 3; let seed = +(seedIn || new Date().toISOString().slice(0, 10).replace(/-/g, ""));
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const spots = [];
const issues = [], info = [], counts = { spot: 0, factions: 0, units: 0, unitRows: 0, tiers: 0, wargearLines: 0, loadoutOptions: 0, enhancements: 0, detachments: 0 };
const bad = (fid, msg) => issues.push(`${fid}: ${msg}`);

// how many of <weapon> an option text grants, read from the text alone: "2 X", "X and Y", "X + X", "2x X"
function copiesIn(text, weapon) {
  let n = 0;
  for (const part of String(text).split(/\s*(?:\+|,|\band\b|&)\s*/i)) {
    const pm = /^(\d+)\s*(?:x\s*)?(.+)$/i.exec(part.trim()); const cnt = pm ? +pm[1] : 1, item = pm ? pm[2] : part;
    const si = sing(item), sw = sing(weapon);
    if (si && (si === sw || si.includes(sw) || sw.includes(si))) n += cnt;
  }
  return n;
}
function entryList(fid, u, n, set) {
  const l = C.newList({ name: "audit", faction: fid, sub: fid, size: "strikeforce" });
  for (let i = 0; i < n; i++) { const e = C.newEntry(u); if (i === n - 1) Object.assign(e, set || {}); l.entries.push(e); }
  return C.calcList(l, I).entries[n - 1];
}

for (const [fid, mf] of Object.entries(M.factions)) {
  const AF = I.factions[fid];
  if (!AF) { bad(fid, "faction page in the MFM but not in the app"); continue; }
  counts.factions++;
  // MFM units (duplicates on a page must agree)
  const mu = new Map(), allied = mf.units.filter((u) => /IMPERIUM KEYWORD/i.test(u.group || ""));
  if (allied.length) info.push(`${fid}: ${allied.length} units have a second price list "${allied[0].group}" (Agents taken as allies in another Imperium army); Muster has no allied-Agents mode, so only the faction price list is used and checked`);
  for (const u of mf.units) {
    if (allied.includes(u)) continue;
    const k = key(u.name, u.legends), prev = mu.get(k);
    if (prev && JSON.stringify([prev.tiers, prev.wargear]) !== JSON.stringify([u.tiers, u.wargear])) bad(fid, `${u.name}: listed twice in the MFM with different points`);
    if (!prev) mu.set(k, u);
  }
  const au = new Map(); for (const u of AF.f.units) au.set(key(u.n, u.lg), u);
  for (const [k, m] of mu) {
    counts.units++;
    const u = au.get(k);
    if (!u) { bad(fid, `${m.name}${m.legends ? " (Legends)" : ""}: in the MFM but missing in the app`); continue; }
    if (!!u.lg !== !!m.legends) bad(fid, `${m.name}: Legends flag app=${!!u.lg} MFM=${m.legends}`);
    // ---- unit sizes / tiers, priced through calcList
    const ranges = m.tiers.map((t) => tierRange(t.label));
    if (ranges.some((r) => !r)) { bad(fid, `${m.name}: unknown cost tier label ${JSON.stringify(m.tiers.map((t) => t.label))}`); continue; }
    if ((u.t || []).length !== m.tiers.length) bad(fid, `${m.name}: ${(u.t || []).length} cost tiers in the app, ${m.tiers.length} in the MFM`);
    m.tiers.forEach((t, ti) => {
      counts.tiers++;
      const [from, to] = ranges[ti];
      const at = (u.t || [])[ti];
      if (at && (at[0] !== from || (at[1] ?? null) !== to)) bad(fid, `${m.name}: tier ${ti + 1} copies ${at[0]}-${at[1] ?? "+"} in the app, ${from}-${to ?? "+"} in the MFM`);
      const mo = C.modelOptions(u, from), ao = C.addonOptions(u, from);
      const rows = t.rows.filter((r) => r[1] !== null);
      const mRows = rows.filter((r) => !r[0].trim().startsWith("+")), aRows = rows.filter((r) => r[0].trim().startsWith("+"));
      if (mo.length !== mRows.length) bad(fid, `${m.name} (${t.label}): ${mo.length} size options in the app vs ${mRows.length} in the MFM`);
      if (ao.length !== aRows.length) bad(fid, `${m.name} (${t.label}): ${ao.length} add-ons in the app vs ${aRows.length} in the MFM`);
      for (const [label, p] of mRows) {
        counts.unitRows++;
        const nm = /^(\d+) models?$/i.exec(label.trim());
        const opt = nm ? mo.find((o) => o.models === +nm[1]) : mo.find((o) => norm(o.label) === norm(label));
        if (!opt) { bad(fid, `${m.name} (${t.label}): size "${label}" (${p} pts) not offered by the app`); continue; }
        const r = entryList(fid, u, from, { models: opt.models, ml: opt.label });
        if (norm(r.modelsLabel) !== norm(opt.label)) bad(fid, `${m.name} (${t.label}): "${label}" can't be selected in the app (picks "${r.modelsLabel}")`);
        else if (r.base !== p) bad(fid, `${m.name} (${t.label}) "${label}": app ${r.base} pts, MFM ${p} pts`);
        if (to !== null && to !== from) { const r2 = entryList(fid, u, to, { models: opt.models, ml: opt.label }); if (norm(r2.modelsLabel) === norm(opt.label) && r2.base !== p) bad(fid, `${m.name} copy ${to} "${label}": app ${r2.base}, MFM ${p}`); }
      }
      for (const [label, p] of aRows) {
        counts.unitRows++;
        const a = ao.find((x) => norm(x.label) === norm(label));
        if (!a) { bad(fid, `${m.name} (${t.label}): add-on "${label}" missing in the app`); continue; }
        const r = entryList(fid, u, from, { addons: [a.label] });
        if (r.addons !== p) bad(fid, `${m.name} add-on "${label}": app ${r.addons}, MFM ${p}`);
      }
    });
    // ---- wargear cost lines
    const W = u.w || [];
    for (const [txt, p] of m.wargear) {
      counts.wargearLines++;
      const per = /^per\s+/i.test(txt), name = txt.replace(/^per\s+/i, "");
      const wi = W.findIndex((w) => norm(w[0]) === norm(name));
      if (wi < 0) { bad(fid, `${m.name}: wargear "${txt}" (${p} pts) missing in the app`); continue; }
      if (W[wi][1] !== p) bad(fid, `${m.name}: wargear "${name}" app ${W[wi][1]}, MFM ${p}`);
      if (!per) bad(fid, `${m.name}: flat (not per-item) wargear line "${txt}" - the app charges per item`);
      // every loadout option that grants this weapon must be charged price x copies granted
      const lo = u.lo;
      if (lo) {
        const slots = [...(lo.m || []).flatMap((mm) => mm[4].map((s) => [mm[0], s])), ...(lo.u || []).map((s) => ["*", s])];
        for (const [mn, s] of slots) for (const o of s[1]) {
          if (o[3] !== wi) continue;
          counts.loadoutOptions++;
          const got = (C.loadoutWargear(u, { c: {}, p: { [`${mn}|${s[0]}`]: { [o[0]]: 1 } } })[wi] || 0) * W[wi][1];
          // expected copies, read from the option text only: "2 X", "X and Y", "X + X", "2x X"
          const n = copiesIn(o[0], name);
          if (!n) { info.push(`${fid}: ${m.name}: option "${o[0]}" is priced as ${got / W[wi][1]} x ${name} (linked by GrimSlate grants, name doesn't say)`); continue; }
          if (got !== n * W[wi][1]) bad(fid, `${m.name}: loadout option "${o[0]}" charges ${got} pts, MFM ${n} x ${W[wi][1]} = ${n * W[wi][1]}`);
        }
      }
    }
    for (const w of W) if (!m.wargear.some(([txt]) => norm(txt.replace(/^per\s+/i, "")) === norm(w[0]))) bad(fid, `${m.name}: app charges wargear "${w[0]}" (${w[1]}) that the MFM doesn't list`);
  }
  for (const [k, u] of au) if (!mu.has(k)) bad(fid, `${u.n}: in the app (with points) but not in this MFM page`);
  // ---- end-to-end spot check: SPOT random units (seeded per day) -> a random size, plus a priced wargear option when
  // the unit has one; app calcList total vs a hand sum of the MFM rows (base + per-item cost x copies the text names)
  const pool = [...mu.entries()].filter(([k]) => au.has(k));
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const wg = shuffle(pool.filter(([, m]) => m.wargear.length)), rest = shuffle(pool.filter(([, m]) => !m.wargear.length));
  // at least one unit with an MFM wargear cost per faction (when the page has any), the rest random
  const chosen = [...wg.slice(0, 1), ...shuffle([...wg.slice(1), ...rest])].slice(0, SPOT);
  for (const [k, m] of chosen) {
    const u = au.get(k), t = m.tiers[0], rows = t.rows.filter((r) => r[1] !== null && !r[0].trim().startsWith("+"));
    if (!rows.length) continue;
    const [label, base] = rows[Math.floor(rnd() * rows.length)];
    const nm = /^(\d+) models?$/i.exec(label.trim()), mo = C.modelOptions(u, 1);
    const opt = nm ? mo.find((o) => o.models === +nm[1]) : mo.find((o) => norm(o.label) === norm(label));
    if (!opt) continue;
    const set = { models: opt.models, ml: opt.label };
    let r = entryList(fid, u, 1, set), what = "";
    // swap one slot to a priced option
    if (u.lo && m.wargear.length) {
      const cands = [];
      for (const mm of [...(u.lo.m || []).map((x) => [x[0], x[4]]), ["*", u.lo.u || []]]) for (const sl of mm[1]) for (const o of sl[1]) if (o[3] != null) cands.push([`${mm[0]}|${sl[0]}`, o[0]]);
      if (cands.length) {
        const [slot, oname] = cands[Math.floor(rnd() * cands.length)];
        const lo = JSON.parse(JSON.stringify(r.lo)); lo.p[slot] = { [oname]: 1 };
        r = entryList(fid, u, 1, { ...set, lo }); what = ` with "${oname}"`;
      }
    } else if (m.wargear.length) {
      const wn = m.wargear[0][0].replace(/^per\s+/i, ""), w = (u.w || []).find((x) => norm(x[0]) === norm(wn));
      if (w) { r = entryList(fid, u, 1, { ...set, wargear: { [w[0]]: 2 } }); what = ` with 2 x ${w[0]}`; }
    }
    // hand sum from MFM text: base row + every priced weapon the final loadout carries
    let hand = base;
    for (const [txt, p] of m.wargear) {
      const wn = txt.replace(/^per\s+/i, "");
      for (const sel of Object.values((r.lo || {}).p || {})) for (const [on, c] of Object.entries(sel)) hand += c * copiesIn(on, wn) * p;
      for (const [gn, c] of Object.entries(r.entry.wargear || {})) if (norm(gn) === norm(wn)) hand += c * p;
    }
    counts.spot++;
    spots.push(`${fid}: ${m.name} "${label}"${what}: app ${r.total}, MFM ${hand}`);
    if (r.total !== hand) bad(fid, `spot check ${m.name} "${label}"${what}: app total ${r.total}, MFM hand sum ${hand}`);
  }
  // ---- detachments + enhancements
  const md = new Map(mf.detachments.map((d) => [norm(d.name), d]));
  const ad = new Map(AF.f.dets.map((d) => [norm(d.n), d]));
  for (const [k, d] of md) {
    counts.detachments++;
    const a = ad.get(k);
    if (!a) { bad(fid, `detachment ${d.name}: in the MFM but missing in the app`); continue; }
    if (a.src !== "mfm") bad(fid, `detachment ${d.name}: app marks it as non-MFM (${a.src})`);
    if (a.dp !== d.dp) bad(fid, `detachment ${d.name}: app ${a.dp} DP, MFM ${d.dp} DP`);
    for (const [en, p] of d.enhancements) {
      counts.enhancements++;
      const e = a.enh.find((x) => norm(x[0]) === norm(en));
      if (!e) { bad(fid, `${d.name}: enhancement ${en} missing in the app`); continue; }
      if (e[1] !== p) bad(fid, `${d.name}: enhancement ${en} app ${e[1]}, MFM ${p}`);
      if (/\(upgrade\)/i.test(en) !== !!e[3]) bad(fid, `${d.name}: ${en} upgrade flag app=${!!e[3]}`);
    }
    for (const e of a.enh) if (!d.enhancements.some(([n]) => norm(n) === norm(e[0]))) bad(fid, `${d.name}: app enhancement ${e[0]} not in the MFM`);
  }
  for (const [k, a] of ad) if (!md.has(k)) {
    if (a.src === "mfm") bad(fid, `detachment ${a.n}: app says MFM but the MFM doesn't list it`);
    else info.push(`${fid}: detachment ${a.n} is GrimSlate-only (not in the MFM; flagged in the app)`);
  }
  for (const x of mf.unknown || []) bad(fid, x);
}
for (const f of D.factions) if (!M.factions[f.id]) bad(f.id, "faction in the app but no MFM page was audited");
const res = { ok: issues.length === 0, counts, issues, info, spots };
return res;
}
module.exports = { audit };

if (require.main === module) {
const args = process.argv.slice(2);
const mfmPath = args[0], ptsPath = args[1] && !args[1].startsWith("--") ? args[1] : path.join(__dirname, "../app/data/points.json");
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
if (!mfmPath) { console.error("usage: node audit/check_points.js <mfm_audit.json> [points.json] [--json out] [--verbose]"); process.exit(2); }
const M = JSON.parse(fs.readFileSync(mfmPath, "utf8"));
const D = JSON.parse(fs.readFileSync(ptsPath, "utf8"));
const res = audit(M, D, process.env.AUDIT_SEED);
const { counts, issues, info, spots } = res;
const gh = !!process.env.GITHUB_ACTIONS;
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(res, null, 1));
console.log(`MFM points audit: ${counts.factions} factions, ${counts.units} units, ${counts.tiers} cost tiers, ${counts.unitRows} size/add-on rows, ${counts.wargearLines} wargear lines, ${counts.loadoutOptions} priced loadout options, ${counts.detachments} detachments, ${counts.enhancements} enhancements`);
console.log(`end-to-end spot checks: ${counts.spot} (seed ${process.env.AUDIT_SEED || "today"})`);
if (process.argv.includes("--verbose")) { for (const x of spots) console.log("  spot: " + x); for (const x of info) console.log("  info: " + x); }
else console.log(`  (${info.length} info notes, ${spots.length} spot lines; --verbose to print)`);
if (issues.length) {
  console.log(`\n${issues.length} MISMATCH(ES) between Muster and the live Munitorum Field Manual:`);
  for (const x of issues) console.log((gh ? "::error title=MFM points mismatch::" : "  ✗ ") + x);
  process.exit(1);
}
console.log("OK: zero mismatches");
}
