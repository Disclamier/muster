const test = require("node:test"), assert = require("node:assert");
const C = require("../app/js/core.js"), P = require("../app/data/points.json"), D = require("../app/data/datasheets.json");
const G = require("./fixtures/gwapp_custodes_995.json");
const I = C.indexData(P), F = I.factions["adeptus-custodes"];
const units = P.factions.find((f) => f.id === "adeptus-custodes").units;
const U = (n) => units.find((u) => C.norm(u.n) === C.norm(n));
const ds = (n) => D.factions["adeptus-custodes"].units[U(n).n];

test("Custodes roles: nothing left in 'Other'; new codex units sorted by their keywords", () => {
  assert.deepEqual(units.filter((u) => u.r === "Other").map((u) => u.n), []);
  for (const n of ["Custodian Guard Sodality", "Sentinel Guard Sodality"]) assert.equal(U(n).r, "Battleline", n);
  assert.equal(U("Gyrfalcon Jetbike Sodality").r, "Mounted");
  for (const n of ["Aquilon Terminators with Solarite Power Gauntlets", "Venatari with Verutum Lances", "Sagittarum Custodians Sodality"]) assert.equal(U(n).r, "Infantry", n);
});

test("every GW-app Custodes / Anathema Psykana unit exists with MFM points equal to the app costs and the same Legends status", () => {
  for (const [n, g] of Object.entries(G.units)) {
    const u = U(n); assert.ok(u, n);
    assert.deepEqual(u.t[0][2].map((c) => [c[0], c[1]]), g.costs, n);
    assert.equal(!!u.lg, g.legend, `${n} legends`);
  }
});

test("Anathema Psykana squads now follow the GW app (M7\", Anti-Psyker flamer/boltgun, Gun Stock), agreeing with Wahapedia", () => {
  const w = ds("Witchseeker Squad");
  assert.equal(w.s.M, '7"'); assert.deepEqual(w.cr, ['Scouts 7"']);
  assert.deepEqual(w.wp.map((x) => x[0]), ["Flamer", "Gun Stock"]); assert.ok(w.wp[0][2][0][7].includes("Anti-Psyker 4+"));
  assert.deepEqual(ds("Prosecutor Squad").wp.map((x) => x[0]), ["Boltgun", "Gun Stock"]);
  assert.equal(ds("Vigilator Squad").wp[0][2][0][2], "3");
  assert.deepEqual(U("Witchseeker Squad").lo.m[0][3], ["Flamer", "Gun Stock"]);
  assert.ok(ds("Knight-Centura").wp.some((x) => x[0] === "Master-crafted Flamer"));
});

test("default loadouts carry exactly the GW app 'equipped with' gear", () => {
  for (const [n, g] of Object.entries(G.units)) {
    const u = U(n); if (!u || !u.lo || !g.equip.length) continue;
    const N = C.defaultModels(u), lo = C.getLoadout(u, null, N);
    const have = {}, want = {};
    let tot = 0;
    for (const l of C.loadoutLines(u, lo)) { tot += l.count; for (const x of l.gear) for (const p of String(x.name).split(/\s*\+\s*/)) have[C.norm(p.replace(/s$/, ""))] = (have[C.norm(p.replace(/s$/, ""))] || 0) + x.count; }
    for (const x of g.equip) want[C.norm(x.replace(/s$/, ""))] = (want[C.norm(x.replace(/s$/, ""))] || 0) + (tot || 1);
    assert.deepEqual(have, want, n);
    assert.deepEqual(C.loadoutIssues(u, lo, N), [], n);
  }
  assert.ok(!JSON.stringify(U("Allarus Custodians").lo).toLowerCase().includes("misericordia"));
});

test("Leader / Support attachments match the GW app 'Led by' / 'Supported by' lists exactly", () => {
  const led = {}, sup = {};
  for (const [n, g] of Object.entries(G.units)) {
    for (const x of g.led) (led[C.norm(x)] = led[C.norm(x)] || new Set()).add(C.norm(n));
    for (const x of g.sup) (sup[C.norm(x)] = sup[C.norm(x)] || new Set()).add(C.norm(n));
  }
  for (const n of Object.keys(G.units)) {
    const u = U(n), k = C.norm(n);
    assert.deepEqual(new Set((u.ldr || []).map(C.norm)), led[k] || new Set(), `${n} leads`);
    assert.deepEqual(new Set((u.sup || []).map(C.norm)), sup[k] || new Set(), `${n} supports`);
  }
});

test("enhancements: names and MFM costs match the GW app; no site text leaked into any enhancement / rule text", () => {
  for (const d of G.detachments) {
    const md = F.f.dets.find((x) => C.norm(x.n) === C.norm(d.name)); assert.ok(md, d.name);
    assert.deepEqual(md.enh.map((e) => [C.norm(e[0]), e[1]]).sort(), d.enh.map((e) => [C.norm(e[0]), e[1]]).sort(), d.name);
  }
  assert.ok(!/Warhammer model kits|Warhammer rulebooks/.test(JSON.stringify(P)));
});

test("enhancement greying for every Custodes character follows the restriction text", () => {
  const en = (n) => F.f.dets.flatMap((d) => d.enh).find((e) => e[0].startsWith(n));
  const ok = (u, e) => C.enhEligible(U(u), en(e), F).ok;
  const chars = ["Blade Champion", "Knight-Centura", "Shield-Captain", "Shield-Captain in Allarus Terminator Armour", "Shield-Captain on Dawneagle Jetbike"];
  for (const e of F.f.dets.flatMap((d) => d.enh)) { assert.ok(!C.enhEligible(U("Trajann Valoris"), e, F).ok, e[0]); assert.ok(!C.enhEligible(U("Valerian"), e, F).ok, e[0]); }
  for (const c of chars) assert.ok(ok(c, "Pareldor"), c);                          // ADEPTUS CUSTODES model only
  assert.ok(!ok("Shield-Captain on Dawneagle Jetbike", "Not a Shell Wasted"));      // INFANTRY only
  assert.ok(ok("Shield-Captain in Allarus Terminator Armour", "Leonine Ferocity")); assert.ok(!ok("Shield-Captain", "Leonine Ferocity"));
  assert.ok(ok("Shield-Captain on Dawneagle Jetbike", "Sally Forth")); assert.ok(!ok("Blade Champion", "Sally Forth"));
  assert.ok(ok("Knight-Centura", "Oblivion Knight")); assert.ok(!ok("Shield-Captain", "Oblivion Knight"));
  assert.ok(!ok("Shield-Captain in Allarus Terminator Armour", "Auric Eagle")); assert.ok(ok("Vertus Praetors", "Auric Eagle"));
  for (const v of ["Pallas Grav-attack", "Caladius Grav-tank", "Coronus Grav-carrier"]) assert.ok(ok(v, "Anti-gravitic Mobility"), v);
  assert.ok(ok("Coronus Grav-carrier", "Combat Deployment")); assert.ok(!ok("Pallas Grav-attack", "Combat Deployment"));
  assert.ok(ok("Custodian Wardens", "Celeritous Sentries")); assert.ok(!ok("Allarus Custodians", "Celeritous Sentries"));
  assert.ok(ok("Telemon Heavy Dreadnought", "Augury Uplink")); assert.ok(!ok("Caladius Grav-tank", "Augury Uplink"));
});
