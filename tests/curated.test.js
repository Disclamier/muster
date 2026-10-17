const test = require("node:test"), assert = require("node:assert");
const C = require("../app/js/core.js"), P = require("../app/data/points.json"), D = require("../app/data/datasheets.json");
const CUR = require("../scraper/overrides/curated_datasheets.json");
const I = C.indexData(P);
const ds = (f, n) => D.factions[f].units[n];
const unit = (f, n) => P.factions.find((x) => x.id === f).units.find((u) => u.n === n);

test("Anathema Psykana squads match New Recruit (James's screenshots / BSData): Witchseekers, Prosecutors, Vigilators", () => {
  const w = ds("adeptus-custodes", "Witchseeker Squad");
  assert.deepEqual(w.s, { M: '6"', T: "3", SV: "3+", W: "1", LD: "6+", OC: "1" }); assert.equal(w.inv, undefined);
  assert.deepEqual(w.wp[0], ["Witchseeker Flamer", "r", [[null, '12"', "D6", "N/A", "4", "0", "1", ["Ignores Cover", "Torrent"]]]]);
  assert.deepEqual(w.cr, ['Scouts 6"']); assert.deepEqual(w.ab.map((a) => a[0]), ["Sanctified Flames", "Daughters of the Abyss"]);
  const p = ds("adeptus-custodes", "Prosecutor Squad");
  assert.equal(p.s.OC, "2"); assert.deepEqual(p.wp[0][2][0], [null, '24"', "1", "3+", "5", "-1", "1", ["Rapid Fire 1"]]);
  assert.match(p.ab[0][1], /\[PRECISION\] and \[DEVASTATING WOUNDS\]/);
  const v = ds("adeptus-custodes", "Vigilator Squad");
  assert.deepEqual(v.wp[0][2][0], [null, "Melee", "2", "3+", "5", "-2", "2", ["Anti-Psyker 5+", "Devastating Wounds"]]);
  for (const n of ["Witchseeker Squad", "Prosecutor Squad", "Vigilator Squad"]) assert.ok(unit("adeptus-custodes", n).kw.includes("Anathema Psykana"), n);
});

test("every curated datasheet and two-source fix is in the published data (the daily build applies the same file)", () => {
  for (const [fid, us] of Object.entries(CUR.factions)) for (const [n, rec] of Object.entries(us)) {
    const d = ds(fid, n); assert.ok(d, `${fid}|${n}`); assert.deepEqual(d.s, rec.s, `${fid}|${n}`);
    assert.ok(unit(fid, n).kw.length, `${fid}|${n} keywords`);
  }
  for (const [scope, us] of Object.entries(CUR.fixes)) {
    if (scope === "note") continue;
    const fids = scope === "*" ? Object.keys(D.factions) : [scope];
    for (const [n, p] of Object.entries(us)) for (const fid of fids) {
      const d = D.factions[fid] && D.factions[fid].units[n]; if (!d) { if (scope !== "*") assert.fail(`${fid}|${n} missing`); continue; }
      if (p.s) for (const [k, v] of Object.entries(p.s)) assert.equal(d.s[k], v, `${fid}|${n} ${k}`);
      if (p.sx) assert.deepEqual(d.sx, p.sx);
      if (p.replace) assert.deepEqual(d.wp, p.replace.wp);
      if (p.lo) assert.deepEqual(unit(fid, n).lo, p.lo);
      for (const a of p.wa_add || []) assert.ok(d.wa.some((x) => x[0] === a[0]), `${fid}|${n} ${a[0]}`);
    }
  }
});

test("New Recruit parity fixes: Pink Horrors stat line, Wolf Scouts profiles, Death Company Dreadnought M10\", Deathwatch Kill Team T5, Krieg vox-caster, Legends Venerable Dreadnought options", () => {
  assert.deepEqual([ds("chaos-daemons", "Pink Horrors").s.LD, ds("chaos-daemons", "Pink Horrors").s.OC], ["7+", "2"]);
  assert.equal(ds("space-wolves", "Wolf Scouts").s.SV, "3+"); assert.equal(ds("space-wolves", "Wolf Scouts").sx[0][0], "Hunting Wolf");
  assert.equal(ds("blood-angels", "Death Company Dreadnought").s.M, '10"');
  for (const [f, F] of Object.entries(D.factions)) if (F.units["Deathwatch Kill Team"]) assert.equal(F.units["Deathwatch Kill Team"].s.T, "5", f);
  assert.ok(ds("astra-militarum", "Death Korps of Krieg").wa.some((a) => a[0] === "Vox-caster"));
  // Legends Venerable Dreadnought: generic loadout (twin lascannon / missile launcher ...) and it prices + calculates
  const l = { id: "v", faction: "space-wolves", sub: "space-wolves", size: "strikeforce", dets: [], showLegends: true,
    entries: [{ uid: "a", unit: "Venerable Dreadnought [Legends]", models: 1, wargear: {}, addons: [], enh: null, lo: { c: { "Venerable Dreadnought": 1 }, p: { "Venerable Dreadnought|Assault cannon": { "Twin lascannon": 1 }, "Venerable Dreadnought|Dreadnought fist and storm bolter": { "Missile launcher": 1 } } } }] };
  const c = C.calcList(l, I); assert.equal(c.total, 165);
  assert.match(JSON.stringify(c.entries[0].loLines || []), /Twin lascannon/);
});
