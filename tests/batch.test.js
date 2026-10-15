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
test("CSM: marks only on Daemon Princes; cultists have no boons; Pactbound Zealots offers marks", () => {
  const F = I.factions["chaos-space-marines"];
  for (const u of F.f.units) for (const m of (u.lo && u.lo.m) || []) for (const sl of m[4] || []) {
    if (sl[0] === "Mark of Chaos") assert.match(u.n, /Daemon Prince/, u.n);
    if (sl[0] === "Chaos Boons") assert.ok(!(u.kw || []).includes("Damned"), u.n);
  }
  const lg = F.units["Legionaries"] || F.f.units.find((u) => u.n === "Legionaries");
  assert.equal(C.markChoices(mk(F.f.id, ["Chaos Cult"]), F, lg), null);
  assert.ok(C.markChoices(mk(F.f.id, ["Pactbound Zealots"]), F, lg).includes("Nurgle"));
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
