const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const C = require("../app/js/core.js");
const { fixture } = require("./fixture.js");

const idx = C.indexData(fixture());
const F = idx.factions.fx;
function list(size, dets, units, extra) {
  const l = C.newList({ name: "T", faction: "fx", sub: "fx", size });
  l.dets = dets || [];
  for (const u of units || []) { const e = C.newEntry(F.units[typeof u === "string" ? u : u.n]); if (typeof u === "object") Object.assign(e, u.set || {}); l.entries.push(e); }
  return Object.assign(l, extra || {});
}
const msgs = (c) => c.errors.map((e) => e.msg).join(" | ");

test("cost tiers: copies 3+ use the later tier, model options per tier", () => {
  const u = F.units.Troops;
  assert.deepEqual(C.modelOptions(u, 1).map((o) => o.points), [60, 120]);
  assert.deepEqual(C.modelOptions(u, 3).map((o) => o.points), [70, 140]);
  assert.equal(C.minCost(u, 5), 70);
  const l = list("strikeforce", ["Det A"], ["Troops", "Troops", { n: "Troops", set: { models: 10 } }, { n: "Captain", set: { warlord: true } }]);
  const c = C.calcList(l, idx);
  assert.deepEqual(c.entries.map((r) => r.base), [60, 60, 140, 80]);
  assert.equal(c.total, 340);
});

test("add-on rows and wargear costs are added; add-ons are not model options", () => {
  assert.deepEqual(C.modelOptions(F.units.Walls, 1).map((o) => o.models), [1]);
  assert.deepEqual(C.addonOptions(F.units.Walls, 1).map((o) => o.points), [30]);
  const l = list("strikeforce", ["Det A"], [{ n: "Walls", set: { addons: ["+ 1 Extra Wall"] } }, { n: "Tank", set: { wargear: { "Big Gun": 2 } } }, { n: "Captain", set: { warlord: true } }]);
  const c = C.calcList(l, idx);
  assert.equal(c.entries[0].total, 130);
  assert.equal(c.entries[1].total, 170);
  assert.equal(c.units, 380);
});

test("total = units + enhancements", () => {
  const l = list("strikeforce", ["Det A"], [{ n: "Captain", set: { warlord: true, enh: { det: "Det A", name: "Relic" } } }]);
  const c = C.calcList(l, idx);
  assert.equal(c.units, 80); assert.equal(c.enhancements, 20); assert.equal(c.total, 100);
  assert.equal(c.errors.length, 0, msgs(c));
});

test("detachment points: limit, over-limit, Incursion single 3DP exception", () => {
  const ok = C.calcList(list("strikeforce", ["Det A", "Det B"]), idx);
  assert.equal(ok.dp, 3); assert.equal(ok.dpLimit, 3); assert.ok(!/Detachment Points/.test(msgs(ok)));
  const over = C.calcList(list("strikeforce", ["Det A", "Det C"]), idx);
  assert.match(msgs(over), /Detachment Points: 5 \/ 3/);
  const inc3 = C.calcList(list("incursion", ["Det C"]), idx);
  assert.ok(!/Detachment Points/.test(msgs(inc3)), msgs(inc3));
  const inc = C.calcList(list("incursion", ["Det A", "Det B"]), idx);
  assert.match(msgs(inc), /Detachment Points: 3 \/ 2/);
  assert.match(msgs(C.calcList(list("strikeforce", []), idx)), /Select a detachment/);
});

test("unit limits: 3 per datasheet, Battleline x2, Epic Hero 1, Onslaught undefined", () => {
  assert.match(msgs(C.calcList(list("strikeforce", ["Det A"], ["Captain", "Captain", "Captain", "Captain"]), idx)), /Captain: 4 \/ 3/);
  const six = C.calcList(list("strikeforce", ["Det A"], Array(6).fill("Troops")), idx);
  assert.ok(!/Troops:/.test(msgs(six)));
  assert.match(msgs(C.calcList(list("strikeforce", ["Det A"], Array(7).fill("Troops")), idx)), /Troops: 7 \/ 6/);
  assert.match(msgs(C.calcList(list("strikeforce", ["Det A"], ["Hero A", "Hero A"]), idx)), /Hero A: 2 \/ 1/);
  assert.match(msgs(C.calcList(list("incursion", ["Det A"], ["Drone", "Drone", "Drone"]), idx)), /Drone: 3 \/ 2/);
  assert.ok(!/Drone:/.test(msgs(C.calcList(list("onslaught", ["Det A"], Array(5).fill("Drone")), idx))));
});

test("enhancement rules: eligibility, duplicates, upgrades, limits, detachment", () => {
  const w = { warlord: true };
  assert.match(msgs(C.calcList(list("strikeforce", ["Det A"], [{ n: "Hero A", set: { ...w, enh: { det: "Det A", name: "Relic" } } }]), idx)), /Epic Heroes cannot/);
  assert.match(msgs(C.calcList(list("strikeforce", ["Det A"], [{ n: "Captain", set: w }, { n: "Drone", set: { enh: { det: "Det A", name: "Relic" } } }]), idx)), /only Characters/);
  const up = C.calcList(list("strikeforce", ["Det A"], [{ n: "Captain", set: w }, ...Array(3).fill({ n: "Drone", set: { enh: { det: "Det A", name: "Upgrade X" } } })]), idx);
  assert.equal(up.errors.length, 0, msgs(up)); assert.equal(up.enhCount, 1); assert.equal(up.enhancements, 30);
  assert.match(msgs(C.calcList(list("strikeforce", ["Det A"], [{ n: "Captain", set: w }, ...Array(4).fill({ n: "Drone", set: { enh: { det: "Det A", name: "Upgrade X" } } })]), idx)), /max 3/);
  assert.match(msgs(C.calcList(list("strikeforce", ["Det A"], [{ n: "Captain", set: { ...w, enh: { det: "Det A", name: "Relic" } } }, { n: "Captain", set: { enh: { det: "Det A", name: "Relic" } } }]), idx)), /Relic taken 2 times/);
  assert.match(msgs(C.calcList(list("incursion", ["Det A", "Det B"], [{ n: "Captain", set: { ...w, enh: { det: "Det A", name: "Relic" } } }, { n: "Captain", set: { enh: { det: "Det B", name: "Sword" } } }, { n: "Old Guy", set: { enh: { det: "Det A", name: "Upgrade X" } } }]), idx)), /Enhancements: 3 \/ 2/);
  assert.match(msgs(C.calcList(list("strikeforce", ["Det A"], [{ n: "Captain", set: { ...w, enh: { det: "Det B", name: "Sword" } } }]), idx)), /needs detachment Det B/);
});

test("warlord, points limit, unique tags, dispositions, legends/GrimSlate warnings", () => {
  assert.match(msgs(C.calcList(list("strikeforce", ["Det A"], ["Captain"]), idx)), /Select a Warlord/);
  assert.match(msgs(C.calcList(list("strikeforce", ["Det A"], [{ n: "Drone", set: { warlord: true } }]), idx)), /cannot be the Warlord/);
  assert.match(msgs(C.calcList(list("strikeforce", ["Det A"], [{ n: "Captain", set: { warlord: true } }, { n: "Captain", set: { warlord: true } }]), idx)), /2 Warlords/);
  const big = C.calcList(list("incursion", ["Det A"], [{ n: "Captain", set: { warlord: true } }, ...Array(4).fill({ n: "Troops", set: { models: 10 } }), "Tank", "Tank", "Walls", "Hero A"]), idx);
  assert.ok(big.total > 1000); assert.match(msgs(big), /Points: \d+ \/ 1000/);
  assert.match(msgs(C.calcList(list("strikeforce", ["Unique 1", "Unique 2"]), idx)), /UNIQUE: DYNASTY/);
  assert.match(msgs(C.calcList(list("strikeforce", ["Det A"], [], { disposition: "TAKE AND HOLD" }), idx)), /not offered/);
  const w = C.calcList(list("strikeforce", ["Det GS"], [{ n: "Old Guy", set: { warlord: true } }]), idx);
  assert.ok(w.warnings.some((x) => /Legends/.test(x.msg)));
  assert.ok(w.warnings.some((x) => /not in the current Munitorum Field Manual$/.test(x.msg)));
  assert.ok(!w.warnings.some((x) => /GrimSlate/i.test(x.msg)), "no source name in user-visible warnings");
});

test("missing units and invalid sizes after a data change", () => {
  const l = list("strikeforce", ["Det A"], [{ n: "Captain", set: { warlord: true } }, { n: "Troops", set: { models: 7 } }]);
  l.entries.push({ uid: "x1", unit: "Gone Unit", models: 1, wargear: {}, addons: [], enh: null, warlord: false });
  const c = C.calcList(l, idx);
  assert.match(msgs(c), /Gone Unit is no longer/);
  assert.ok(c.warnings.some((x) => /7 models is no longer a valid size/.test(x.msg)));
  assert.equal(c.entries[1].base, 60);
});

test("diffData: unit/enhancement/detachment changes old -> new", () => {
  const a = fixture(), b = fixture((d) => {
    const f = d.factions[0]; d.hash = "bbbb";
    f.units.find((u) => u.n === "Captain").t = [[1, null, [[1, 90]]]];
    f.units = f.units.filter((u) => u.n !== "Drone");
    f.units.push({ n: "New Thing", r: "Infantry", t: [[1, null, [[1, 40]]]] });
    f.dets[0].enh[0][1] = 25; f.dets[1].dp = 2;
  });
  const dd = C.diffData(a, b);
  const cap = dd.units.find((u) => u.name === "Captain");
  assert.equal(cap.oldMin, 80); assert.equal(cap.newMin, 90);
  assert.ok(dd.units.find((u) => u.name === "Drone" && u.removed));
  assert.ok(dd.units.find((u) => u.name === "New Thing" && u.added));
  assert.deepEqual(dd.enhancements.map((e) => [e.name, e.old, e.new]), [["Relic", 20, 25]]);
  assert.deepEqual(dd.detachments.map((e) => [e.name, e.old, e.new]), [["Det B", 1, 2]]);

  const L1 = list("strikeforce", ["Det A", "Det B"], [{ n: "Captain", set: { warlord: true, enh: { det: "Det A", name: "Relic" } } }, "Drone"]);
  const L2 = list("strikeforce", ["Det A"], ["Tank"]); L2.name = "Unchanged";
  const dl = C.diffLists([L1, L2], C.indexData(a), C.indexData(b));
  assert.equal(dl.length, 1);
  assert.equal(dl[0].oldTotal, 120); assert.equal(dl[0].newTotal, 115);
  const kinds = dl[0].items.map((i) => `${i.kind}:${i.name}:${i.old}->${i.new}`);
  assert.ok(kinds.includes("unit:Captain:80->90"), kinds.join());
  assert.ok(kinds.includes("enhancement:Relic:20->25"), kinds.join());
  assert.ok(kinds.includes("unit:Drone:20->null"), kinds.join());
  assert.ok(kinds.includes("detachment:Det B:1->2"), kinds.join());
});

test("export formats mirror New Recruit (GW, Tournament/WTC, WTC full, Simple, Stratagems)", () => {
  const l = list("strikeforce", ["Det A"], [{ n: "Captain", set: { warlord: true, enh: { det: "Det A", name: "Relic" } } }, { n: "Troops", set: { models: 10 } }, { n: "Tank", set: { wargear: { "Big Gun": 1 } } }]);
  l.name = "My Army"; l.disposition = "PURGE THE FOE";
  const meta = { mfm_version: "v1.0", fetched_at: "2026-10-01T00:00:00Z" };
  assert.deepEqual(C.EXPORT_FORMATS.map((f) => f.id), ["gw", "wtc", "wtc-full", "simple", "stratagems"]);
  const gw = C.exportText(l, idx, meta, "gw");
  assert.match(gw, /^My Army \(380 Points\)/); assert.match(gw, /CHARACTERS/); assert.match(gw, /BATTLELINE/); assert.match(gw, /Enhancement: Relic/);
  assert.match(gw, /Strike Force \(2,000 Points\)/); assert.match(gw, /Det A \(2 DP\)/);
  const wtc = C.exportText(l, idx, meta, "wtc");
  for (const re of [/^\+{10,}/m, /\+ LIST NAME: My Army/, /\+ FACTION KEYWORD: Fixture Xenos/, /\+ DETACHMENT: Det A/, /\+ TOTAL ARMY POINTS: 380pts/, /\+ WARLORD: Char1: Captain/, /\+ ENHANCEMENT: Relic \(on Char1: Captain\)/, /\+ NUMBER OF UNITS: 3/, /Char1: 1x Captain \(80 pts\)/, /10x Troops \(120 pts\)/, /1x Tank \(160 pts\): Big Gun/])
    assert.match(wtc, re);
  assert.match(C.exportText(l, idx, meta, "wtc-full"), /BATTLELINE\n\nChar1: 1x Captain/);
  assert.match(C.exportText(l, idx, meta, "simple"), /TOTAL: 380 pts \/ 2000/);
  const st = C.exportText(l, idx, meta, "stratagems");
  assert.match(st, /Big Strat – 1CP/); assert.match(st, /Detachment rule – Rule A/);
  assert.match(C.exportText(l, idx, meta, "gw", { markdown: true }), /\*\*CHARACTERS\*\*/);
  const long = Array(300).fill("A line of text that is reasonably long").join("\n");
  const blocks = C.discordBlocks(long, 2000);
  assert.ok(blocks.length > 1); assert.ok(blocks.every((b) => b.length <= 2000 && b.startsWith("```\n") && b.endsWith("\n```")));
});

test("share payload and JSON import/export round-trip", () => {
  const l = list("incursion", ["Det A"], [{ n: "Captain", set: { warlord: true, enh: { det: "Det A", name: "Relic" }, note: "spear" } }, { n: "Walls", set: { addons: ["+ 1 Extra Wall"] } }]);
  l.disposition = "PURGE THE FOE";
  const json = JSON.stringify(C.shareableList(l));
  const bytes = new TextEncoder().encode(json + " ’é");
  assert.deepEqual(Array.from(C.b64urlDecode(C.b64urlEncode(bytes))), Array.from(bytes));
  const back = C.listFromShareable(JSON.parse(json));
  assert.equal(back.size, "incursion"); assert.equal(back.disposition, "PURGE THE FOE");
  assert.deepEqual(back.entries.map((e) => [e.unit, e.models, e.warlord, e.enh, e.addons, e.note || null]), l.entries.map((e) => [e.unit, e.models, e.warlord, e.enh, e.addons, e.note || null]));
  assert.equal(C.calcList(back, idx).total, C.calcList(l, idx).total);
  const imp = C.importLists(C.exportLists([l]));
  assert.equal(imp.length, 1); assert.notEqual(imp[0].id, l.id); assert.equal(C.calcList(imp[0], idx).total, C.calcList(l, idx).total);
  const dup = C.duplicateList(l);
  assert.notEqual(dup.id, l.id); assert.match(dup.name, /\(copy\)/); assert.notEqual(dup.entries[0].uid, l.entries[0].uid);
  assert.throws(() => C.importLists("{\"foo\":1}"));
});

test("unit search by name, role, keyword and cost filters", () => {
  const us = F.f.units;
  assert.deepEqual(C.searchUnits(us, "capt").map((u) => u.n), ["Captain"]);
  assert.deepEqual(C.searchUnits(us, "battleline").map((u) => u.n), ["Troops"]);
  assert.deepEqual(C.searchUnits(us, "<60").map((u) => u.n).sort(), ["Drone", "Old Guy"]);
  assert.deepEqual(C.searchUnits(us, "character >=100").map((u) => u.n), ["Hero A"]);
  assert.deepEqual(C.searchUnits(us, "legends").map((u) => u.n), ["Old Guy"]);
});

test("meta helpers: sorting with nulls last, faction/detachment lookup", () => {
  const rows = [{ n: "b", v: 50 }, { n: "a", v: null }, { n: "C", v: 60 }];
  assert.deepEqual(C.sortRows(rows, "v", "desc").map((r) => r.n), ["C", "b", "a"]);
  assert.deepEqual(C.sortRows(rows, "v", "asc").map((r) => r.n), ["b", "C", "a"]);
  assert.deepEqual(C.sortRows(rows, "n", "asc").map((r) => r.n), ["a", "b", "C"]);
  const wr = { factions: [{ name: "Space Marines", mfm_id: "space-marines", detachments_single: [{ name: "Gladius Task Force", games: 10, win_rate: 50 }] },
    { name: "Blood Angels", mfm_id: "blood-angels", detachments_single: [] }] };
  assert.equal(C.metaFaction(wr, "space-marines", "ultramarines").name, "Space Marines");
  assert.equal(C.metaFaction(wr, "blood-angels", "blood-angels").name, "Blood Angels");
  assert.equal(C.metaDetachment(C.metaFaction(wr, "space-marines"), "Gladius Task Force").games, 10);
  assert.equal(C.fmtPct(53.456), "53.5%"); assert.equal(C.fmtPct(null), "—");
});

test("real data: built points.json is sane", { skip: !fs.existsSync(path.join(__dirname, "../app/data/points.json")) }, () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/data/points.json"), "utf8"));
  const I = C.indexData(d);
  assert.ok(d.factions.length >= 25); assert.ok(d.factions.reduce((n, f) => n + f.units.length, 0) >= 1400);
  for (const f of d.factions) assert.ok(f.units.length > 0, f.id);
  assert.ok(d.factions.filter((f) => f.dets.length > 0).length >= 25);
  const tl = I.factions["titan-legions"];
  assert.equal(C.minCost(tl.units["Warlord Titan"], 1), 3500);
  assert.equal(C.minCost(I.factions.aeldari.units["Phantom Titan"], 1), 2100);
  assert.deepEqual(d.battle_sizes.slice(0, 2).map((s) => [s.points, s.dp, s.enh, s.unit_limit]), [[1000, 2, 2, 2], [2000, 3, 4, 3]]);
  for (const g of d.groups) for (const s of g.factions) assert.ok(I.factions[s.data], s.id);
  // every faction's first unit can be priced and listed
  for (const f of d.factions) {
    const det = f.dets.find((x) => x.src === "mfm"); const l = C.newList({ faction: f.id }); l.dets = det ? [det.n] : [];
    l.entries.push(C.newEntry(f.units[0]));
    const c = C.calcList(l, I); assert.ok(c.total > 0, f.id);
    for (const fmt of C.EXPORT_FORMATS) assert.ok(C.exportText(l, I, d, fmt.id).length > 20);
  }
});

test("loadouts: default composition per unit size, loadout lines", () => {
  const u = F.units.Squad;
  assert.ok(C.hasLoadout(u));
  const lo5 = C.getLoadout(u, {}, 5);
  assert.deepEqual(lo5.c, { Sergeant: 1, Trooper: 4, "Trooper w/ Launcher": 0 });
  assert.deepEqual(lo5.p["Sergeant|Weapon 1"], { "Bolt Rifle": 1 });
  assert.deepEqual(lo5.p["Trooper|Grenades"], { Krak: 4 });
  assert.deepEqual(lo5.p["*|Rocket Pod"], {});
  assert.deepEqual(C.loadoutLines(u, lo5).map(C.loadoutText), ["1x Sergeant: Bolt pistol, Bolt Rifle", "4x Trooper: Bolt pistol, Bolt Rifle, Krak"]);
  assert.equal(C.getLoadout(u, {}, 10).c.Trooper, 9);
  assert.deepEqual(C.loadoutIssues(u, lo5, 5), []);
});

test("loadouts: upgrades trade with their base model, max scales with unit size", () => {
  const u = F.units.Squad;
  let lo = C.getLoadout(u, {}, 5);
  lo = C.setModelCount(u, lo, "Trooper w/ Launcher", 1, 5);
  assert.deepEqual([lo.c.Trooper, lo.c["Trooper w/ Launcher"]], [3, 1]);
  assert.equal(C.setModelCount(u, lo, "Trooper w/ Launcher", 2, 5).c["Trooper w/ Launcher"], 1, "max 1 at 5 models");
  // going to 10 models keeps the upgrade, fills the base type, and allows a 2nd launcher
  let lo10 = C.getLoadout(u, { lo }, 10);
  assert.deepEqual([lo10.c.Trooper, lo10.c["Trooper w/ Launcher"]], [8, 1]);
  lo10 = C.setModelCount(u, lo10, "Trooper w/ Launcher", 2, 10);
  assert.deepEqual([lo10.c.Trooper, lo10.c["Trooper w/ Launcher"]], [7, 2]);
  // shrinking back to 5 clamps the upgrade
  const back = C.getLoadout(u, { lo: lo10 }, 5);
  assert.deepEqual([back.c.Trooper, back.c["Trooper w/ Launcher"]], [3, 1]);
  // picks re-normalise to the new model count, keeping non-default choices where possible
  const mixed = C.getLoadout(u, { lo: { c: { Sergeant: 1, Trooper: 9, "Trooper w/ Launcher": 0 }, p: { "Trooper|Grenades": { Krak: 6, Frag: 3 } } } }, 5);
  assert.deepEqual(mixed.p["Trooper|Grenades"], { Frag: 3, Krak: 1 });
});

test("loadouts: linked MFM wargear is priced from the loadout, exports show loadout lines", () => {
  const l = list("strikeforce", ["Det A"], [{ n: "Captain", set: { warlord: true } }, { n: "Squad", set: { wargear: { "Power fist": 3 } } }]);
  let c = C.calcList(l, idx);
  assert.equal(c.entries[1].wargear, 0, "manual count ignored for wargear linked to loadout options");
  l.entries[1].lo = { c: { Sergeant: 1, Trooper: 4 }, p: { "Sergeant|Weapon 1": { "Power fist": 1 }, "*|Rocket Pod": { "Rocket Pod": 1 } } };
  c = C.calcList(l, idx);
  assert.equal(c.entries[1].wargear, 5); assert.equal(c.entries[1].total, 85);
  assert.equal(c.warnings.filter((w) => /loadout/.test(w.msg)).length, 0, c.warnings.map((w) => w.msg).join());
  const meta = { mfm_version: "v1.0", fetched_at: "2026-10-01T00:00:00Z" };
  const gw = C.exportText(l, idx, meta, "gw");
  assert.match(gw, /Squad \(85 Points\)\n  • 1x Sergeant\n    ◦ 1x Bolt pistol\n    ◦ 1x Power fist\n  • 4x Trooper\n    ◦ 4x Bolt pistol\n    ◦ 4x Bolt Rifle\n    ◦ 4x Krak\n  • 1x Rocket Pod/);
  assert.match(C.exportText(l, idx, meta, "wtc"), /5x Squad \(85 pts\): 1x Sergeant: Bolt pistol, Power fist; 4x Trooper: Bolt pistol, Bolt Rifle, Krak; Rocket Pod/);
  assert.match(C.exportText(l, idx, meta, "wtc-full"), /1 with Bolt pistol, Power fist \(Sergeant\)\n4 with Bolt pistol, Bolt Rifle, Krak \(Trooper\)/);
  assert.match(C.exportText(l, idx, meta, "simple"), /  • 1x Sergeant: Bolt pistol, Power fist\n  • 4x Trooper: Bolt pistol, Bolt Rifle, Krak/);
  const sh = C.listFromShareable(JSON.parse(JSON.stringify(C.shareableList(l))));
  assert.equal(C.calcList(sh, idx).entries[1].wargear, 5, "share link keeps the loadout");
  const imp = C.importLists(C.exportLists([l]));
  assert.equal(C.calcList(imp[0], idx).entries[1].wargear, 5);
});

test("formatting: one-decimal percentages, export footer in local time", () => {
  assert.equal(C.fmtPct(49), "49.0%"); assert.equal(C.fmtPct("48"), "48.0%"); assert.equal(C.fmtPct(53.456), "53.5%");
  const meta = { mfm_version: "v1.5", fetched_at: "2026-10-08T02:48:37+00:00" };
  const local = C.fmtLocal(meta.fetched_at);
  assert.equal(local, new Date(meta.fetched_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }));
  const l = list("strikeforce", ["Det A"], [{ n: "Captain", set: { warlord: true } }]);
  for (const f of C.EXPORT_FORMATS) {
    const t = C.exportText(l, idx, meta, f.id);
    assert.ok(!/fetched 2026-10-08/.test(t), f.id);
    if (/fetched/.test(t)) assert.ok(t.includes(`fetched ${local}`), f.id);
  }
  if (process.env.TZ === "America/Chicago" || new Date(meta.fetched_at).getTimezoneOffset() === 300) assert.equal(local, "Oct 7, 2026, 9:48 PM");
});

test("real data: every default loadout is clean; Intercessors / Redemptor loadouts", { skip: !fs.existsSync(path.join(__dirname, "../app/data/points.json")) }, () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/data/points.json"), "utf8"));
  let n = 0; const bad = [];
  for (const f of d.factions) for (const u of f.units) {
    if (!C.hasLoadout(u)) continue;
    for (const t of u.t) for (const r of t[2]) { if (r[0] == null) continue; n++; const is = C.loadoutIssues(u, C.getLoadout(u, {}, r[0], r[2]), r[0]); if (is.length) bad.push(`${u.n}@${r[0]}: ${is}`); }
  }
  assert.ok(n > 2500, `checked ${n}`);
  assert.deepEqual(bad, []);
  const I = C.indexData(d); const sm = I.factions["space-marines"];
  const inter = sm.units["Intercessor Squad"];
  assert.deepEqual(C.loadoutLines(inter, C.getLoadout(inter, {}, 5)).map(C.loadoutText),
    ["1x Intercessor Sergeant: Bolt Pistol, Knives and Fists, Bolt Rifle", "4x Intercessor: Bolt Pistol, Bolt Rifle, Knives and Fists"]);  // codex loadout
  // Redemptor: Macro Plasma Incinerator is the MFM-priced option (+10)
  const red = sm.units["Redemptor Dreadnought"];
  const l = C.newList({ faction: "space-marines" }); l.dets = [sm.f.dets.find((x) => x.src === "mfm").n];
  const e = C.newEntry(red); l.entries.push(e);
  const base = C.calcList(l, I).entries[0].total;
  e.lo = { c: { "Redemptor Dreadnought": 1 }, p: { "Redemptor Dreadnought|Heavy Onslaught Gatling Cannon": { "Macro Plasma Incinerator": 1 } } };
  const row = C.calcList(l, I).entries[0];
  assert.equal(row.total, base + 10);
  assert.match(C.loadoutText(row.loLines[0]), /Macro Plasma Incinerator/);
});

test("diffData compares points only: text/loadout/name-case changes are not reported, real cost changes are", () => {
  const a = fixture(), b = fixture();
  for (const u of b.factions[0].units) { u.ab = "rewritten rules text"; u.lo = { m: [], u: [] }; u.kw = ["Different"]; }
  b.factions[0].units[0].n = b.factions[0].units[0].n.toUpperCase();
  let d = C.diffData(a, b);
  assert.equal(d.units.length, 0, JSON.stringify(d.units));
  b.factions[0].units[1].t[0][2][0][1] += 10;
  d = C.diffData(a, b);
  assert.equal(d.units.length, 1); assert.equal(d.units[0].name, b.factions[0].units[1].n);
});

test("unit names are unique per faction in the built data (lists reference units by name)", () => {
  const P = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "data", "points.json"), "utf8"));
  for (const f of P.factions) { const seen = new Set(); for (const u of f.units) { assert.ok(!seen.has(u.n), `${f.id}: ${u.n}`); seen.add(u.n); } }
  const sw = P.factions.find((f) => f.id === "space-wolves");
  assert.ok(sw.units.find((u) => u.n === "Venerable Dreadnought" && !u.lg) && sw.units.find((u) => u.n === "Venerable Dreadnought [Legends]" && u.lg));
});

test("enhancement restriction parsing + eligibility on the real data", () => {
  const P = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "data", "points.json"), "utf8"));
  const I = C.indexData(P);
  const r = C.enhRestriction(["X", 0, "Flavour text. ADEPTA SORORITAS CHARACTER model only (excluding PENITENT units). Effect."]);
  assert.deepEqual([...r.alts], ["ADEPTA SORORITAS CHARACTER"]); assert.deepEqual([...r.excl], ["PENITENT"]);
  assert.deepEqual([...C.enhRestriction(["X", 0, "CANONESS, PALATINE or MINISTORUM PRIEST model only."]).alts], ["CANONESS", "PALATINE", "MINISTORUM PRIEST"]);
  assert.deepEqual([...C.enhRestriction(["X", 0, "Big Mek/Mek model only."]).alts], ["BIG MEK", "MEK"]);
  assert.equal(C.enhRestriction(["X", 0, "The bearer has the Infiltrators ability."]), null);
  const elig = (fid, unit, det, enh) => { const F = I.factions[fid]; const en = F.dets[det].enh.find((e) => e[0] === enh); return C.enhEligible(F.units[unit], en, F).ok; };
  assert.equal(elig("world-eaters", "Master of Executions", "Cult of Blood", "Butcher Lord"), true);
  assert.equal(elig("world-eaters", "Lord on Juggernaut", "Cult of Blood", "Butcher Lord"), false);
  assert.equal(elig("world-eaters", "Bloodthirster", "Khorne Daemonkin", "Blood-Forged Armour"), true);
  assert.equal(elig("world-eaters", "Bloodthirster", "Khorne Daemonkin", "Icon of War"), false);
  assert.equal(elig("world-eaters", "Angron", "Berzerker Warband", "Battle-lust"), false);
  // text written for units that normally can't take enhancements
  const nec = I.factions.necrons; const deceiver = nec.f.units.find((u) => /Deceiver/.test(u.n));
  assert.equal(C.enhEligible(deceiver, nec.dets["Pantheon of Woe"].enh.find((e) => e[0] === "Singularity Matrix"), nec).ok, true);
  assert.equal(C.enhEligible(deceiver, nec.dets["Pantheon of Woe"].enh.find((e) => e[0] === "Animus Damper"), nec).ok, false);
});

/* ---------------------------------------------------------------- cloud sync merge (last write wins per list) */
const T0 = "2026-10-07T10:00:00.000Z", T1 = "2026-10-07T11:00:00.000Z", T2 = "2026-10-07T12:00:00.000Z";
const L = (id, updated, name) => ({ id, name: name || id, faction: "fx", sub: "fx", size: "strikeforce", dets: [], entries: [], updated });
const row = (id, updated_at, extra) => ({ id, updated_at, deleted: false, data: L(id, updated_at, `${id} (remote)`), ...(extra || {}) });

test("sync merge: newer copy wins in both directions, Postgres timestamps compare at ms precision", () => {
  assert.equal(C.syncTime("2026-10-07T11:00:00.000123+00:00"), C.syncTime(T1));
  assert.equal(C.syncTime("2026-10-07 11:00:00+00"), C.syncTime(T1));
  const local = { lists: [L("a", T1, "a local"), L("b", T1, "b local"), L("c", T1, "c local")], tombs: {} };
  const r = C.mergeLists(local, [row("a", T2), row("b", T0), row("c", "2026-10-07T11:00:00+00:00")]);
  assert.equal(r.lists.find((l) => l.id === "a").name, "a (remote)", "remote newer replaces local");
  assert.equal(r.lists.find((l) => l.id === "a").updated, T2);
  assert.equal(r.lists.find((l) => l.id === "b").name, "b local", "local newer is kept");
  assert.equal(r.lists.find((l) => l.id === "c").name, "c local", "same time: no change");
  assert.deepEqual(r.push, ["b"], "only the locally newer list is pushed");
  assert.deepEqual(r.replaced, ["a"]); assert.ok(r.changed);
  assert.deepEqual(r.lists.map((l) => l.id), ["a", "b", "c"], "local order kept");
});

test("sync merge: remote-only lists are added, remote tombstones never resurrect", () => {
  const r = C.mergeLists({ lists: [], tombs: {} }, [row("n", T1), { id: "gone", updated_at: T1, deleted: true, data: null }]);
  assert.deepEqual(r.lists.map((l) => l.id), ["n"]); assert.deepEqual(r.added, ["n"]); assert.deepEqual(r.push, []);
});

test("sync merge: tombstones – remote deletion removes a list, local deletion is pushed, newer edit beats older deletion", () => {
  // deleted on another device after our last edit -> dropped here
  let r = C.mergeLists({ lists: [L("a", T1)], tombs: {} }, [{ id: "a", updated_at: T2, deleted: true, data: null }]);
  assert.deepEqual(r.lists, []); assert.deepEqual(r.removed, ["a"]); assert.deepEqual(r.push, []);
  // deleted here after the server copy -> tombstone pushed as a soft delete
  r = C.mergeLists({ lists: [], tombs: { b: T2 } }, [row("b", T1)]);
  assert.deepEqual(r.lists, [], "server's older copy does not come back"); assert.deepEqual(r.push, ["b"]);
  assert.deepEqual(C.syncRow(r, "b", "u1"), { id: "b", data: null, updated_at: T2, deleted: true, user_id: "u1" });
  // our deletion is already on the server -> tombstone pruned, nothing to push
  r = C.mergeLists({ lists: [], tombs: { c: T2 } }, [{ id: "c", updated_at: T2, deleted: true, data: null }]);
  assert.deepEqual(r.tombs, {}); assert.deepEqual(r.push, []);
  // edited here after another device deleted it -> local edit wins and is re-uploaded
  r = C.mergeLists({ lists: [L("d", T2)], tombs: {} }, [{ id: "d", updated_at: T1, deleted: true, data: null }]);
  assert.deepEqual(r.lists.map((l) => l.id), ["d"]); assert.deepEqual(r.push, ["d"]);
  // tie between an edit and a deletion: deletion wins
  r = C.mergeLists({ lists: [L("e", T1)], tombs: {} }, [{ id: "e", updated_at: T1, deleted: true, data: null }]);
  assert.deepEqual(r.lists, []);
});

test("sync merge: lists made before the first sign-in (local-only) are uploaded, offline edits queue via pendingPush", () => {
  const local = { lists: [L("pc1", T0), L("pc2", T1)], tombs: { old: T1 } };
  const r = C.mergeLists(local, []);
  assert.deepEqual(r.push.sort(), ["old", "pc1", "pc2"]);
  const row1 = C.syncRow(local, "pc1", "u1");
  assert.deepEqual({ ...row1, data: row1.data.id }, { id: "pc1", data: "pc1", updated_at: T0, deleted: false, user_id: "u1" });
  // after a successful push the server is known to hold these; a later offline edit makes only that list pending
  const known = { pc1: T0, pc2: T1, old: T1 };
  assert.deepEqual(C.pendingPush(local, known), []);
  local.lists[1].updated = T2;
  assert.deepEqual(C.pendingPush(local, known), ["pc2"]);
});

test("real data: an option granting N of an MFM per-item priced weapon costs N x (Forgefiend 2 ectoplasma cannons = +10)", { skip: !fs.existsSync(path.join(__dirname, "../app/data/points.json")) }, () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "../app/data/points.json"), "utf8"));
  const I = C.indexData(d);
  for (const fid of ["world-eaters", "chaos-space-marines", "thousand-sons"]) {
    const u = I.factions[fid].units.Forgefiend;
    assert.deepEqual(u.w, [["Ectoplasma cannon", 5]], `${fid}: MFM "Per Ectoplasma cannon +5"`);
    const base = C.modelOptions(u, 1)[0].points;
    const cost = (p) => {
      const l = C.newList({ name: "T", faction: fid, sub: fid, size: "strikeforce" }); const e = C.newEntry(u);
      e.lo = { c: { Forgefiend: 1 }, p }; l.entries.push(e);
      const r = C.calcList(l, I).entries[0]; return r.total - base;
    };
    assert.equal(cost({ "Forgefiend|Arm weapons": { "2 Hades autocannons": 1 }, "Forgefiend|Head weapons": { "Forgefiend jaws": 1 } }), 0, fid);
    assert.equal(cost({ "Forgefiend|Arm weapons": { "2 ectoplasma cannons": 1 }, "Forgefiend|Head weapons": { "Forgefiend jaws": 1 } }), 10, `${fid}: 2 cannons`);
    assert.equal(cost({ "Forgefiend|Arm weapons": { "2 Hades autocannons": 1 }, "Forgefiend|Head weapons": { [fid === "chaos-space-marines" ? "Ectoplasma cannon and limbs" : "Ectoplasma cannon and claws"]: 1 } }), 5, `${fid}: cannon + claws`);
    assert.equal(cost({ "Forgefiend|Arm weapons": { "2 ectoplasma cannons": 1 }, "Forgefiend|Head weapons": { [fid === "chaos-space-marines" ? "Ectoplasma cannon and limbs" : "Ectoplasma cannon and claws"]: 1 } }), 15, `${fid}: all three`);
  }
  // same rule everywhere: every "N x item" option of a per-item MFM price carries its count
  const am = I.factions["astra-militarum"].units["Leman Russ Battle Tank"];
  const sp = am.lo.u.flatMap((s) => s[1]).filter((o) => /^2 (Multi-meltas|Plasma Cannons)$/i.test(o[0]));
  assert.equal(sp.length, 2); assert.ok(sp.every((o) => o[5] === 2));
  for (const f of d.factions) for (const u of f.units) for (const s of [...((u.lo && u.lo.m) || []).flatMap((m) => m[4]), ...((u.lo && u.lo.u) || [])]) for (const o of s[1]) {
    const m = /^(\d+)\s+\S/.exec(o[0]);
    if (o[3] != null && m && +m[1] > 1) assert.equal(o[5], +m[1], `${f.id} ${u.n}: ${o[0]}`);
  }
});

test("core rules search: data shape + ranked heading matches", () => {
  const D = JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "app/data/core_rules.json"), "utf8"));
  assert.ok(D.sections.length >= 250 && D.hash && D.fetched_at && D.source.length === 2);
  const ix = C.rulesIndex(D);
  const top = (q) => C.rulesSearch(ix, q, 10)[0];
  assert.match(top("Lethal Hits").t, /LETHAL HITS/);
  assert.match(top("deep strike").t, /DEEP STRIKE/);
  assert.match(top("overwatch").t, /Fire Overwatch/);
  assert.match(top("Battle-shock").t, /Battle-shock/);
  assert.match(top("battle shock").t, /Battle-shock/);
  assert.match(top("feel no pain").t, /FEEL NO PAIN/);
  assert.match(top("Strategic Reserves").t, /Strategic Reserves/);
  assert.equal(top("24.23").n, "24.23");
  assert.deepEqual(C.rulesSearch(ix, "a", 10), []);
  const r = top("lethal hits"); assert.ok(r.path.length >= 2 && r.snippet.length > 30);
  assert.deepEqual(C.rulesMarks("[LETHAL HITS] hit", "lethal hits").filter((x) => x[1]).map((x) => x[0]), ["LETHAL", "HITS"]);
  assert.equal(C.ruleText("<p>a &amp; b</p><p>c</p>"), "a & b\nc");
});
