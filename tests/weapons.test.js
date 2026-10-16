/* every selectable / fixed weapon in every unit's loadout resolves to a datasheet weapon profile */
const test = require("node:test"), assert = require("node:assert");
const C = require("../app/js/core.js"), P = require("../app/data/points.json"), D = require("../app/data/datasheets.json");
const n = C.norm;
// known data gaps: the datasheet source has no profile for these (non-weapon picks such as drones / marks are skipped below)
const KNOWN = new Set([
  "adeptus-custodes|Allarus Custodians|Misericordia", "adeptus-custodes|Caladius Grav-tank|Twin arachnus heavy blaze cannon",
  "adeptus-custodes|Contemptor-Achillus Dreadnought|Twin adrathic destructor", "adeptus-custodes|Telemon Heavy Dreadnought|Armoured feet",
  "adeptus-custodes|Telemon Heavy Dreadnought|Telemon caestus and twin plasma projector", "adeptus-custodes|Venerable Contemptor Dreadnought|Contemptor combat weapon",
  "astra-militarum|Macharius Omega|hunter-killer missile", "genestealer-cults|Macharius Omega|hunter-killer missile",
  "black-templars|Gladiator Lancer|Multi-melta", "black-templars|Gladiator Reaper|Multi-melta", "black-templars|Repulsor|Multi-melta", "black-templars|Repulsor Executioner|Multi-melta",
  "black-templars|Sicaran|Arcus Multi-launcher", "black-templars|Sicaran|Omega Plasma Array", "black-templars|Sicaran|Punisher Rotary Cannon", "black-templars|Sicaran|Venator Neutron Laser",
  "blood-angels|Death Company Marines|Grenade Launcher", "blood-angels|Death Company Dreadnought with Magna-Grapple|Smoke Launchers", "chaos-space-marines|Sorcerer|Prosperine khopesh",
  "dark-angels|Land Speeder Vengeance|Close Combat Weapon", "dark-angels|Ravenwing Darkshroud|Close Combat Weapon"]);
const SKIP = /drone$|^(khorne|nurgle|slaanesh|tzeentch|chaos undivided)$/i;
function unresolved() {
  const out = [];
  for (const f of P.factions) for (const u of f.units) {
    const ds = ((D.factions[f.id] || {}).units || {})[u.n]; if (!ds || !u.lo || u.af) continue;
    const wp = ds.wp.map((w) => w[0]);
    const other = [...(ds.wa || []).flatMap((a) => [a[0], a[1]]), ...(ds.ab || []).map((a) => a[0])].filter(Boolean).map(n);
    const names = new Set(); for (const m of u.lo.m) { m[3].forEach((x) => names.add(x)); for (const sl of m[4]) for (const o of sl[1]) names.add(o[0]); }
    for (const g of names) for (const part of String(g).split(" + ")) {
      if (SKIP.test(part.trim()) || C.gearWeapons(part, wp).length) continue;
      if (other.some((x) => x && (n(part).includes(x) || x.includes(n(part))))) continue;   // wargear ability (shield, icon...)
      out.push(`${f.id}|${u.n}|${part}`);
    }
  }
  return out;
}
test("Defiler: picked excruciator cannons / heavy reaper autocannons resolve to profiles with counts", () => {
  const wp = D.factions["chaos-space-marines"].units["Defiler"].wp.map((w) => w[0]);
  assert.deepEqual(C.gearWeapons("Two excruciator cannons", wp), [["Excruciator cannon", 2]]);
  assert.deepEqual(C.gearWeapons("Two magma cutters", wp), [["Magma cutter", 2]]);
  assert.deepEqual(C.gearWeapons("Heavy reaper autocannon", wp), [["Heavy reaper autocannon", 1]]);
  assert.deepEqual(C.gearWeapons("Ectoplasma destructor", wp), [["Ectoplasma destructor", 1]]);
});
test("every wargear option of every unit resolves to a weapon profile (or a wargear ability); only known data gaps remain", () => {
  const bad = unresolved();
  const K = new Set([...KNOWN].map((x) => x.toLowerCase())); const fresh = bad.filter((x) => !K.has(x.toLowerCase()));
  assert.deepEqual(fresh, [], "unresolvable:\n" + fresh.join("\n"));
});
