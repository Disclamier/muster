/* Necron fixes (v59): Canoptek Macrocytes loadout (GW app = Wahapedia), Tomb Blades wargear abilities in the stats view */
const test = require("node:test"), assert = require("node:assert");
const C = require("../app/js/core.js"), P = require("../app/data/points.json"), D = require("../app/data/datasheets.json");
const I = C.indexData(P); C.setUnitAbilities(D);
const NF = P.factions.find((f) => f.id === "necrons"), U = (n) => NF.units.find((u) => u.n === n), DS = (n) => D.factions.necrons.units[n];

test("Macrocytes: default 5 x gauss scalpel + claws; all may take tesla casters; 1 atomiser beam + nanoscarab projector; 1 accelerator mandible", () => {
  const u = U("Canoptek Macrocytes");
  let lo = C.getLoadout(u, {}, 5);
  assert.deepEqual(C.loadoutLines(u, lo).map(C.loadoutText), ["5x Canoptek Macrocyte: Claws, Gauss scalpel"]);
  lo = C.getLoadout(u, { lo: { c: lo.c, p: { "Canoptek Macrocyte|Ranged weapon": { "Tesla caster": 5 } } } }, 5);
  assert.deepEqual(C.loadoutIssues(u, lo, 5), []); assert.equal(lo.p["Canoptek Macrocyte|Ranged weapon"]["Tesla caster"], 5);
  lo = C.setModelCount(u, lo, "Canoptek Macrocyte w/ atomiser beam", 1, 5);
  lo = C.setModelCount(u, lo, "Canoptek Macrocyte w/ accelerator mandible", 1, 5);
  lo = C.getLoadout(u, { lo }, 5);
  assert.deepEqual(lo.c, { "Canoptek Macrocyte": 3, "Canoptek Macrocyte w/ atomiser beam": 1, "Canoptek Macrocyte w/ accelerator mandible": 1 });
  assert.deepEqual(C.loadoutIssues(u, lo, 5), []);
  assert.deepEqual(C.loadoutLines(u, lo).map(C.loadoutText), ["3x Canoptek Macrocyte: Claws, Tesla caster", "1x Canoptek Macrocyte w/ atomiser beam: Claws, Atomiser beam, Nanoscarab projector", "1x Canoptek Macrocyte w/ accelerator mandible: Claws, Accelerator mandible"]);
  // no second atomiser / mandible
  assert.equal(C.setModelCount(u, lo, "Canoptek Macrocyte w/ atomiser beam", 2, 5).c["Canoptek Macrocyte w/ atomiser beam"], 1);
  // every weapon profile exists for the stats view
  const wp = DS(u.n).wp.map((w) => w[0]);
  for (const g of ["Gauss scalpel", "Tesla caster", "Atomiser beam", "Claws"]) assert.ok(wp.includes(g), g);
  assert.deepEqual(C.wargearAbilities(u, DS(u.n)).map((a) => a[1]), ["Nanoscarab Projector", "Accelerator Mandible"]);
});

test("Tomb Blades: Shieldvanes / Nebuloscope / Shadowloom are wargear abilities; one of nebuloscope/shadowloom per model", () => {
  const u = U("Tomb Blades"), ds = DS("Tomb Blades");
  assert.deepEqual(C.wargearAbilities(u, ds).map((a) => a[1]).sort(), ["Nebuloscope", "Shadowloom", "Shieldvanes"]);
  const s = C.loModel(u).types[0].slots.map((x) => x.name);
  assert.deepEqual(s, ["Weapon", "Shieldvanes", "Nebuloscope or Shadowloom"]);
  const lo = C.getLoadout(u, { lo: { c: { "Tomb Blade": 3 }, p: { "Tomb Blade|Nebuloscope or Shadowloom": { Nebuloscope: 2, Shadowloom: 2 } } } }, 3);
  assert.ok(Object.values(lo.p["Tomb Blade|Nebuloscope or Shadowloom"]).reduce((a, b) => a + b, 0) <= 3);
});

test("Shieldvanes change Sv/M: unconditional on all bearers, conditional (naming the bearers) on some", () => {
  const u = U("Tomb Blades"), wp = DS(u.n).wp.map((w) => w[0]), F = I.factions.necrons;
  const lo = (n) => ({ c: { "Tomb Blade": 3 }, p: { "Tomb Blade|Weapon": { "Twin gauss blaster": 3 }, "Tomb Blade|Shieldvanes": { Shieldvanes: n } } });
  let m = C.entryStatMods(F, { unit: u, lo: lo(3), entry: {} }, [], wp);
  assert.equal(C.statWithMods("SV", "4+", m).v, "3+"); assert.equal(C.statWithMods("M", '12"', m).v, '8"'); assert.equal(C.statWithMods("SV", "4+", m).cond, false);
  m = C.entryStatMods(F, { unit: u, lo: lo(1), entry: {} }, [], wp);
  const x = C.statWithMods("SV", "4+", m); assert.equal(x.v, "3+"); assert.equal(x.cond, true); assert.match(m[0].cond, /1 of 3 models with Shieldvanes/);
  assert.deepEqual(C.entryStatMods(F, { unit: u, lo: lo(0), entry: {} }, [], wp), []);
  assert.deepEqual(C.enhStatMods("The bearer has a 3+ Save characteristic and a Move characteristic of 8\".", {}).map((z) => [z.stat, z.v]), [["M", '8"'], ["SV", "3+"]]);
});

test("eye view items: T'au drones map to their weapon profiles", () => {
  assert.deepEqual(C.gearWeapons("Gun Drone", ["Pulse rifle", "Twin pulse carbine"]), [["Twin pulse carbine", 1]]);
  assert.deepEqual(C.gearWeapons("Missile Drone", ["Missile pod", "Burst cannon"]), [["Missile pod", 1]]);
});

test("Accelerator Mandible (targets a friendly unit within 3\") is not a change to the Macrocytes profile", () => {
  const u = U("Canoptek Macrocytes"), wp = DS(u.n).wp.map((w) => w[0]);
  const lo = { c: { "Canoptek Macrocyte": 3, "Canoptek Macrocyte w/ atomiser beam": 1, "Canoptek Macrocyte w/ accelerator mandible": 1 }, p: { "Canoptek Macrocyte|Ranged weapon": { "Gauss scalpel": 3 } } };
  assert.deepEqual(C.entryStatMods(I.factions.necrons, { unit: u, lo, entry: {} }, [], wp), []);
});
