/* Oct 15 batch: DP picker, export rules appendix + Led by, CSM marks, Chaos transports, Custodes v1.6 */
const test = require("node:test"), assert = require("node:assert"), fs = require("fs");
const C = require("../app/js/core.js"), P = require("../app/data/points.json"); const I = C.indexData(P);
const mk = (fid, dets) => { const l = C.newList({ name: "t", faction: fid, sub: fid, size: "strikeforce" }); l.dets = dets; return l; };
test("detFits: a 3 DP pick greys out everything else; 2+1 fits", () => {
  const F = I.factions["chaos-space-marines"], size = I.sizes.strikeforce || { dp: 3 };
  assert.equal(C.detFits(mk(F.f.id, ["Pactbound Zealots"]), F, F.dets["Cabal of Chaos"], size), false);
  assert.equal(C.detFits(mk(F.f.id, ["Chaos Cult"]), F, F.dets["Cabal of Chaos"], size), true);
  assert.equal(C.detFits(mk(F.f.id, ["Chaos Cult"]), F, F.dets["Deceptors"], size), false);
  assert.equal(C.detFits(mk(F.f.id, []), F, F.dets["Pactbound Zealots"], size), true);
});
test("CSM: Mark of Chaos wargear only on Daemon Princes; cultists have no boons; mark picker only in Pactbound Zealots (James 18 Oct)", () => {
  const F = I.factions["chaos-space-marines"];
  for (const u of F.f.units) for (const m of (u.lo && u.lo.m) || []) for (const sl of m[4] || []) {
    if (sl[0] === "Mark of Chaos") assert.match(u.n, /Daemon Prince/, u.n);
    if (sl[0] === "Chaos Boons") assert.ok(!(u.kw || []).includes("Damned"), u.n);
  }
  const lg = F.units["Legionaries"] || F.f.units.find((u) => u.n === "Legionaries");
  assert.equal(C.markChoices(mk(F.f.id, ["Chaos Cult"]), F, lg), null);
  assert.deepEqual(C.markChoices(mk(F.f.id, ["Pactbound Zealots"]), F, lg), ["Khorne", "Tzeentch", "Nurgle", "Slaanesh", "Chaos Undivided"]);
});
test("Chaos Rhinos all have combi-bolter/combi-weapon, extra combi-bolter and havoc launcher", () => {
  for (const fid of ["chaos-space-marines", "death-guard", "world-eaters", "emperors-children", "thousand-sons"]) {
    const u = I.factions[fid].f.units.find((x) => x.n === "Chaos Rhino");
    assert.deepEqual(u.lo.m[0][4].map((s) => s[0]).slice(0, 1).concat(u.lo.m[0][4].slice(2).map((s) => s[0])), ["Pintle weapon", "Havoc launcher"], fid);
    assert.equal(u.lo.m[0][4].length, 3, fid);
  }
});
test("Custodes publish v1.6: new detachments, no GrimSlate leftovers, new units have keywords", () => {
  const F = I.factions["adeptus-custodes"];
  assert.ok(F.dets["Null Maiden Vigil"] && F.dets["Lions of the Emperor"]);
  assert.ok(!F.dets["Shield Host"] && !F.dets["Talons of the Emperor"]);
  const g = F.f.units.find((u) => u.n === "Gyrfalcon Jetbike Sodality"); assert.ok((g.kw || []).length > 1);
});
test("export: rules appendix on request, attached units say who leads them", () => {
  const F = I.factions["death-guard"]; const l = mk("death-guard", [Object.keys(F.dets)[0]]);
  const a = C.newEntry(F.units["Plague Marines"]), b = C.newEntry(F.units["Foul Blightspawn"]); b.attach = a.uid; l.entries.push(a, b);
  const plain = C.exportText(l, I, {}, "gw"), full = C.exportText(l, I, {}, "gw", { rules: true });
  assert.match(plain, /Led by|Attached|Foul Blightspawn/);
  assert.ok(full.length > plain.length); assert.match(full, /Stratagem|STRATAGEM/i);
});
test("touch devices: list-creation modal does not autofocus", () => {
  const src = fs.readFileSync(__dirname + "/../app/js/app.js", "utf8"); assert.match(src, /isTouch\(\)/);
});
test("export box: rules checkbox is a large labelled control next to the unchanged options", () => {
  const src = fs.readFileSync(__dirname + "/../app/js/app.js", "utf8"), css = fs.readFileSync(__dirname + "/../app/css/app.css", "utf8");
  assert.match(src, /exp-rules-box[\s\S]*data-change="exp-rules"/); assert.match(src, /data-change="md"/);
  assert.match(css, /\.exp-rules-box\{[^}]*min-height:44px[^}]*cursor:pointer/);
});
test("CSM: every unit except the two Daemon Princes has no Mark of Chaos wargear; Cultist Firebrand picks a mark only in Pactbound", () => {
  const F = I.factions["chaos-space-marines"], MK = ["Khorne", "Nurgle", "Slaanesh", "Tzeentch", "Chaos Undivided"];
  const DP = ["Heretic Astartes Daemon Prince", "Heretic Astartes Daemon Prince with wings"];
  for (const u of F.f.units.filter((x) => !x.af)) {   // allied Chaos Daemons (Daemonic Pact) carry their own datasheets' Allegiance
    const slots = ((u.lo && u.lo.m) || []).flatMap((m) => m[4] || []);
    const marked = slots.some((sl) => /Mark/i.test(sl[0]) || sl[1].filter((o) => MK.includes(o[0])).length >= 3);
    assert.equal(marked, DP.includes(u.n), u.n);
  }
  assert.equal(C.markChoices(mk(F.f.id, []), F, F.units["Cultist Firebrand"]), null);
  assert.equal(C.markChoices(mk(F.f.id, ["Pactbound Zealots"]), F, F.units["Cultist Firebrand"]).length, 5);
});
test("export rules appendix: one Detachment rule line per detachment, one line per stratagem (name, CP, text)", () => {
  const F = I.factions["chaos-space-marines"]; const l = mk(F.f.id, ["Chaos Cult", "Cabal of Chaos"]); l.entries.push(C.newEntry(F.units["Legionaries"]));
  const t = C.exportText(l, I, {}, "gw", { rules: true }); const app = t.slice(t.indexOf("DETACHMENT RULES & STRATAGEMS")).split("\n");
  for (const n of ["Chaos Cult", "Cabal of Chaos"]) {
    assert.equal(app.filter((x) => x.startsWith(`Detachment rule (${n}) – `)).length, 1, n);
    for (const s of F.dets[n].st) assert.equal(app.filter((x) => x.startsWith(`Stratagem: ${s[0]} – ${s[1]}CP – `)).length, 1, s[0]);
  }
});
test("export rules appendix: blank line between each detachment rule / stratagem entry; Stratagems format spaced too", () => {
  const F = I.factions["chaos-space-marines"]; const l = mk(F.f.id, ["Chaos Cult", "Cabal of Chaos"]); l.entries.push(C.newEntry(F.units["Legionaries"]));
  const t = C.exportText(l, I, {}, "gw", { rules: true }); const app = t.slice(t.indexOf("DETACHMENT RULES & STRATAGEMS")).split("\n");
  app.forEach((x, i) => { if (/^(Detachment rule \(|Stratagem: )/.test(x)) assert.equal(app[i + 1], "", x); });
  const s = C.exportText(l, I, {}, "stratagems", { rules: true }).split("\n");
  for (const st of F.dets["Chaos Cult"].st) { const i = s.findIndex((x) => x.startsWith(`${st[0]} – ${st[1]}CP`)); assert.ok(i > 0 && s[i - 1] === "" || /^== /.test(s[i - 1]), st[0]); }
});
test("CSM: outside Pactbound Zealots no unit other than the two Daemon Princes can pick a Mark of Chaos (incl. Land Raider, Chaos Lord)", () => {
  const F = I.factions["chaos-space-marines"]; const DP = ["Heretic Astartes Daemon Prince", "Heretic Astartes Daemon Prince with wings"];
  assert.ok(F.units["Chaos Land Raider"] && F.units["Chaos Lord"]);
  for (const d of [[], ...Object.keys(F.dets).filter((n) => n !== "Pactbound Zealots").map((n) => [n])]) for (const u of F.f.units.filter((x) => !x.af)) {
    assert.equal(C.markChoices(mk(F.f.id, d), F, u), null, `${u.n} ${d}`);
    const marks = ((u.lo && u.lo.m) || []).flatMap((m) => m[4] || []).filter((sl) => /mark/i.test(sl[0]) || sl[1].some((o) => /^(Khorne|Nurgle|Tzeentch|Slaanesh|Chaos Undivided)$/.test(o[0])));
    assert.equal(marks.length > 0, DP.includes(u.n), u.n);
  }
});
test("CSM Cultist Mob matches the 11th-ed datasheet: Champion autopistol->bolt pistol swap, autopistol + brutal assault weapon, no Chaos Boons", () => {
  const DS = require("../app/data/datasheets.json").factions["chaos-space-marines"].units["Cultist Mob"];
  const u = I.factions["chaos-space-marines"].units["Cultist Mob"];
  assert.deepEqual(DS.wa || [], []);
  assert.deepEqual(DS.wp.map((w) => w[0]).sort(), ["Autopistol", "Bolt pistol", "Brutal assault weapon"]);
  const opts = u.lo.m.flatMap((m) => m[4].flatMap((s) => s[1].map((o) => o[0])));
  assert.deepEqual(opts.sort(), ["Autopistol", "Bolt pistol"]);
  assert.deepEqual(u.lo.m.map((m) => m[3]), [["Brutal assault weapon"], ["Autopistol", "Brutal assault weapon"]]);
});
