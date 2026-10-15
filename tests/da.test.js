/* Dark Angels chapter units: datasheets from the Warhammer 40,000 app (40k.app v972, Oct 2026) via
   scraper/overrides/gwapp_datasheets.json; points stay MFM v1.5. Guards against the pre-codex secondary-source profiles. */
const test = require("node:test"), assert = require("node:assert");
const DS = require("../app/data/datasheets.json").factions["dark-angels"].units;
const P = require("../app/data/points.json").factions.find((f) => f.id === "dark-angels");
const wp = (u, w) => DS[u].wp.find((x) => x[0] === w)[2];

test("Lion El'Jonson: 11th-ed app datasheet", () => {
  const l = DS["Lion El'Jonson"];
  assert.deepEqual(l.s, { M: '8"', T: "10", SV: "2+", W: "16", LD: "5+", OC: "4" });
  assert.equal(l.inv, "3+");
  assert.deepEqual(wp("Lion El'Jonson", "Fealty").map((p) => [p[0], p[2], p[4], p[5], p[6], p[7]]),
    [["Strike", "8", "12", "-4", "4", ["Lethal Hits"]], ["Sweep", "12", "6", "-3", "2", ["Cleave 2", "Sustained Hits 1"]]]);
  assert.deepEqual(wp("Lion El'Jonson", "Arma Luminis").map((p) => [p[1], p[2], p[4], p[5], p[6]]), [['18"', "4", "6", "-2", "2"], ['18"', "2", "10", "-3", "3"]]);
  const ab = l.ab.map((a) => a[0]);
  for (const a of ["The Emperor's Shield", "Dark Angels Bodyguard", "Master Strategist", "Martial Exemplar", "No Hiding from the Watchers", "The Watchers"]) assert.ok(ab.includes(a), a);
  assert.match(l.ab.find((a) => a[0] === "Martial Exemplar")[1], /Re-roll hit rolls of 1\.\n■ Re-roll wound rolls of 1/);
  assert.equal(P.units.find((u) => u.n === "Lion El'Jonson").t[0][2][0][1], 415);
});

test("DA chapter units no longer carry old T4/S4 profiles", () => {
  assert.equal(DS["Azrael"].s.T, "5");
  assert.equal(DS["Deathwing Knights"].s.T, "6");
  assert.equal(DS["Belial"].wp.find((w) => /storm bolter/i.test(w[0]))[2][0][4], "5");
  assert.ok(DS["Ravenwing Black Knights"].wp.some((w) => w[0] === "Grenade Launcher"));
  for (const [n, d] of Object.entries(DS)) for (const w of d.wp) for (const p of w[2]) assert.ok(!(p[7].includes("Pistol") && p[4] === "4" && /bolt/i.test(w[0])), `${n} ${w[0]}`);
});

test("Deathwing Terminator chainfist strike profile has Hunter: Monster/Vehicle (app update)", () => {
  const c = wp("Deathwing Terminator Squad", "Chainfist");
  assert.deepEqual(c.map((p) => p[7]), [[], ["Hunter: Monster/Vehicle"]]);
});
