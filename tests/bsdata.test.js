/* New Recruit (BSData wh40k-11e) parity: leader targets, second leaders, default wargear, allied units with caps */
const test = require("node:test"), assert = require("node:assert");
const C = require("../app/js/core.js"), P = require("../app/data/points.json"); const I = C.indexData(P);
function list(fid, spec, dets) {
  const F = I.factions[fid]; const l = C.newList({ name: "t", faction: fid, sub: fid, size: "strikeforce" }); l.dets = dets || [Object.keys(F.dets)[0]];
  const E = spec.map(([n, o]) => { const e = C.newEntry(F.units[n]); Object.assign(e, o || {}); l.entries.push(e); return e; });
  spec.forEach(([, , to], i) => { if (to != null) E[i].attach = E[to].uid; });
  return { l, E, c: C.calcList(l, I), F };
}
const errs = (c, rx) => c.errors.map((e) => e.msg).filter((m) => rx.test(m));
test("Legends epic heroes lead the units their datasheet names (Captain Tycho -> Intercessor-type squads)", () => {
  const F = I.factions["blood-angels"]; assert.ok(F.units["Captain Tycho"].ldr.includes("STERNGUARD VETERAN SQUAD"));
  assert.ok(I.factions["space-wolves"].units["Canis Wolfborn"].ldr.includes("THUNDERWOLF CAVALRY"));
});
test("Aeldari: The Visarch joins a unit Yvraine leads", () => {
  const { c } = list("aeldari", [["Guardian Defenders"], ["Yvraine", 0, 0], ["The Visarch", 0, 0]]);
  assert.deepEqual(errs(c, /Leader|attached/), []);
});
test("CSM Sorcerer and Sororitas Dialogus carry their bolt pistol", () => {
  assert.ok(I.factions["chaos-space-marines"].units["Sorcerer"].lo.m[0][3].includes("Bolt pistol"));
  assert.ok(I.factions["adepta-sororitas"].units["Dialogus"].lo.m[0][3].includes("Bolt pistol"));
});
test("Brood Brothers: Astra Militarum units in Genestealer Cults, capped at 1000 pts (Strike Force), no excluded keywords", () => {
  const F = I.factions["genestealer-cults"];
  assert.ok(F.units["Cadian Shock Troops"] && F.units["Cadian Shock Troops"].ally.label === "Brood Brothers");
  assert.ok(!F.units["Commissar"] && !F.units["Ogryn Squad"]);
  const many = Array.from({ length: 12 }, () => ["Leman Russ Battle Tank"]);
  assert.equal(errs(list("genestealer-cults", many).c, /Brood Brothers: \d+ \/ 1000/).length, 1);
  assert.equal(errs(list("genestealer-cults", [["Cadian Shock Troops"]]).c, /Brood Brothers/).length, 0);
});
test("Drukhari: Harlequins/Anhrathe allies can't take Enhancements or be Warlord", () => {
  const F = I.factions["drukhari"]; const u = F.units["Troupe Master"]; assert.ok(u.ally);
  const d = Object.values(F.dets).find((x) => x.enh && x.enh.length); 
  assert.equal(C.enhEligible(u, d.enh[0], F).ok, false);
  const { c } = list("drukhari", [["Troupe Master", { warlord: true }]]);
  assert.equal(errs(c, /cannot be the Warlord \(Corsairs/).length, 1);
});
test("Imperial Knights: Mechanicus Allies (500 pts) and Chaos Knights: Wretched Thralls", () => {
  assert.ok(I.factions["imperial-knights"].units["Skitarii Rangers"].ally);
  assert.ok(I.factions["chaos-knights"].units["Cultist Mob"].ally);
});
test("GW export puts allied units under ALLIED UNITS (like the Warhammer 40,000 app)", () => {
  const { l } = list("genestealer-cults", [["Neophyte Hybrids"], ["Cadian Shock Troops"]]);
  const t = C.exportText(l, I, {}, "gw"); assert.match(t, /ALLIED UNITS\n\nCadian Shock Troops/);
});
