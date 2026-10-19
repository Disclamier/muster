// Text import: parse accuracy on a corpus of real army-list exports + format round-trips.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const C = require(path.join(__dirname, "../app/js/core.js"));
const P = require(path.join(__dirname, "../app/data/points.json"));
const D = require(path.join(__dirname, "../app/data/datasheets.json"));
const I = C.indexData(P);
const DIR = path.join(__dirname, "corpus");
const LABELS = require(path.join(DIR, "labels.json"));
const FILES = Object.keys(LABELS).sort();
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
const parsed = new Map();
const parse = (f) => { if (!parsed.has(f)) { const p = C.parseListText(read(f), I, D); parsed.set(f, { p, b: p.faction ? C.buildFromParse(p, I, D) : null }); } return parsed.get(f); };
const pct = (a, b) => (100 * a) / b;

test("corpus covers many factions and formats", () => {
  assert.ok(FILES.length >= 200, FILES.length);
  assert.ok(new Set(Object.values(LABELS).map((x) => x.faction)).size >= 25);
  for (const f of ["gw", "nr-gw", "wtc", "wtc-gw", "wtc-full", "listforge", "tournament", "battlescribe", "nr-simple", "freeform"])
    assert.ok(Object.values(LABELS).some((x) => x.format === f), "no sample for " + f);
  for (const f of FILES) assert.equal(C.tiDetectFormat(read(f)), LABELS[f].format, f);
});

test("faction: stated faction matches labels", () => {
  for (const f of FILES) assert.equal(parse(f).p.faction, LABELS[f].faction, f);
});

test("faction auto-detect from unit names when the faction line is removed", () => {
  const names = new Set(["adeptus astartes", "empire tau", "necrones", "tau empire"].map(C.tiKey));
  for (const g of P.groups) for (const s of g.factions) names.add(C.tiKey(s.name));
  for (const fc of P.factions) names.add(C.tiKey(fc.name));
  let ok = 0; const bad = [];
  for (const f of FILES) {
    const t = read(f).split("\n").filter((l) => !/(faction|factions used|army roster)/i.test(l) && !names.has(C.tiKey(l.replace(/^\W+/, ""))) && !/ - .*\(\d.*points?\)/i.test(l) && !/^(Custodes|Necrons) [-–]/.test(l)).join("\n");
    const q = C.parseListText(t, I, D);
    if (q.faction === LABELS[f].faction) ok++; else bad.push(f + ":" + q.faction);
  }
  assert.ok(pct(ok, FILES.length) >= 99, bad.join(", "));
});

test("unit matching >= 98% exact, >= 99% including flagged guesses", () => {
  let units = 0, matched = 0, guessed = 0;
  for (const f of FILES) { const { p } = parse(f); for (const it of p.items) { units++; if (it.match && it.status !== "guessed") matched++; else if (it.match) guessed++; } }
  assert.ok(units > 3500, units);
  assert.ok(pct(matched, units) >= 98, `matched ${matched}/${units}`);
  assert.ok(pct(matched + guessed, units) >= 99, `matched+guessed ${matched + guessed}/${units}`);
});

test("wargear lines resolve >= 92%", () => {
  let ok = 0, bad = 0;
  for (const f of FILES) { const { p, b } = parse(f); if (!b) continue; const s = C.importSummary(p, b); ok += s.gearOk; bad += s.gearBad; }
  assert.ok(pct(ok, ok + bad) >= 92, `${ok}/${ok + bad}`);
});

test("stated unit points add up to the stated total (nothing lost or double-counted)", () => {
  let n = 0, ok = 0; const bad = [];
  for (const f of FILES) { const { p, b } = parse(f); const s = C.importSummary(p, b); if (s.stated == null) continue; n++; if (s.statedUnits === s.stated) ok++; else bad.push(f); }
  assert.ok(n >= 200);
  assert.ok(n - ok <= 3, bad.join(", "));
});

test("warlord, enhancements, attachments, force disposition", () => {
  const m = { wl: [0, 0], enh: [0, 0], att: [0, 0], disp: [0, 0] };
  for (const f of FILES) {
    const t = read(f); const { p } = parse(f);
    if (/^\s*(•\s*)?(Warlord|Seigneur de Guerre|Kriegsherr|Señor de la guerra)\s*$/im.test(t) || /^\+\s*WARLORD:\s*\S/m.test(t) || /[:,]\s*Warlord\b/.test(t)) { m.wl[1]++; if (p.items.filter((x) => x.warlord).length === 1) m.wl[0]++; }
    const enh = (t.match(/^\s*(•\s*)?(Enhancements?|Optimisations?|Verbesserung\w*|Mejora\w*)\s*:/gim) || []).length;
    if (enh) { m.enh[1] += enh; m.enh[0] += Math.min(enh, p.items.filter((x) => x.enhText).length); }
    const att = (t.match(/(Attached as|Attachée en tant que|Angeschlossen als|Unido como)\s*:\s*(Leader|Support|Meneur|Soutien|Anführer|Unterstützung|Líder|Apoyo)/gi) || []).length;
    if (att) { m.att[1] += att; m.att[0] += Math.min(att, p.items.filter((x) => x.attachTarget).length); }
    if (p.disposition || p.dispositionText) { m.disp[1]++; if (p.disposition) m.disp[0]++; }
  }
  assert.ok(m.wl[1] > 200 && m.wl[0] === m.wl[1], JSON.stringify(m));
  assert.ok(m.enh[1] > 400 && pct(m.enh[0], m.enh[1]) >= 99, JSON.stringify(m));
  assert.ok(m.att[1] > 500 && pct(m.att[0], m.att[1]) >= 99, JSON.stringify(m));
  assert.ok(m.disp[1] > 200 && m.disp[0] === m.disp[1], JSON.stringify(m));
});

test("nothing is silently dropped: every non-blank line is a unit, a sub-line or a kept line", () => {
  for (const f of FILES) {
    const t = read(f); const { p } = parse(f);
    const nb = t.replace(/\r/g, "").split("\n").filter((l) => l.replace(/[\u200b-\u200d\ufeff\u00a0]/g, "").trim()).length;
    const acc = p.lines.length + p.items.filter((x) => x.how !== "freeform").length + p.items.reduce((n, x) => n + x.subs.length, 0);
    assert.equal(acc, nb, f);
  }
});

test("unmatched units, gear and enhancements are kept on the list as notes", () => {
  const { p, b } = parse("synth-freeform-custodes.txt");
  const um = p.items.find((x) => /made-up/.test(x.name));
  assert.equal(um.match, null);
  assert.deepEqual(p.detsUnmatched, ["Shield Host"]);
  // the guessed/unmatched items show up in the review summary
  const s = C.importSummary(p, b);
  assert.ok(s.units - s.matched >= 2);
  assert.ok(b.list.entries.some((e) => /Admonimortis/.test(e.note || "")), "unknown enhancement kept as a note");
});

test("free-form lines: dashes, counts, attached to, with, case, plurals", () => {
  const { p, b } = parse("synth-freeform-mixed.txt");
  assert.equal(p.faction, "necrons");
  assert.deepEqual(p.dets, ["Awakened Dynasty"]);
  const by = (n) => p.items.filter((x) => x.match === n);
  assert.equal(by("Overlord")[0].warlord, true);
  assert.equal(by("Overlord")[0].enh.name, "Enaegic Dermal Bond");
  assert.equal(by("Necron Warriors").length, 1, "attached to reuses the listed squad");
  assert.equal(by("Royal Warden")[0].attachTarget, by("Necron Warriors")[0]);
  assert.equal(by("Skorpekh Destroyers")[0].models_n, 6);
  assert.equal(by("Canoptek Doomstalker").length, 1);
  assert.equal(by("Lokhust Heavy Destroyers")[0].models_n, 3);
  assert.equal(b.list.entries.length, 7);
});

test("New Recruit simple + BattleScribe", () => {
  let { p } = parse("synth-nr-simple.txt");
  assert.equal(p.faction, "space-marines"); assert.deepEqual(p.dets, ["Gladius Task Force"]); assert.equal(p.size, "strikeforce");
  assert.equal(p.items.length, 16); assert.equal(p.items.find((x) => x.warlord).match, "Captain");
  assert.equal(p.items.find((x) => x.match === "Hellblaster Squad").models_n, 10);
  ({ p } = parse("bs-um.txt"));
  assert.equal(p.format, "battlescribe"); assert.ok(p.items.every((x) => x.match));
});

test("Muster's own text exports re-import (round-trip)", () => {
  const meta = { mfm_version: "v1", fetched_at: "2026-10-01T00:00:00Z" };
  const canon = (o) => JSON.stringify(o, (k, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, vv]) => !(vv && typeof vv === "object" && !Object.keys(vv).length) && vv !== 0).sort()) : v);
  const sig = (l, fmt) => { const c = C.calcList(l, I); const at = {}; for (const r of c.entries) if (r.attachedTo) at[r.uid] = r.attachedTo.name;
    return l.entries.map((e) => [e.unit, e.models, e.enh ? e.enh.name : "", e.warlord ? 1 : 0, at[e.uid] || "", fmt === "wtc" ? "" : e.note || "", JSON.stringify(e.wargear || {}), canon(C.getLoadout(I.factions[l.faction].units[e.unit], e, e.models) || {})].join("|")).sort(); };
  const res = {};
  for (const f of FILES.filter((x) => /^art/.test(x))) {
    const { b } = parse(f); if (!b) continue;
    for (const fmt of ["gw", "wtc", "wtc-full", "simple"]) {
      const q = C.parseListText(C.exportText(b.list, I, meta, fmt), I, D); const r = C.buildFromParse(q, I, D);
      const ok = q.faction === b.list.faction && r.list.sub === b.list.sub && JSON.stringify(r.list.dets) === JSON.stringify(b.list.dets) && (r.list.disposition || null) === (b.list.disposition || null) && JSON.stringify(sig(b.list, fmt)) === JSON.stringify(sig(r.list, fmt));
      res[fmt] = res[fmt] || [0, 0]; res[fmt][1]++; if (ok) res[fmt][0]++;
    }
  }
  for (const fmt in res) assert.ok(pct(res[fmt][0], res[fmt][1]) >= 88, fmt + " " + res[fmt]);
});

test("JSON and share links still go through the old path", () => {
  const { b } = parse("synth-nr-simple.txt");
  assert.equal(C.tiDetectFormat(JSON.stringify(b.list)), "json");
  assert.equal(C.parseListText("", I, D).items.length, 0);
});
