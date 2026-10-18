/* Daemon Prince stacking characteristic changes (Mark of Chaos wargear + enhancement + detachment rule) and
   loadout bundle names -> weapon profiles (Bloodthirster 'Axe and flail' / 'Axe and lash') */
const test = require("node:test"), assert = require("node:assert");
const C = require("../app/js/core.js"), P = require("../app/data/points.json"), D = require("../app/data/datasheets.json");
const I = C.indexData(P); C.setUnitAbilities(D);
const CSM = "chaos-space-marines", DP = "Heretic Astartes Daemon Prince", DPW = "Heretic Astartes Daemon Prince with wings";
const list = (unit, mark, enh, dets) => ({ id: "t", name: "t", faction: CSM, sub: CSM, size: "strikeforce", dets, entries: [
  { uid: "a", unit, models: 1, wargear: {}, addons: [], enh, warlord: true, lo: mark ? { c: {}, p: { [`${unit}|Mark of Chaos`]: { [mark]: 1 } } } : undefined }] });
function view(unit, mark, enh, dets) {
  const l = list(unit, mark, enh, dets), res = C.calcList(l, I), r = res.entries[0], F = C.getFaction(I, l);
  const ds = D.factions[CSM].units[unit], wp = ds.wp.map((w) => w[0]);
  const mods = C.entryStatMods(F, r, dets, wp);
  const w = (name, prof, stat) => { const W = ds.wp.find((x) => x[0] === name); const p = W[2].find((x) => (x[0] || null) === prof); const kind = W[1];
    const col = { RANGE: 1, A: 2, BS: 3, WS: 3, S: 4, AP: 5, D: 6 }[stat]; return C.statWithMods(stat, p[col], mods.filter((m) => C.weaponMatches(m, kind, name + " " + (prof || ""), p[7]))); };
  const s = (stat) => C.statWithMods(stat, ds.s[stat], mods);
  return { res, mods, w, s };
}
const CABAL = "Cabal of Chaos", WS = "Warpstrike Champions";
test("rules (GW app via 40k.app + Wahapedia 11e): infernal cannon A3; Daemonic Allegiance marks; Cabal enhancements", () => {
  for (const u of [DP, DPW]) {
    assert.equal(D.factions[CSM].units[u].wp.find((w) => w[0] === "Infernal cannon")[2][0][2], "3");
    const sl = P.factions.find((f) => f.id === CSM).units.find((x) => x.n === u).lo.m[0][4].find((x) => x[0] === "Mark of Chaos");
    assert.match(sl[1].find((o) => o[0] === "Tzeentch")[2], /Add 3 to the Attacks characteristic of this model's infernal cannon/);
  }
  const cabal = P.factions.find((f) => f.id === CSM).dets.find((d) => d.n === CABAL);
  assert.deepEqual(cabal.enh.map((e) => e[0]).sort(), ["Conduit of Chaos", "Touched by the Warp"]);   // neither changes A/S/AP
});
for (const u of [DP, DPW]) {
  test(`${u}: each Mark of Chaos changes the right characteristic (highlight + source in the tooltip data)`, () => {
    let v = view(u, "Tzeentch", null, []);
    assert.equal(v.w("Infernal cannon", null, "A").v, "6"); assert.equal(v.w("Hellforged weapons", "strike", "A"), null);
    assert.equal(v.w("Infernal cannon", null, "A").mods[0].enh, "Mark of Chaos: Tzeentch");
    v = view(u, "Khorne", null, []);
    assert.equal(v.w("Hellforged weapons", "strike", "S").v, "10"); assert.equal(v.w("Hellforged weapons", "sweep", "S").v, "8");
    assert.equal(v.w("Infernal cannon", null, "S"), null);
    v = view(u, "Nurgle", null, []); assert.equal(v.s("T").v, String(+D.factions[CSM].units[u].s.T + 1));
    v = view(u, "Slaanesh", null, []); assert.match(v.s("M").v, u === DP ? /^10"/ : /^\d+"/);
    v = view(u, "Chaos Undivided", null, []); assert.equal(v.mods.length, 0);
  });
  test(`${u} in Cabal of Chaos + Mark of Tzeentch + Conduit of Chaos: mark +3 A on the cannon (A6), Empyric Wellspring +2 S / +1 AP on melee (conditional, Dark Pact)`, () => {
    const v = view(u, "Tzeentch", { det: CABAL, name: "Conduit of Chaos" }, [CABAL]);
    assert.deepEqual(v.res.errors.map((e) => e.msg), []);
    assert.equal(v.w("Infernal cannon", null, "A").v, "6");
    const s = v.w("Hellforged weapons", "strike", "S"), ap = v.w("Hellforged weapons", "strike", "AP");
    assert.equal(s.v, "10"); assert.equal(ap.v, "-3"); assert.ok(s.cond && ap.cond);
    assert.match(s.mods[0].cond, /Dark Pact/); assert.equal(s.mods[0].src, "det");
    assert.equal(v.w("Infernal cannon", null, "S"), null);   // the Wellspring ranged +1 S is for PSYKERs excluding DAEMON units
  });
  test(`${u} with Mark of Khorne: Cabal's Empyric Wellspring excludes KHORNE units`, () => {
    const v = view(u, "Khorne", null, [CABAL]);
    assert.ok(!v.mods.some((m) => m.src === "det"));
    assert.equal(v.w("Hellforged weapons", "strike", "S").v, "10");
  });
}
test("Warpstrike Champions Tzagulla (+1 A/S/AP) stacks with Mark of Tzeentch: winged Daemon Prince infernal cannon A7; Deep Strike only", () => {
  const v = view(DPW, "Tzeentch", { det: WS, name: "Tzagulla" }, [WS]);
  assert.deepEqual(v.res.errors.map((e) => e.msg), []);
  const a = v.w("Infernal cannon", null, "A");
  assert.equal(a.v, "7"); assert.deepEqual(a.mods.map((m) => m.enh).sort(), ["Mark of Chaos: Tzeentch", "Tzagulla"]);
  assert.equal(v.w("Infernal cannon", null, "S").v, "6"); assert.equal(v.w("Infernal cannon", null, "AP").v, "-2");
  assert.equal(v.w("Hellforged weapons", "strike", "A").v, "7");
  // the walking Daemon Prince has no Deep Strike: not eligible
  const w = view(DP, "Tzeentch", { det: WS, name: "Tzagulla" }, [WS]);
  assert.match(w.res.errors.map((e) => e.msg).join(), /Deep Strike ability only/);
  const l = list(DP, null, null, [WS]);
  assert.equal(C.enhancementChoices(l, I, "a").find((c) => c.en[0] === "Tzagulla").ok, false);
});
test("Bloodthirster (Chaos Daemons, World Eaters): 'Axe and flail' / 'Axe and lash' show Axe of Khorne + Bloodflail / Lash of Khorne", () => {
  for (const f of ["chaos-daemons", "world-eaters"]) {
    const wp = D.factions[f].units.Bloodthirster.wp.map((w) => w[0]);
    assert.deepEqual(C.gearWeapons("Axe and flail", wp), [["Axe of Khorne", 1], ["Bloodflail", 1]], f);
    assert.deepEqual(C.gearWeapons("Axe and lash", wp), [["Axe of Khorne", 1], ["Lash of Khorne", 1]], f);
    assert.deepEqual(C.gearWeapons("Great axe of Khorne", wp), [["Great axe of Khorne", 1]], f);
  }
});
test("sweep: no loadout option resolves to the same weapon rows as a differently named option of its slot (picking it must change the stats)", () => {
  const W = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((x) => x && !/^(\d+|x|one|two|three|four|a|an|of|the|and|with|w|additional|pair)$/.test(x)).map((x) => x.replace(/(es|s)$/, "")).sort().join();
  const bad = [];
  for (const f of P.factions) for (const u of f.units) {
    const ds = ((D.factions[f.id] || {}).units || {})[u.n]; if (!ds || !u.lo) continue;
    const wp = ds.wp.map((w) => w[0]);
    const key = (g) => String(g).split(" + ").flatMap((p) => C.gearWeapons(p, wp)).map((x) => x[0] + "×" + x[1]).sort().join("|");
    for (const m of u.lo.m) for (const sl of m[4]) {
      const seen = new Map();
      for (const [o] of sl[1]) { const k = key(o); if (!k) continue; const prev = seen.get(k); if (prev && W(prev) !== W(o)) bad.push(`${f.id}|${u.n}|${sl[0]}: ${o} = ${prev}`); else seen.set(k, o); }
    }
  }
  assert.deepEqual(bad, []);
});
