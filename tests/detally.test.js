const test = require("node:test"), assert = require("node:assert");
const C = require("../app/js/core.js"), P = require("../app/data/points.json");
const I = C.indexData(P);
// Reaper's Wager (Drukhari, GW app v995 / 40k.app / Faction Pack v1.2): "You can include HARLEQUINS units in your army ...
// Incursion: Up to 500 pts, Strike Force: Up to 1000 pts, Onslaught: Up to 1500 pts. No HARLEQUINS models from your army can be
// your WARLORD. If you select this Detachment, you cannot use the Corsairs and Travelling Players army rule."
const RW = "Reaper's Wager";
let n = 0; const E = (unit, x = {}) => Object.assign({ uid: "e" + (++n), unit, wargear: {}, addons: [], enh: null, warlord: false }, x);
const list = (dets, entries, size = "strikeforce") => ({ id: "t", name: "t", faction: "drukhari", sub: "drukhari", size, dets, entries });
const msgs = (l) => C.calcList(l, I).errors.map((e) => e.msg || String(e));
const F = Object.values(I.factions).find((f) => f.f.name === "Drukhari");
const quins = () => [E("Archon", { warlord: true }), E("Troupe Master", { enh: { det: RW, name: "Reaper’s Cowl" } }), E("Solitaire"), E("Shadowseer"),
  E("Voidweaver"), E("Voidweaver"), E("Voidweaver"), E("Skyweavers"), E("Skyweavers"), E("Troupe"), E("Troupe")];   // 950 pts of HARLEQUINS

test("Reaper's Wager: up to 1000 pts of HARLEQUINS at Strike Force, enhancements allowed", () => {
  const l = list([RW], quins()); const c = C.calcList(l, I);
  const a = Object.values(c.allies)[0];
  assert.equal(a.pts, 950); assert.equal(a.al.caps.strikeforce, 1000);
  assert.deepEqual(msgs(l).filter((m) => /HARLEQ|Harleq|Corsair|Troupe|Cowl/.test(m)), []);
});
test("Reaper's Wager: over 1000 pts is an error; caps follow battle size (500 / 1500)", () => {
  assert.ok(msgs(list([RW], [...quins(), E("Death Jester")])).some((m) => /1015/.test(m) && /1000/.test(m)));
  assert.ok(msgs(list([RW], quins(), "incursion")).some((m) => /950/.test(m) && /500/.test(m)));
  assert.equal(C.allyView(F.units["Troupe"], list([RW], []), F).ally.caps.onslaught, 1500);
});
test("Reaper's Wager: no Corsairs and Travelling Players (Anhrathe units blocked), Harlequin Warlord blocked", () => {
  const l = list([RW], [E("Archon", { warlord: true }), E("Corsair Voidreavers")]);
  assert.ok(msgs(l).some((m) => /Corsair Voidreavers/.test(m) && /cannot use the Corsairs and Travelling Players/.test(m)));
  assert.equal(C.unitAllowed(C.allyView(F.units["Corsair Voidreavers"], l, F), l).ok, false);
  assert.ok(msgs(list([RW], [E("Troupe Master", { warlord: true })])).some((m) => /Troupe Master cannot be the Warlord/.test(m)));
});
test("other detachments keep Corsairs and Travelling Players (500 pts, no enhancements)", () => {
  const l = list(["Realspace Raiders"], [E("Archon", { warlord: true }), E("Corsair Voidreavers"), E("Troupe")]);
  assert.equal(Object.values(C.calcList(l, I).allies)[0].al.caps.strikeforce, 500);
  assert.equal(C.unitAllowed(C.allyView(F.units["Corsair Voidreavers"], l, F), l).ok, true);
  assert.ok(msgs(list(["Realspace Raiders"], quins())).some((m) => /Corsairs and Travelling Players: \d+ \/ 500 pts/.test(m)));
});
test("Reaper's Wager enhancements: DRUKHARI-only ones not on Harlequins; HARLEQUINS-only not on Drukhari", () => {
  const d = F.dets[RW], en = (nm) => d.enh.find((x) => x[0] === nm), l = list([RW], []);
  const tm = C.allyView(F.units["Troupe Master"], l, F), ar = F.units["Archon"];
  assert.equal(C.enhEligible(tm, en("Reaper’s Cowl"), F).ok, true);
  assert.equal(C.enhEligible(tm, en("Conductor of Torment"), F).ok, false);
  assert.equal(C.enhEligible(tm, en("Webway Walker"), F).ok, true);
  assert.equal(C.enhEligible(ar, en("Reaper’s Cowl"), F).ok, false);
  assert.equal(C.enhEligible(ar, en("Conductor of Torment"), F).ok, true);
});

// Contagion Engines (Death Guard, GW app v995 / 40k.app / Faction Pack): Lancet of the Worldsore = "Friendly HELBRUTE/MYPHITIC
// BLIGHT-HAULER unit only"; Parasitic Woe-reaper = "CONTAGION ENGINE unit only", CONTAGION ENGINE given by Warped and Rusted Animus
// to FOETID BLOAT-DRONE / FOETID BLOAT-DRONE WITH HEAVY BLIGHT LAUNCHER / HELBRUTE / MYPHITIC BLIGHT-HAULER units.
test("Contagion Engines upgrades only on the eligible engines", () => {
  const G = Object.values(I.factions).find((f) => f.f.name === "Death Guard"), d = G.dets["Contagion Engines"];
  const ok = {}; for (const u of G.f.units) { const r = d.enh.map((en) => C.enhEligible(u, en, G).ok); if (r.some(Boolean)) ok[u.n] = r; }
  assert.deepEqual(ok, { "Foetid Bloat-drone": [false, true], "Foetid Bloat-drone with heavy blight launcher": [false, true], "Helbrute": [true, true], "Myphitic Blight-Haulers": [true, true] });
  const L = { id: "t", name: "t", faction: G.f.id, sub: G.f.id, size: "strikeforce", dets: ["Contagion Engines"], entries: [
    { uid: "a", unit: "Defiler", wargear: {}, addons: [], enh: { det: "Contagion Engines", name: "Parasitic Woe‑reaper (Upgrade)" } },
    { uid: "b", unit: "Foetid Bloat-drone", wargear: {}, addons: [], enh: { det: "Contagion Engines", name: "Lancet of the Worldsore (Upgrade)" } }] };
  const m = C.calcList(L, I).errors.map((e) => e.msg || String(e));
  assert.ok(m.some((x) => /Defiler cannot take Parasitic/.test(x) && /CONTAGION ENGINE unit only/.test(x)));
  assert.ok(m.some((x) => /Foetid Bloat-drone cannot take Lancet/.test(x) && /HELBRUTE\/MYPHITIC BLIGHT-HAULER/i.test(x)));
  const ch = C.enhancementChoices(L, I, "a"); assert.ok(ch.length && ch.every((x) => !x.ok));
});
