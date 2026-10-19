/* Chaos Daemons army rule "Daemonic Pact": HERETIC ASTARTES / CHAOS KNIGHTS armies may include LEGIONES DAEMONICA units
   (250/500/750 pts, no Warlord / Enhancements, per god: non-BATTLELINE <= BATTLELINE). Sources: GW app / Wahapedia 11e, BSData wh40k-11e. */
const test = require("node:test"), assert = require("node:assert");
const C = require("../app/js/core.js"), P = require("../app/data/points.json");
const I = C.indexData(P);
function list(fid, names, size) {
  const F = I.factions[fid]; const l = C.newList({ name: "t", faction: fid, sub: fid, size: size || "strikeforce" }); l.dets = [Object.keys(F.dets)[0]];
  for (const n of names) { assert.ok(F.units[n], `${fid}: ${n}`); l.entries.push(C.newEntry(F.units[n])); }
  return { l, F, c: C.calcList(l, I) };
}
const errs = (c, rx) => c.errors.map((e) => e.msg).filter((m) => rx.test(m));

test("Daemonic Pact: CSM and Chaos Knights get every LEGIONES DAEMONICA unit (Epic Heroes, Undivided, Soul Grinder) with 250/500/750 caps", () => {
  const cd = P.factions.find((f) => f.id === "chaos-daemons").units.filter((u) => u.fk === "Legiones Daemonica" || u.n === "Soul Grinder");
  for (const fid of ["chaos-space-marines", "chaos-knights"]) {
    const F = I.factions[fid];
    for (const u of cd) { const a = F.units[u.n]; assert.ok(a && a.ally && a.ally.label === "Daemonic Pact", `${fid} ${u.n}`); }
    const u = F.units["Bloodletters"].ally; assert.deepEqual(u.caps, { incursion: 250, strikeforce: 500, onslaught: 750 }); assert.ok(u.nw && u.ne);
    assert.deepEqual(u.gr, ["Khorne", "Tzeentch", "Nurgle", "Slaanesh"]);
    assert.ok(F.units["Be'lakor"] && F.units["Skarbrand"], "Epic Heroes allowed");
    assert.ok(!Object.values(F.units).some((x) => x.af === "chaos-daemons" && x.ally.label !== "Daemonic Pact"));
  }
});
test("Daemonic Pact is not offered to WE / DG / TS / EC (no HERETIC ASTARTES keyword); they keep their Legion groups", () => {
  for (const fid of ["world-eaters", "death-guard", "thousand-sons", "emperors-children"])
    assert.ok(!Object.values(I.factions[fid].units).some((u) => u.ally && u.ally.label === "Daemonic Pact"), fid);
});
test("Daemonic Pact: per-god ratio non-BATTLELINE <= BATTLELINE", () => {
  assert.deepEqual(errs(list("chaos-space-marines", ["Legionaries", "Bloodletters", "Bloodcrushers"]).c, /Daemonic Pact/), []);
  const bad = errs(list("chaos-space-marines", ["Legionaries", "Bloodletters", "Bloodcrushers", "Karanak"]).c, /Daemonic Pact/);
  assert.equal(bad.length, 1); assert.match(bad[0], /2 non-Battleline KHORNE units but only 1 KHORNE BATTLELINE unit/);
  // a Battleline of another god does not cover Khorne; Undivided units are outside the ratio
  assert.equal(errs(list("chaos-space-marines", ["Legionaries", "Plaguebearers", "Bloodcrushers"]).c, /KHORNE/).length, 1);
  assert.deepEqual(errs(list("chaos-space-marines", ["Legionaries", "Be'lakor"]).c, /non-Battleline/), []);
  // a datasheet Allegiance pick (Daemon Prince of Chaos, Furies, Chaos Spawn) gives the god keyword for the ratio
  const { l } = list("chaos-space-marines", ["Legionaries", "Plaguebearers", "Daemon Prince of Chaos"]);
  assert.equal(errs(C.calcList(l, I), /KHORNE/).length, 1, "default Khorne allegiance");
  l.entries[2].lo = { p: { "Daemon Prince of Chaos|Allegiance": { Nurgle: 1 } } };
  assert.deepEqual(errs(C.calcList(l, I), /non-Battleline/), [], "Nurgle allegiance covered by Plaguebearers");
});
test("Daemonic Pact: points cap, no Warlord, no Enhancements", () => {
  assert.equal(errs(list("chaos-space-marines", ["Legionaries", "Be'lakor", "Bloodletters", "Nurglings"]).c, /Daemonic Pact: \d+ \/ 500 pts/).length, 1);
  assert.equal(errs(list("chaos-space-marines", ["Legionaries", "Bloodletters"], "incursion").c, /Daemonic Pact/).length, 0);
  assert.equal(errs(list("chaos-space-marines", ["Legionaries", "Bloodletters", "Pink Horrors"], "incursion").c, /Daemonic Pact: \d+ \/ 250 pts/).length, 1);
  const { l, F } = list("chaos-space-marines", ["Bloodthirster"]); l.entries[0].warlord = true;
  assert.equal(errs(C.calcList(l, I), /cannot be the Warlord \(Daemonic Pact\)/).length, 1);
  assert.equal(C.enhEligible(F.units["Bloodmaster"], F.dets[Object.keys(F.dets)[0]].enh[0] || ["x", 0, ""], F).ok, false);
});
test("Daemonic Pact picker greying: cap and ratio", () => {
  const { c, F } = list("chaos-space-marines", ["Legionaries", "Bloodletters", "Bloodcrushers"]);
  const r = C.allyAddCheck(F.units["Flesh Hounds"], c.allies, c.size, C.minCost(F.units["Flesh Hounds"], 1));
  assert.equal(r.ok, false); assert.match(r.reason, /Add a KHORNE BATTLELINE unit first/);
  assert.ok(C.allyAddCheck(F.units["Bloodletters"], c.allies, c.size, 110).ok);
  assert.match(C.allyAddCheck(F.units["Be'lakor"], c.allies, c.size, C.minCost(F.units["Be'lakor"], 1)).reason, /Would exceed the Daemonic Pact cap/);
  assert.ok(C.allyAddCheck(F.units["Furies"], c.allies, c.size, 50).ok === false && C.allyAddCheck(F.units["Soul Grinder"], c.allies, c.size, 180).ok);
  // Allegiance units stay addable while any god has room (Nurgle here)
  const c2 = list("chaos-space-marines", ["Legionaries", "Bloodletters", "Bloodcrushers", "Plaguebearers"]).c;
  assert.ok(C.allyAddCheck(F.units["Daemon Prince of Chaos"], c2.allies, c2.size, 165).ok);
  const e = C.allyAddCheck(F.units["Bloodcrushers"], {}, c.size, 95); assert.equal(e.ok, false, "first non-Battleline needs a Battleline");
});
