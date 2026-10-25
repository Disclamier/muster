const test = require("node:test"), assert = require("node:assert");
const C = require("../app/js/core.js"), P = require("../app/data/points.json");
const I = C.indexData(P);
// GW app v995 / 40k.app / Wahapedia / BSData (New Recruit): "For every 3 models in this unit, this unit can have 1 Plasmacyte."
const F = Object.values(I.factions).find((f) => f.f.name === "Necrons");
for (const name of ["Skorpekh Destroyers", "Ophydian Destroyers"]) {
  test(`${name}: 1 Plasmacyte per 3 models (3 -> 1, 6 -> 2)`, () => {
    const M = C.loModel(F.units[name]);
    const s = M.unit.find((x) => x.opts.some((o) => o.name === "Plasmacyte")), o = s.opts.find((x) => x.name === "Plasmacyte");
    assert.equal(C.optMax(o, 3, s, 1), 1);
    assert.equal(C.optMax(o, 6, s, 1), 2);
  });
}
test("Skorpekh Destroyers: 2 Plasmacytes saved on a 3-model unit are clamped to 1; 6 models keep 2", () => {
  const u = F.units["Skorpekh Destroyers"], lo = { c: { "Skorpekh Destroyer": 3 }, p: { "*|Unit Composition": { Plasmacyte: 2 } } };
  assert.equal(C.getLoadout(u, { lo }, 3).p["*|Unit Composition"].Plasmacyte, 1);
  assert.equal(C.getLoadout(u, { lo: { c: { "Skorpekh Destroyer": 6 }, p: lo.p } }, 6).p["*|Unit Composition"].Plasmacyte, 2);
});
test("Plasmacyte slot range follows unit size (0–1 at 3 models, 0–2 at 6)", () => {
  const M = C.loModel(F.units["Ophydian Destroyers"]), s = M.unit[0];
  assert.deepEqual(C.slotRange(s, 1, 3), [0, 1]); assert.deepEqual(C.slotRange(s, 1, 6), [0, 2]);
});
