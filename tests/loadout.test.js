const test = require("node:test"), assert = require("node:assert");
const C = require("../app/js/core.js"), P = require("../app/data/points.json"), D = require("../app/data/datasheets.json");
const OPT = require("./fixtures/units_with_options.json");
const sweep = require("../audit/loadout_sweep.js");
const unit = (f, n) => P.factions.find((x) => x.id === f).units.find((u) => u.n === n);
const ds = (f, n) => D.factions[f].units[n];
const CAL = "Caladius Annihilator Grav\u2011Tank";
const gearOk = (f, u) => { const d = ds(f, u.n); const names = [...d.wp.map((w) => w[0]), ...(d.wa || []).map((w) => w[1])];
  const bad = []; const M = C.loModel(u);
  const items = [...M.types.flatMap((t) => [...t.fixed, ...t.slots.flatMap((s) => s.opts.map((o) => o.name))]), ...M.unit.flatMap((s) => s.opts.map((o) => o.name))];
  for (const it of items) for (const p of String(it).split(/\s*\+\s*/)) if (!C.gearWeapons(p, names).length && !names.some((n) => C.norm(n) === C.norm(p))) bad.push(p);
  return bad; };

test("Caladius Annihilator Grav-Tank (GW app, 250 pts): default Arachnus Blaze Carronade + Armoured Hull + Twin Lastrum Bolt Cannon; lastrum -> neutronium swap", () => {
  const u = unit("adeptus-custodes", CAL); assert.ok(C.hasLoadout(u));
  const lo = C.getLoadout(u, null, 1);
  assert.deepEqual(C.loadoutLines(u, lo)[0].gear.map((g) => g.name).sort(), ["Arachnus Blaze Carronade", "Armoured Hull", "Twin Lastrum Bolt Cannon"]);
  const sw = { c: lo.c, p: { [`${CAL}|Twin Lastrum Bolt Cannon`]: { "Twin Neutronium Cascade Projectors": 1 } } };
  assert.deepEqual(C.loadoutIssues(u, sw, 1), []);
  assert.deepEqual(C.loadoutLines(u, sw)[0].gear.map((g) => g.name).sort(), ["Arachnus Blaze Carronade", "Armoured Hull", "Twin Neutronium Cascade Projectors"]);
  assert.deepEqual(gearOk("adeptus-custodes", u), []);
  const g = unit("adeptus-custodes", "Caladius Grav-tank");   // stale 10e 'twin arachnus heavy blaze cannon' swap is gone
  assert.ok(!JSON.stringify(g.lo).includes("heavy blaze"));
  assert.ok(JSON.stringify(g.lo).includes("Twin Neutronium Cascade Projectors"));
});

test("every unit whose GW-app datasheet lists wargear options has a loadout offering every option item (all factions)", () => {
  assert.deepEqual(sweep.fails.map((x) => `${x.f}|${x.u}: ${x.miss.join(", ") || "no loadout"}`), []);
});

test("every unit whose Wahapedia 11e datasheet lists wargear options has a working loadout picker; defaults are valid (all factions)", () => {
  const bad = [];
  for (const [fid, ns] of Object.entries(OPT.factions)) for (const n of ns) {
    const u = unit(fid, n); if (!u) continue;
    if (!C.hasLoadout(u)) { bad.push(`${fid}|${n}: no picker`); continue; }
    const N = C.defaultModels ? C.defaultModels(u) : 1;
    const iss = C.loadoutIssues(u, C.getLoadout(u, null, N), N); if (iss.length) bad.push(`${fid}|${n}: ${iss.join("; ")}`);
  }
  assert.deepEqual(bad, []);
});

test("loadouts built from the new sources (Wahapedia base loadouts, curated GW-app loadouts) only name gear that has a profile in stats", () => {
  const W = require("../scraper/overrides/wahapedia_options.json").factions, CU = require("../scraper/overrides/curated_datasheets.json").fixes;
  const bad = [];
  for (const [fid, us] of Object.entries(W)) for (const [n, ps] of Object.entries(us)) if (ps.some((p) => p.base)) { const u = unit(fid, n); if (u) bad.push(...gearOk(fid, u).map((x) => `${fid}|${n}: ${x}`)); }
  for (const [n, p] of Object.entries(CU["adeptus-custodes"])) if (p.lo) bad.push(...gearOk("adeptus-custodes", unit("adeptus-custodes", n)).map((x) => `${n}: ${x}`));
  assert.deepEqual(bad, []);
});
