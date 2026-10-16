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
test("Retinue joins: Ogryn Bodyguard + Attachés join a Command Squad that leads Shock Troops", () => {
  const { c } = list("astra-militarum", [["Cadian Shock Troops"], ["Cadian Command Squad", 0, 0], ["Ogryn Bodyguard", 0, 1], ["Regimental Attachés", 0, 1]]);
  assert.deepEqual(errs(c, /join|Leader|attached|more than/), []);
  const r = c.entries.find((x) => x.unit.n === "Ogryn Bodyguard"); assert.equal(r.attachKind, "join");
  assert.match(C.attachText(r, c), /Cadian Command Squad.*\(joined\)/);
});
test("Retinue joins: one Loyal Protector per Command Squad, and Loyal Protector must join", () => {
  assert.equal(errs(list("astra-militarum", [["Cadian Command Squad"], ["Ogryn Bodyguard", 0, 0], ["Nork Deddog", 0, 0]]).c, /more than one Loyal Protector/).length, 1);
  assert.equal(errs(list("astra-militarum", [["Ogryn Bodyguard"]]).c, /must join/).length, 1);
});
test("Servitor Retinue: GK Servitors only join a unit led by a Brotherhood Techmarine; Court of the Archon joins Kabalites led by an Archon", () => {
  assert.deepEqual(errs(list("grey-knights", [["Strike Squad"], ["Brotherhood Techmarine", 0, 0], ["Servitors", 0, 0]]).c, /join|Leader|attached|more than|led by/), []);
  assert.equal(errs(list("grey-knights", [["Strike Squad"], ["Servitors", 0, 0]]).c, /led by a Brotherhood Techmarine/).length, 1);
  const t = list("grey-knights", [["Strike Squad"], ["Brotherhood Techmarine", 0, 0], ["Servitors"]]);
  assert.ok(C.attachTargets(t.l, I, t.E[2].uid).some((x) => x.kind === "join" && x.unit.n === "Strike Squad"));
  assert.deepEqual(errs(list("drukhari", [["Kabalite Warriors"], ["Archon", 0, 0], ["Court of the Archon", 0, 0]]).c, /join|Leader|attached|more than|led by/), []);
});
test("Daemon legions: Plague / Scintillating / Blood Legions capped at 1000 pts in Strike Force, no Warlord", () => {
  for (const [fid, lab] of [["death-guard", "Plague Legions"], ["thousand-sons", "Scintillating Legions"], ["world-eaters", "Blood Legions"]]) {
    const u = Object.values(I.factions[fid].units).find((x) => x.grp === lab);
    assert.equal(u.ally.caps.strikeforce, 1000, lab); assert.ok(u.ally.nw);
  }
});
test("Assigned Agents: per-category caps (Strike Force 2 Retinue / 2 Character / 1 Requisitioned)", () => {
  const F = I.factions["space-marines"]; assert.equal(F.units["Inquisitor"].ally.label, "Assigned Agents");
  assert.deepEqual(errs(list("space-marines", [["Intercessor Squad"], ["Inquisitor"], ["Ministorum Priest"]]).c, /Assigned Agents/), []);
  assert.equal(errs(list("space-marines", [["Inquisitor"], ["Ministorum Priest"], ["Navigator"]]).c, /Assigned Agents: 3 \/ 2 Character/).length, 1);
});
test("Freeblades / Dreadblades: 1 Titanic or up to 3 Armigers (not both), no Warlord / Enhancements", () => {
  const ok = list("astra-militarum", [["Cadian Shock Troops"], ["Armiger Helverin"], ["Armiger Warglaive"], ["Armiger Helverin"]]).c;
  assert.deepEqual(errs(ok, /Freeblades/), []);
  assert.equal(errs(list("astra-militarum", [["Knight Paladin"], ["Armiger Helverin"]]).c, /Freeblades: either/).length, 1);
  assert.equal(errs(list("astra-militarum", [["Knight Paladin"], ["Knight Warden"]]).c, /Freeblades: 2 \/ 1 Titanic/).length, 1);
  assert.equal(errs(list("death-guard", [["War Dog Stalker"], ["Knight Tyrant"]]).c, /Dreadblades: either/).length, 1);
  assert.ok(I.factions["space-marines"].units["Knight Paladin"].ally.ne);
});
test("Aeldari Support Artillery: one platform joins a Guardian Defenders unit", () => {
  assert.deepEqual(errs(list("aeldari", [["Guardian Defenders"], ["D-Cannon Platform", 0, 0]]).c, /join|attached|more than/), []);
  assert.equal(errs(list("aeldari", [["Guardian Defenders"], ["D-Cannon Platform", 0, 0], ["Vibro Cannon Platform", 0, 0]]).c, /more than one Support Weapon/).length, 1);
});
test("Datasheet default wargear filled in (Dark Apostle bolt pistol, Wulfen Dreadnought storm bolter)", () => {
  assert.ok(I.factions["chaos-space-marines"].units["Dark Apostle"].lo.m[0][3].includes("Bolt pistol"));
  assert.ok(I.factions["space-wolves"].units["Wulfen Dreadnought"].lo.m[0][3].includes("Storm bolter"));
});
