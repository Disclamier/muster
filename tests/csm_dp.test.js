/* Daemon Prince Mark of Chaos options/abilities only on the two Heretic Astartes Daemon Princes (James, 18 Oct) */
const test = require("node:test"), assert = require("node:assert");
const C = require("../app/js/core.js"), P = require("../app/data/points.json"), D = require("../app/data/datasheets.json");
const I = C.indexData(P); C.setUnitAbilities(D);
const MARKS = ["Khorne", "Nurgle", "Slaanesh", "Tzeentch", "Chaos Undivided"];
const DP = ["Heretic Astartes Daemon Prince", "Heretic Astartes Daemon Prince with wings"];
const CSM = P.factions.find((f) => f.id === "chaos-space-marines");
const markSlot = (u) => (u.lo && u.lo.m || []).some((m) => (m[4] || []).some((s) => /mark of chaos/i.test(s[0])));

test("CSM: only the two Daemon Princes have the Mark of Chaos loadout choice and its wargear abilities", () => {
  for (const u of CSM.units) {
    const ds = D.factions["chaos-space-marines"].units[u.n];
    const dp = DP.includes(u.n);
    assert.equal(markSlot(u), dp, `${u.n} mark slot`);
    if (!ds) continue;
    const cards = C.wargearAbilities(u, ds).filter((a) => MARKS.includes(a[0])).map((a) => a[0]);
    const raw = (ds.wa || []).filter((a) => MARKS.includes(a[0])).map((a) => a[0]);
    if (dp) { assert.deepEqual(cards.sort(), ["Khorne", "Nurgle", "Slaanesh", "Tzeentch"], u.n); }
    else { assert.deepEqual(cards, [], `${u.n} shows DP mark cards`); assert.deepEqual(raw, [], `${u.n} data carries DP mark cards`); }
  }
});

test("no unit in any faction outside the Daemon Princes carries the Heretic Astartes Daemon Prince mark texts", () => {
  const dpTexts = new Set(D.factions["chaos-space-marines"].units[DP[0]].wa.map((a) => a[0] + "|" + a[2]));
  for (const [fid, f] of Object.entries(D.factions)) for (const [n, u] of Object.entries(f.units))
    if (!DP.includes(n)) assert.ok(!(u.wa || []).some((a) => dpTexts.has(a[0] + "|" + a[2])), `${fid} ${n}`);
});

test("CSM characters: no mark picker, no mark stat changes; the Daemon Prince keeps both", () => {
  const F = I.factions["chaos-space-marines"];
  const l = C.newList({ name: "x", faction: "chaos-space-marines", sub: "chaos-space-marines" }); l.dets = CSM.dets.map((d) => d.n).slice(0, 1);
  for (const u of CSM.units.filter((x) => (x.kw || []).includes("Character") && !DP.includes(x.n))) {
    assert.equal(C.markChoices(l, F, u), null, u.n);
    const ds = D.factions["chaos-space-marines"].units[u.n]; if (!ds || !C.hasLoadout(u)) continue;
    const lo = C.getLoadout(u, {}, (C.modelOptions(u, 1)[0] || { models: 1 }).models);
    const mods = C.entryStatMods(F, { unit: u, lo, entry: {} }, [], ds.wp.map((w) => w[0]));
    assert.deepEqual(mods.filter((m) => /Khorne|Nurgle|Slaanesh|Tzeentch/.test(m.enh)), [], u.n);
  }
  const dp = CSM.units.find((x) => x.n === DP[0]), dds = D.factions["chaos-space-marines"].units[DP[0]];
  const lo = C.getLoadout(dp, {}, 1); const key = Object.keys(lo.p).find((k) => /Mark of Chaos/.test(k)); assert.ok(key);
  lo.p[key] = { Tzeentch: 1 };
  const mods = C.entryStatMods(F, { unit: dp, lo, entry: {} }, [], dds.wp.map((w) => w[0]));
  assert.ok(mods.some((m) => m.stat === "A" && /Tzeentch/.test(m.enh)), "DP Tzeentch +3 A");
});

/* Pactbound Zealots Marks of Chaos (GW app screenshot from James 18 Oct = 40k.app = Wahapedia 11e) */
const pact = () => { const l = C.newList({ name: "p", faction: "chaos-space-marines", sub: "chaos-space-marines", size: "strikeforce" }); l.dets = ["Pactbound Zealots"]; return l; };
const ALL = ["Khorne", "Tzeentch", "Nurgle", "Slaanesh", "Chaos Undivided"];

test("Pactbound: every non-Epic-Hero HERETIC ASTARTES unit without a mark keyword picks one (vehicles too); Psykers not Khorne; DPs use their own mark", () => {
  const F = I.factions["chaos-space-marines"], l = pact();
  for (const u of CSM.units) {
    const ch = C.markChoices(l, F, u), kw = (u.kw || []).map((k) => k.toLowerCase());
    const fixed = ALL.some((m) => kw.includes(m.toLowerCase()));
    const expect = u.fk === "Heretic Astartes" && !(u.r === "Epic Hero" || kw.includes("epic hero")) && !fixed && !DP.includes(u.n);
    assert.equal(!!ch, expect, u.n);
    if (ch) assert.deepEqual(ch, kw.includes("psyker") ? ALL.filter((m) => m !== "Khorne") : ALL, u.n);
  }
  for (const n of ["Chaos Rhino", "Chaos Land Raider", "Legionaries", "Chaos Lord", "Cultist Mob"]) assert.ok(C.markChoices(l, F, CSM.units.find((u) => u.n === n)), n);
  for (const n of ["Abaddon the Despoiler", "Chaos Lord on Juggernaut", ...DP]) assert.equal(C.markChoices(l, F, CSM.units.find((u) => u.n === n)), null, n);
});

test("Pactbound: mark effects parsed from the rule; missing mark is an error; Character + unit must share the mark", () => {
  const F = I.factions["chaos-space-marines"], l = pact();
  const fx = C.markEffects(l, F);
  assert.deepEqual(Object.keys(fx).sort(), [...ALL].sort());
  assert.deepEqual(fx.Khorne, [["LETHAL HITS", "Each time a model in this unit makes a melee attack, an unmodified Hit roll of 5+ scores a Critical Hit."]]);
  assert.deepEqual(fx.Nurgle.map((x) => x[0]), ["SUSTAINED HITS 1"]); assert.match(fx.Nurgle[0][1], /ranged attack.*5\+/);
  assert.deepEqual(fx["Chaos Undivided"].map((x) => x[0]), ["LETHAL HITS", "SUSTAINED HITS 1"]);
  assert.deepEqual(C.markEffects(C.newList({ faction: "chaos-space-marines" }), F), {});
  const U = (n) => CSM.units.find((u) => u.n === n);
  const lord = C.newEntry(U("Chaos Lord")), leg = C.newEntry(U("Legionaries")); lord.warlord = true;
  l.entries.push(lord, leg);
  let res = C.calcList(l, I);
  assert.equal(res.errors.filter((e) => /select a Mark of Chaos/.test(e.msg)).length, 2);
  lord.mark = "Khorne"; leg.mark = "Nurgle"; lord.attach = leg.uid;
  res = C.calcList(l, I);
  assert.ok(res.errors.some((e) => /must share the same Mark of Chaos/.test(e.msg)));
  assert.equal(C.attachTargets(l, I, lord.uid).find((t) => t.entry.uid === leg.uid).markBad, "Khorne vs Nurgle");
  leg.mark = "Khorne"; res = C.calcList(l, I);
  assert.ok(!res.errors.some((e) => /Mark of Chaos/.test(e.msg)), res.errors.map((e) => e.msg).join("; "));
  assert.equal(C.attachTargets(l, I, lord.uid).find((t) => t.entry.uid === leg.uid).markBad, null);
  assert.match(C.exportText(l, I, {}, "gw"), /Mark of Chaos: Khorne/);
  // outside Pactbound: no picker, no requirement, no mark in the export
  l.dets = [CSM.dets.find((d) => d.n !== "Pactbound Zealots").n];
  res = C.calcList(l, I); assert.ok(!res.errors.some((e) => /Mark of Chaos/.test(e.msg)));
  assert.doesNotMatch(C.exportText(l, I, {}, "gw"), /Mark of Chaos: Khorne/);
});

test("Pactbound: a Daemon Prince's own Mark of Chaos pick is its keyword (attach check + effect)", () => {
  const F = I.factions["chaos-space-marines"], l = pact();
  const dpU = CSM.units.find((u) => u.n === DP[0]);
  const e = C.newEntry(dpU); const lo = C.getLoadout(dpU, e, 1); const key = Object.keys(lo.p).find((k) => /Mark of Chaos/.test(k)); lo.p[key] = { Slaanesh: 1 }; e.lo = lo;
  assert.equal(C.unitMark(l, F, dpU, e), "Slaanesh");
  l.entries.push(e); e.warlord = true;
  assert.ok(!C.calcList(l, I).errors.some((x) => /select a Mark of Chaos/.test(x.msg) && /Daemon Prince/.test(x.msg)));
});
