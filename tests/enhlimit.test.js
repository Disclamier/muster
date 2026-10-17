const test = require("node:test"), assert = require("node:assert");
const C = require("../app/js/core.js"), P = require("../app/data/points.json");
const I = C.indexData(P);
// 11th edition core rules 25.03 (GW app / 40k.app): Strike Force = 4 enhancements; only one of each enhancement;
// Upgrades: up to three of the same Upgrade, the 2nd/3rd copy do not count towards the limit (points paid each time).
const E = (uid, unit, models, det, name) => ({ uid, unit, models, wargear: {}, addons: [], enh: name ? { det, name } : null, warlord: uid === "s1" });
const HC = "Honoured Companions", AC = "Auric Champions", SW = "Solar Watch", MM = "Might of the Moritoi", CS = "Celeritous Sentries (Upgrade)";
const list = (entries, dets = [HC, AC, SW]) => ({ id: "t", name: "t", faction: "adeptus-custodes", sub: "adeptus-custodes", size: "strikeforce", dets, entries });
const errs = (l) => C.calcList(l, I).errors.map((e) => e.msg || String(e)).filter((m) => !/Warlord|Force Disposition/.test(m));
const base3 = () => [E("u1", "Custodian Guard Sodality", 3, HC, CS), E("u2", "Sentinel Guard Sodality", 3, HC, CS), E("u3", "Custodian Wardens", 2, HC, CS)];
const chars = (n) => [["Shield-Captain", HC, "Arae-Shrike"], ["Blade Champion", AC, "Inspirational Exemplar"], ["Shield-Captain", AC, "Superior Creation"], ["Shield-Captain on Dawneagle Jetbike", AC, "Shroud of the Hidden Blade"]]
  .slice(0, n).map(([u, d, nm], i) => E("s" + (i + 1), u, 1, d, nm));

test("3 units with the same Upgrade + 3 Character enhancements = 4/4 at Strike Force: valid", () => {
  const l = list([...base3(), ...chars(3)]); const c = C.calcList(l, I);
  assert.equal(c.enhCount, 4); assert.deepEqual(errs(l), []);
});
test("4 Character enhancements alone are valid; a 5th counted enhancement is an explained error", () => {
  assert.deepEqual(errs(list(chars(4))), []);
  const e = errs(list([...base3(), ...chars(4)]));
  assert.equal(e.length, 1); assert.match(e[0], /Enhancements: 5 \/ 4 – 4 Character enhancements \(1 each\) \+ 1 different Upgrade on 3 units \(each different Upgrade counts 1; up to 3 units can share one\)/);
});
test("the same Upgrade on a 4th unit is an error (max 3); a normal enhancement twice is an error (once per army)", () => {
  assert.match(errs(list([...base3(), E("u4", "Custodian Guard Sodality", 3, HC, CS)])).join(), /Celeritous Sentries \(Upgrade\) taken 4 times \(an Upgrade can be given to at most 3 units\)/);
  assert.match(errs(list([E("s1", "Shield-Captain", 1, HC, "Arae-Shrike"), E("s2", "Blade Champion", 1, HC, "Arae-Shrike")])).join(), /Arae-Shrike taken 2 times \(an enhancement can be taken only once per army\)/);
});
test("'(one per army)' Upgrades can only be taken once", () => {
  const n = "Augury Uplink (one per army) (Upgrade)";
  assert.match(errs(list([E("d1", "Telemon Heavy Dreadnought", 1, MM, n), E("d2", "Contemptor-Galatus Dreadnought", 1, MM, n)], [MM])).join(), /taken 2 times \(one per army\)/);
});
test("different Upgrades each count 1 (core rules), so 2 different Upgrades + 3 Character enhancements = 5/4", () => {
  const l = list([E("u1", "Custodian Guard Sodality", 3, HC, CS), E("u2", "Vertus Praetors", 2, SW, "Auric Eagle (Upgrade)"), ...chars(3)]);
  assert.equal(C.calcList(l, I).enhCount, 5); assert.match(errs(l).join(), /2 different Upgrades on 2 units/);
});
test("picker: at 4/4 a 2nd/3rd copy of an Upgrade already taken stays selectable; new Character enhancements are greyed with the reason", () => {
  const l = list([E("u1", "Custodian Guard Sodality", 3, HC, CS), E("u2", "Sentinel Guard Sodality", 3, HC, null), E("u3", "Custodian Wardens", 2, HC, null), ...chars(3), E("s4", "Shield-Captain on Dawneagle Jetbike", 1, null, null)]);
  assert.equal(C.calcList(l, I).enhCount, 4);
  for (const uid of ["u2", "u3"]) assert.ok(C.enhancementChoices(l, I, uid).find((x) => x.en[0] === CS).ok, uid);
  const sf = C.enhancementChoices(l, I, "s4").find((x) => x.en[0] === "Sally Forth");
  assert.equal(sf.ok, false); assert.match(sf.reason, /Enhancement limit reached \(4\/4\): each Character enhancement counts 1, each different Upgrade counts 1/);
  const l3 = list([...base3(), ...chars(3)]);
  const c4 = C.enhancementChoices({ ...l3, entries: [...l3.entries, E("u4", "Custodian Guard Sodality", 3, null, null)] }, I, "u4").find((x) => x.en[0] === CS);
  assert.equal(c4.ok, false); assert.match(c4.reason, /Already taken by 3 units/);
});
test("James's slot examples: 2 Character enhancements + 2 different Upgrades each on 3 units (6 units) = 4/4 valid; 3 Character + 1 Upgrade on 1 unit valid", () => {
  const AE = "Auric Eagle (Upgrade)";
  const l = list([...base3(), E("v1", "Vertus Praetors", 2, SW, AE), E("v2", "Gyrfalcon Jetbike Sodality", 2, SW, AE), E("v3", "Venatari with Verutum Lances", 3, SW, AE), ...chars(2)]);
  assert.equal(C.calcList(l, I).enhCount, 4); assert.deepEqual(errs(l), []);
  const l2 = list([E("u1", "Custodian Guard Sodality", 3, HC, CS), ...chars(3)]);
  assert.equal(C.calcList(l2, I).enhCount, 4); assert.deepEqual(errs(l2), []);
});
