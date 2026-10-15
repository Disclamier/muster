/* Second Leaders only where a datasheet allows it; enhancements that let the bearer join extra units (MFM 'LEADER:'). */
const test = require("node:test"), assert = require("node:assert");
const C = require("../app/js/core.js"), P = require("../app/data/points.json"); const I = C.indexData(P);
function list(fid, det, spec) {
  const F = I.factions[fid]; const l = C.newList({ name: "t", faction: fid, sub: fid, size: "strikeforce" }); l.dets = det ? [det] : [];
  const E = spec.map(([n, o]) => { const e = C.newEntry(F.units[n]); Object.assign(e, o || {}); l.entries.push(e); return e; });
  spec.forEach(([, , to], i) => { if (to != null) E[i].attach = E[to].uid; });
  return { l, E, c: C.calcList(l, I) };
}
const errs = (c) => c.errors.map((e) => e.msg).filter((m) => /Leader|attached|join/.test(m));
test("Death Guard: two different Plague Marine leaders ok, same leader twice not", () => {
  assert.deepEqual(errs(list("death-guard", null, [["Plague Marines"], ["Foul Blightspawn", 0, 0], ["Plague Surgeon", 0, 0]]).c), []);
  assert.equal(errs(list("death-guard", null, [["Plague Marines"], ["Foul Blightspawn", 0, 0], ["Foul Blightspawn", 0, 0]]).c).length, 1);
});
test("Necrons: Obyron + Zahndrekh ok; two Overlords not", () => {
  assert.deepEqual(errs(list("necrons", null, [["Lychguard"], ["Nemesor Zahndrekh", 0, 0], ["Vargard Obyron", 0, 0]]).c), []);
  assert.equal(errs(list("necrons", null, [["Lychguard"], ["Nemesor Zahndrekh", 0, 0], ["Overlord", 0, 0]]).c).length, 1);
});
test("Cadian Shock Troops: two leaders, max one Command Squad", () => {
  assert.deepEqual(errs(list("astra-militarum", null, [["Cadian Shock Troops"], ["Cadian Command Squad", 0, 0], ["Cadian Castellan", 0, 0]]).c), []);
  assert.equal(errs(list("astra-militarum", null, [["Cadian Shock Troops"], ["Cadian Command Squad", 0, 0], ["Cadian Command Squad", 0, 0]]).c).length, 1);
});
test("Kroot Carnivores: two leaders only at 20 models", () => {
  const F = I.factions["tau-empire"]; const ld = F.f.units.filter((u) => (u.ldr || []).some((x) => /KROOT CARNIVORES/.test(x))).map((u) => u.n);
  assert.ok(ld.length >= 2, ld.join());
  assert.deepEqual(errs(list("tau-empire", null, [["Kroot Carnivores", { models: 20 }], [ld[0], 0, 0], [ld[1], 0, 0]]).c), []);
  assert.equal(errs(list("tau-empire", null, [["Kroot Carnivores", { models: 10 }], [ld[0], 0, 0], [ld[1], 0, 0]]).c).length, 1);
});
test("Emperor's Children: Exalted Patron lets a Lord Exultant join Flawless Blades", () => {
  const det = "Court of the Phoenician";
  const no = list("emperors-children", det, [["Flawless Blades"], ["Lord Exultant", 0, 0]]);
  assert.ok(no.c.warnings.concat(no.c.errors).some((x) => /cannot be attached/.test(x.msg)));
  const yes = list("emperors-children", det, [["Flawless Blades"], ["Lord Exultant", { enh: { det, name: "Exalted Patron" } }, 0]]);
  assert.ok(!yes.c.warnings.concat(yes.c.errors).some((x) => /cannot be attached/.test(x.msg)));
  assert.ok(C.attachTargets(yes.l, I, yes.E[1].uid).some((t) => t.unit.n === "Flawless Blades"));
});
test("Necrons Cursed Legion: Murdermind bearer can join Destroyer units as Support", () => {
  const F = I.factions.necrons; const d = F.dets["Cursed Legion"]; const en = d.enh.find((x) => x[0] === "Murdermind");
  assert.equal(en[4].k, "support"); assert.ok(en[4].u.includes("SKORPEKH DESTROYERS"));
});
