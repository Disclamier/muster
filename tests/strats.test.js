/* "Stratagems for this unit": TARGET-text keyword matcher on real data (World Eaters, Space Marines, Chaos Daemons,
   Chaos Space Marines) + the 11th-edition Core stratagems. */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const C = require(path.join(__dirname, "../app/js/core.js"));
const D = require(path.join(__dirname, "../app/data/points.json"));
const DS = require(path.join(__dirname, "../app/data/datasheets.json"));
const I = C.indexData(D);
const CORE = DS.core_st.st;

function st(fid, det, name) {
  const n = (x) => x.toLowerCase().replace(/[’‘]/g, "'");   // names come from the app data (straight apostrophes)
  const s = I.factions[fid].dets[det].st.find((x) => n(x[0]) === n(name));
  assert.ok(s, `${fid}/${det}: stratagem ${name}`); return s;
}
const core = (name) => { const s = CORE.find((x) => x[0] === name); assert.ok(s, name); return s; };
function yes(fid, unit, s, msg) { const F = I.factions[fid], u = F.units[unit]; assert.ok(u, unit); const m = C.unitStratMatch(u, F, s); assert.equal(m.ok, true, `${unit} should be able to use ${s[0]} (${C.stratTargetText(s)}) ${msg || ""} – ${m.why}`); return m; }
function no(fid, unit, s, msg) { const F = I.factions[fid], u = F.units[unit]; assert.ok(u, unit); const m = C.unitStratMatch(u, F, s); assert.equal(m.ok, false, `${unit} must NOT get ${s[0]} (${C.stratTargetText(s)}) ${msg || ""} – ${m.why}`); return m; }

test("core stratagems: the 10 from the 11th-edition Core Rules, with source", () => {
  assert.deepEqual(CORE.map((s) => s[0]), ["COMMAND RE-ROLL", "EPIC CHALLENGE", "INSANE BRAVERY", "EXPLOSIVES", "CRUSHING IMPACT",
    "RAPID INGRESS", "FIRE OVERWATCH", "SMOKESCREEN", "HEROIC INTERVENTION", "COUNTEROFFENSIVE"]);
  assert.match(DS.core_st.src, /Core Rules \(11th edition\)/);
  assert.equal(core("COUNTEROFFENSIVE")[1], 2);
  for (const s of CORE) assert.match(s[5], /TARGET:.*\n.*EFFECT:|TARGET:[\s\S]*EFFECT:/);
});

test("core stratagems are keyword-filtered (Grenades/Explosives, Monster/Vehicle, Smoke, Character, Titanic, Heroic Intervention vehicles)", () => {
  const we = "world-eaters";
  yes(we, "Khorne Berzerkers", core("EXPLOSIVES"), "(GRENADES)");
  no(we, "Forgefiend", core("EXPLOSIVES"));
  yes(we, "Forgefiend", core("CRUSHING IMPACT"), "(VEHICLE)");
  yes(we, "Angron", core("CRUSHING IMPACT"), "(MONSTER)");
  no(we, "Khorne Berzerkers", core("CRUSHING IMPACT"));
  yes(we, "Chaos Rhino", core("SMOKESCREEN"), "(SMOKE)");
  no(we, "Khorne Berzerkers", core("SMOKESCREEN"));
  yes(we, "Angron", core("EPIC CHALLENGE"));
  no(we, "Khorne Berzerkers", core("EPIC CHALLENGE"));
  no(we, "Khorne Lord of Skulls", core("FIRE OVERWATCH"), "(excluding TITANIC)");
  yes(we, "Khorne Berzerkers", core("FIRE OVERWATCH"));
  no(we, "Chaos Rhino", core("HEROIC INTERVENTION"), "(VEHICLE that is not CHARACTER/WALKER)");
  yes(we, "Forgefiend", core("HEROIC INTERVENTION"), "(WALKER)");
  yes(we, "Khorne Berzerkers", core("HEROIC INTERVENTION"));
  const any = yes(we, "Khorne Berzerkers", core("COMMAND RE-ROLL")); assert.equal(any.any, true);
  yes(we, "Chaos Rhino", core("COUNTEROFFENSIVE"));
  yes("space-marines", "Intercessor Squad", core("EXPLOSIVES"), "(EXPLOSIVES keyword)");
});

test("World Eaters: Berzerker Warband / Vessels of Wrath stratagems by unit", () => {
  const we = "world-eaters";
  const bw = (n) => st(we, "Berzerker Warband", n), vw = (n) => st(we, "Vessels of Wrath", n);
  yes(we, "Khorne Berzerkers", bw("BERZERKER’S WRATH"), "(KHORNE BERZERKERS unit)");
  no(we, "Eightbound", bw("BERZERKER’S WRATH"));
  yes(we, "Khorne Berzerkers", bw("APOPLECTIC FRENZY"), "(That Khorne Berzerkers unit)");
  no(we, "Forgefiend", bw("APOPLECTIC FRENZY"));
  yes(we, "Forgefiend", bw("HACK AND SLASH"), "(One World Eaters unit)");
  yes(we, "Angron", vw("Scorn the Witch"), "(WORLD EATERS CHARACTER)");
  no(we, "Khorne Berzerkers", vw("Scorn the Witch"));
  // Blood Legions daemons in a World Eaters list are LEGIONES DAEMONICA, not WORLD EATERS
  no(we, "Bloodletters", bw("HACK AND SLASH"));
});

test("Space Marines: Gladius 'INFANTRY/MOUNTED' and faction-wide targets", () => {
  const sm = "space-marines", g = (n) => st(sm, "Gladius Task Force", n);
  yes(sm, "Intercessor Squad", g("Responsive Tactics"), "(ADEPTUS ASTARTES INFANTRY)");
  yes(sm, "Outrider Squad", g("Responsive Tactics"), "(ADEPTUS ASTARTES MOUNTED)");
  no(sm, "Repulsor", g("Responsive Tactics"));
  yes(sm, "Repulsor", g("Armour of Contempt"), "(That ADEPTUS ASTARTES unit)");
  yes(sm, "Intercessor Squad", g("Adaptive Strategy"));
});

test("Chaos Daemons Blood Legion + Chaos Space Marines exclusions", () => {
  const cd = "chaos-daemons", bl = (n) => st(cd, "Blood Legion", n);
  yes(cd, "Bloodletters", bl("Skulls Beget Blood"), "(LEGIONES DAEMONICA KHORNE INFANTRY)");
  yes(cd, "Bloodcrushers", bl("Skulls Beget Blood"), "(… or KHORNE MOUNTED)");
  no(cd, "Bloodthirster", bl("Skulls Beget Blood"), "(a Monster)");
  yes(cd, "Bloodthirster", bl("Wrath Undeniable"), "(LEGIONES DAEMONICA KHORNE)");
  no(cd, "Plaguebearers", bl("Wrath Undeniable"), "(Nurgle)");
  const csm = "chaos-space-marines", iv = st(csm, "Cabal of Chaos", "Infernal Vigour");   // PSYKER/DAEMON (excluding KHORNE)
  yes(csm, "Sorcerer", iv, "(PSYKER)");
  yes(csm, "Defiler", iv, "(DAEMON)");
  no(csm, "Chaos Lord", iv);
  const khorneDaemon = Object.values(I.factions[csm].units).find((u) => (u.kw || []).includes("Daemon") && (u.kw || []).includes("Khorne"));
  if (khorneDaemon) no(csm, khorneDaemon.n, iv, "(excluding KHORNE units)");
  const dm = st(csm, "Creations of Bile", "Delayed Mutations");   // INFANTRY (excluding Damned units)
  yes(csm, "Legionaries", dm);
  const damned = Object.values(I.factions[csm].units).find((u) => (u.kw || []).includes("Damned") && (u.kw || []).includes("Infantry"));
  if (damned) no(csm, damned.n, dm, "(excluding DAMNED)");
});

test("targets that aren't your units are never listed; rule-granted keywords are flagged 'check'", () => {
  const F = I.factions["blood-angels"];
  const enemy = F.f.dets.flatMap((d) => d.st).find((s) => /^That enemy unit/i.test(C.stratTargetText(s)));
  if (enemy) assert.equal(C.unitStratMatch(F.units["Intercessor Squad"], F, enemy).ok, false);
  const sm = I.factions["space-marines"];
  const ace = sm.dets["Headhunter Task Force"] && sm.dets["Headhunter Task Force"].st.find((s) => /Tank Ace/i.test(C.stratTargetText(s)));
  if (ace) { const m = C.unitStratMatch(sm.units["Repulsor"], sm, ace); assert.equal(m.ok, true); assert.equal(m.unsure, true); }
  // grouping: detachments first in list order, Core last
  const we = I.factions["world-eaters"], dets = [we.dets["Vessels of Wrath"], we.dets["Berzerker Warband"]];
  const r = C.unitStratagems(we.units["Khorne Berzerkers"], we, dets, CORE);
  assert.deepEqual(r.groups.map((g) => g.det.n), ["Vessels of Wrath", "Berzerker Warband"]);
  assert.equal(r.groups[1].items.length, 6, "all 6 Berzerker Warband stratagems fit Khorne Berzerkers");
  assert.equal(r.groups[0].items.length, 0, "Vessels of Wrath stratagems are CHARACTER only");
  assert.equal(r.core.total, 10);
  assert.deepEqual(r.core.items.map((x) => x.s[0]), ["COMMAND RE-ROLL", "INSANE BRAVERY", "EXPLOSIVES", "RAPID INGRESS", "FIRE OVERWATCH", "HEROIC INTERVENTION", "COUNTEROFFENSIVE"]);
});
