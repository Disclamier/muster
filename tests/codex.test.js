/* Codex override layer: Space Marines 11th-edition codex data beats GrimSlate; MFM points stay authoritative. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const C = require("../app/js/core.js");

const ROOT = path.join(__dirname, "..");
const OV = JSON.parse(fs.readFileSync(path.join(ROOT, "scraper/overrides/space_marines_codex.json"), "utf8"));
const P = JSON.parse(fs.readFileSync(path.join(ROOT, "app/data/points.json"), "utf8"));
const DS = JSON.parse(fs.readFileSync(path.join(ROOT, "app/data/datasheets.json"), "utf8"));
const fac = (id) => P.factions.find((f) => f.id === id);

test("codex override file: compiled, complete and validated", () => {
  assert.equal(OV.datasheets.length, 85);
  assert.equal(OV.detachments.length, 15);
  assert.equal(OV.detachments.reduce((n, d) => n + d.stratagems.length, 0), 48);
  assert.equal(OV.detachments.reduce((n, d) => n + d.enhancements.length, 0), 32);
  assert.ok(OV.army_rules.some((r) => r.name === "Combat Doctrines"));
  // the committed JSON is what codex_parse.py produces from the transcription
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-"));
  const out = execFileSync("python3", ["-c", `import sys, json; sys.path.insert(0, "${path.join(ROOT, "scraper")}"); import codex_parse as c; d = c.compile_dir("${path.join(ROOT, "scraper/overrides/space_marines_codex")}"); assert not c.validate(d); print(json.dumps([len(d["datasheets"]), len(d["detachments"])]))`]).toString();
  assert.deepEqual(JSON.parse(out), [85, 15]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("built data: codex datasheets override GrimSlate for Space Marines (incl. divergent chapters' generic units)", () => {
  const sm = DS.factions["space-marines"].units;
  const rg = sm["Roboute Guilliman"];
  assert.equal(rg.src, "codex");
  assert.deepEqual(rg.s, { M: '8"', T: "10", SV: "2+", W: "16", LD: "5+", OC: "4" });
  assert.equal(rg.inv, "4+");
  assert.ok(rg.ab.some((a) => /Primarch of the XIII \(Aura\)/.test(a[0])));
  assert.deepEqual(rg.fa, ["Combat Doctrines", "Transhuman Strategist"]);
  const inter = sm["Intercessor Squad"];
  const br = inter.wp.find((w) => w[0] === "Bolt Rifle");
  assert.deepEqual(br[2].map((p) => p[0]), ["Focused Fire", "Saturation"]);
  assert.ok(inter.wo.length && inter.comp.length);
  assert.ok(DS.factions["space-marines"].rules.some((r) => r[0] === "Combat Doctrines"));
  // every codex datasheet is applied to its Space Marines unit
  const byNorm = Object.fromEntries(Object.entries(sm).map(([n, v]) => [C.norm(n), v]));   // MFM display names ("Invader Atvs")
  for (const d of OV.datasheets) assert.equal((byNorm[C.norm(d.name)] || {}).src, "codex", d.name);
  // divergent chapters: generic units take the codex sheet, chapter-specific units don't exist there
  assert.equal(DS.factions["blood-angels"].units["Intercessor Squad"].src, "codex");
  assert.equal(DS.factions["blood-angels"].units["Roboute Guilliman"], undefined);
});

test("built data: codex detachments (rule, stratagems, enhancement text) with MFM points kept", () => {
  for (const fid of ["space-marines", "blood-angels", "space-wolves", "dark-angels", "black-templars", "deathwatch"]) {
    const g = fac(fid).dets.find((d) => d.n === "Gladius Task Force");
    assert.deepEqual(g.rule[0], "Codex Discipline", fid);
    assert.equal(g.st.length, 6);
    const aoc = g.st.find((s) => s[0] === "Armour of Contempt");
    assert.equal(aoc[1], 1); assert.match(aoc[5], /^WHEN: Your opponent's Shooting phase or the Fight phase/);
    assert.equal(aoc[4], "Either player's turn");
    assert.ok(g.enh.every((e) => e[2] && !/pending/i.test(e[2])), "every enhancement has codex text");
  }
  const g = fac("space-marines").dets.find((d) => d.n === "Gladius Task Force");
  assert.deepEqual(g.enh.map((e) => [e[0], e[1]]).sort(), [["Adept of the Codex", 20], ["Artificer Armour", 15], ["Laurels of Triumph", 20], ["Standard of the Emperor Ascendant", 25]]);
  assert.equal(g.dp, 3);   // MFM detachment points
  const codexDets = fac("space-marines").dets.filter((d) => d.cx);
  assert.equal(codexDets.length, 15);
  assert.equal(codexDets.reduce((n, d) => n + d.st.length, 0), 48);
  assert.ok(codexDets.find((d) => d.n === "Terminator Storm Force").rs.includes("UNIQUE: TERMINATOR"), "MFM restrictions preserved");
});

test("codex keywords keep enhancement eligibility working; MFM points unchanged by the override", () => {
  const I = C.indexData(P); const F = I.factions["space-marines"];
  const g = F.f.dets.find((d) => d.n === "Gladius Task Force");
  const std = g.enh.find((e) => e[0] === "Standard of the Emperor Ascendant");
  const adept = g.enh.find((e) => e[0] === "Adept of the Codex");
  assert.ok(C.enhEligible(F.units["Ancient"], std, F).ok);
  assert.ok(C.enhEligible(F.units["Bladeguard Ancient"], std, F).ok);
  assert.ok(!C.enhEligible(F.units["Captain"], std, F).ok);
  assert.ok(C.enhEligible(F.units["Captain"], adept, F).ok);
  assert.ok(!C.enhEligible(F.units["Lieutenant"], adept, F).ok);
  assert.ok(!C.enhEligible(F.units["Roboute Guilliman"], adept, F).ok, "Epic Heroes cannot take enhancements");
  const tsf = F.f.dets.find((d) => d.n === "Terminator Storm Force");
  const champ = tsf.enh.find((e) => /Champion of the First Company/.test(e[0]));
  assert.ok(C.enhEligible(F.units["Captain in Terminator Armour"], champ, F).ok);
  assert.ok(!C.enhEligible(F.units["Captain"], champ, F).ok);
  // codex "(excluding DEDICATED TRANSPORT/FLY/WALKER units)" exclusions are honoured for upgrades
  const isd = F.f.dets.find((d) => d.n === "Ironstorm Spearhead");
  const gh = isd.enh.find((e) => /Gunnery Honours/.test(e[0]));
  assert.ok(C.enhEligible(F.units["Gladiator Lancer"], gh, F).ok);
  assert.ok(!C.enhEligible(F.units["Redemptor Dreadnought"], gh, F).ok, "Walker excluded");
  assert.ok(!C.enhEligible(F.units["Rhino"], gh, F).ok, "Dedicated Transport excluded");
  assert.ok(!C.enhEligible(F.units["Storm Speeder Hailstrike"], gh, F).ok, "Fly excluded");
  // points: still the Field Manual's (cost tiers untouched), codex units still have their roles
  assert.equal(F.units["Intercessor Squad"].r, "Battleline");
  assert.equal(F.units["Roboute Guilliman"].r, "Epic Hero");
  assert.ok(F.units["Intercessor Squad"].t.length && F.units["Intercessor Squad"].cx);
});

test("build_data.py applies the override even without GrimSlate data", { skip: !fs.existsSync(path.join(ROOT, "data/mfm.json")) }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "muster-build-"));
  execFileSync("python3", [path.join(ROOT, "scraper/build_data.py"), "--gs", path.join(out, "missing.json"), "--outdir", out], { stdio: "pipe" });
  const ds = JSON.parse(fs.readFileSync(path.join(out, "datasheets.json"), "utf8"));
  const pts = JSON.parse(fs.readFileSync(path.join(out, "points.json"), "utf8"));
  assert.equal(ds.factions["space-marines"].units["Redemptor Dreadnought"].src, "codex");
  assert.equal(pts.factions.find((f) => f.id === "space-marines").dets.find((d) => d.n === "Ironstorm Spearhead").st.length, 3);
  // codex loadout picker is built from the codex composition (MFM-priced Macro Plasma Incinerator stays linked)
  const red = pts.factions.find((f) => f.id === "space-marines").units.find((u) => u.n === "Redemptor Dreadnought");
  const slot = red.lo.m[0][4].find((s) => s[1].some((o) => o[0] === "Macro Plasma Incinerator"));
  assert.ok(slot && slot[1].find((o) => o[0] === "Macro Plasma Incinerator")[3] !== null);
  fs.rmSync(out, { recursive: true, force: true });
});
