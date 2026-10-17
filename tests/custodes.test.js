const test = require("node:test"), assert = require("node:assert");
const C = require("../app/js/core.js"), P = require("../app/data/points.json"), D = require("../app/data/datasheets.json"); const I = C.indexData(P);
const mk = (es, dets = ["Aquilan Shield"]) => ({ id: "c", name: "c", faction: "adeptus-custodes", sub: "adeptus-custodes", size: "strikeforce", dets, entries: es });
const E = (uid, unit, models, x) => ({ uid, unit, models, wargear: {}, addons: [], enh: null, ...(x || {}) });

test("Custodes MFM v1.6: Allarus Custodians 2 = 180, 3 = 270 (3rd+ copy 210 / 300)", () => {
  assert.equal(C.calcList(mk([E("a", "Allarus Custodians", 3)]), I).total, 270);
  assert.equal(C.calcList(mk([E("a", "Allarus Custodians", 2)]), I).total, 180);
  const three = C.calcList(mk([1, 2, 3].map((i) => E("a" + i, "Allarus Custodians", 3))), I);
  assert.equal(three.total, 270 + 270 + 300);
});

test("Custodes codex: 13 detachments with DP + enhancement points, Shield Host Ka'tah rules; no control characters in rules text", () => {
  const F = P.factions.find((f) => f.id === "adeptus-custodes");
  assert.equal(F.dets.length, 13);
  const g = F.dets.find((d) => d.n === "Guardians of the Throne"); assert.equal(g.dp, 3);
  for (const d of F.dets) if (d.n !== "Guardians of the Throne") assert.equal(d.dp, 1, d.n);
  const aq = F.dets.find((d) => d.n === "Aquilan Shield");
  assert.deepEqual(aq.enh.map((e) => [e[0], e[1]]), [["Not a Shell Wasted", 10], ["Pareldor’s Caducatrix", 30]]);
  assert.match(F.dets.find((d) => d.n === "Dread Host").rule[1], /Favoured ka'tah\nDacatarai\nAdditional Effect/);
  assert.doesNotMatch(JSON.stringify(P) + JSON.stringify(D), /\\u000[0-8]|\\u0007/);
  const ds = D.factions["adeptus-custodes"].units;
  assert.deepEqual([ds["Allarus Custodians"].s.T, ds["Allarus Custodians"].s.W], ["8", "6"]);
  assert.ok(ds["Shield-Captain"].ab.some((a) => /Vengeful Surge/.test(a[0])));
});
