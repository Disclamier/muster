/* every selectable / fixed weapon in every unit's loadout resolves to a datasheet weapon profile */
const test = require("node:test"), assert = require("node:assert");
const C = require("../app/js/core.js"), P = require("../app/data/points.json"), D = require("../app/data/datasheets.json");
const n = C.norm, I = C.indexData(P);
// known data gaps: the datasheet source has no profile for these (non-weapon picks such as drones / marks are skipped below)
// stale/no-profile options left (no current datasheet profile exists to add):
// BA DC Dreadnought (Legends) smoke launchers (no text in source), CSM Sorcerer khopesh (Thousand Sons only)
const KNOWN = new Set(["blood-angels|Death Company Dreadnought with Magna-Grapple|Smoke Launchers", "chaos-space-marines|Sorcerer|Prosperine khopesh"]);
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
test("previously missing profiles now present (2-source verified): Sicaran (curated GW-app datasheet), Black Templars Gladiator/Repulsor multi-melta, Macharius HK missile", () => {
  const ds = (f, u) => D.factions[f].units[u].wp;
  const g = (f, u, w) => ds(f, u).find((x) => n(x[0]) === n(w));
  for (const f of ["black-templars", "blood-angels", "dark-angels", "deathwatch", "space-marines", "space-wolves"]) {
    assert.equal(g(f, "Sicaran", "Arcus Multi-launcher")[2][0][2], "7", f);
    // GW app / Wahapedia 11e Legends datasheet values (the old secondary-source profiles were 2+ D6 / D6+1 / S4 AP0)
    assert.deepEqual(g(f, "Sicaran", "Hunter-killer Missile")[2][0].slice(3, 7), ["3+", "14", "-3", "D3+3"], f);
    assert.equal(g(f, "Sicaran", "Lascannon")[2][0][6], "D3+3", f);
    assert.deepEqual(g(f, "Sicaran", "Storm Bolter")[2][0].slice(4, 6), ["5", "-1"], f);
    // the multi-melta option exists only on the Black Templars datasheets; the SM codex ones (SM/BA/DA/DW/SW) have none
    for (const u of ["Gladiator Lancer", "Gladiator Reaper", "Repulsor", "Repulsor Executioner"])
      assert.equal(!!g(f, u, "Multi-melta"), f === "black-templars", `${f} ${u}`);
  }
  assert.equal(g("black-templars", "Gladiator Lancer", "Multi-melta")[2][0][6], "D3+2");
  assert.ok(g("astra-militarum", "Macharius Omega", "Hunter-killer missile"));
  assert.ok(g("genestealer-cults", "Macharius Omega", "Hunter-killer missile"));
  // new Custodes codex units keep their own app profiles (no stale pre-codex additions)
  assert.ok(!g("adeptus-custodes", "Telemon Heavy Dreadnought", "Telemon caestus"));
});
const gearTxt = (r) => r.loLines.flatMap((m) => m.gear.map((g) => g.name)).join(" | ");
const unitOf = (f, nm) => P.factions.find((x) => x.id === f).units.find((u) => u.n === nm);
const listWith = (f, unit, p) => ({ id: "t", name: "t", faction: f, sub: f, size: "strikeforce", dets: [], showLegends: true, entries: [
  { uid: "a", unit, models: 1, wargear: {}, addons: [], enh: null, warlord: false, lo: p ? { c: {}, p } : undefined }] });
test("Sicaran default loadout = Armoured Tracks + Heavy Bolter + Herakles-pattern Autocannon (no sponsons); the autocannon swaps to the Arcus/Omega/Punisher/Venator guns", () => {
  for (const f of ["black-templars", "blood-angels", "dark-angels", "deathwatch", "space-marines", "space-wolves"]) {
    const r = C.calcList(listWith(f, "Sicaran"), I).entries[0];
    const txt = gearTxt(r);
    assert.match(txt, /Armoured Tracks/, f); assert.match(txt, /Herakles-pattern Autocannon/, f);
    assert.doesNotMatch(txt, /Two Heavy Bolters|Two Lascannons|Punisher|Venator|Arcus|Omega/, f);
    assert.equal(r.base + r.wargear, 180, f);
  }
  const r = C.calcList(listWith("space-marines", "Sicaran", { "Sicaran|Herakles-pattern Autocannon": { "Venator Neutron Laser": 1 }, "Sicaran|Sponsons": { "Two Lascannons": 1 } }), I);
  const txt = gearTxt(r.entries[0]);
  assert.match(txt, /Venator Neutron Laser/); assert.match(txt, /Two Lascannons/); assert.doesNotMatch(txt, /Herakles/);
  assert.deepEqual(r.warnings.filter((w) => /loadout/.test(w.msg)), []);
});
test("multi-melta picker: Black Templars Gladiators/Repulsors only, charged +10 pts (MFM); no multi-melta slot in the other chapters", () => {
  for (const u of ["Gladiator Lancer", "Gladiator Reaper", "Repulsor", "Repulsor Executioner"]) {
    for (const f of ["blood-angels", "dark-angels", "deathwatch", "space-marines", "space-wolves"])
      assert.ok(!unitOf(f, u).lo.m[0][4].some((s) => s[0] === "Multi-melta"), `${f} ${u}`);
    const plain = C.calcList(listWith("black-templars", u), I).entries[0];
    const mm = C.calcList(listWith("black-templars", u, { [`${u}|Multi-melta`]: { "Multi-melta": 1 } }), I).entries[0];
    assert.equal((mm.base + mm.wargear) - (plain.base + plain.wargear), 10, u);
    assert.match(gearTxt(mm), /Multi-melta/, u);
  }
});
