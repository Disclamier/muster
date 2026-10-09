/* The MFM points audit (audit/): independent parser + app-side checker. The live run happens in the daily refresh
   workflow; these tests pin the parser on a fixture and prove the checker catches real mistakes. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), os = require("os"), { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const { audit } = require(path.join(ROOT, "audit/check_points.js"));
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, "app/data/points.json"), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));

const hasBs4 = spawnSync("python3", ["-c", "import bs4, lxml"]).status === 0;
test("independent MFM parser reads units, sizes, wargear, thousands, legends, detachments", { skip: !hasBs4 && "python bs4/lxml not installed" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mfm-"));
  fs.copyFileSync(path.join(__dirname, "fixtures/mfm_sample.html"), path.join(dir, "world-eaters.html"));
  const r = spawnSync("python3", [path.join(ROOT, "audit/mfm_parse.py"), dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const f = JSON.parse(r.stdout).factions["world-eaters"];
  assert.equal(f.version, "v1.5");
  assert.deepEqual(f.unknown, []);
  const by = Object.fromEntries(f.units.map((u) => [u.name, u]));
  assert.deepEqual(by.FORGEFIEND.tiers, [{ label: "YOUR UNIT COSTS", rows: [["1 model", 140]] }]);
  assert.deepEqual(by.FORGEFIEND.wargear, [["per Ectoplasma cannon", 5]]);
  assert.equal(by["WARLORD TITAN"].tiers[0].rows[0][1], 3500);
  assert.equal(by["WOLF GUARD HEADTAKERS"].tiers.length, 2);
  assert.equal(by["VENERABLE DREADNOUGHT"].legends, true);
  assert.equal(by.FORGEFIEND.legends, false);
  assert.deepEqual(f.detachments, [{ name: "BERZERKER WARBAND", dp: 2, enhancements: [["Berzerker Glaive (Upgrade)", 25]], group: "DETACHMENTS" }]);
});

/* MFM-shaped data written from the app's own tiers (so the baseline is clean); mutations must then be caught */
const ORD = ["", "1ST", "2ND", "3RD", "4TH", "5TH"];
function tierLabel(a, b) {
  if (a === 1 && b == null) return "YOUR UNIT COSTS";
  if (b == null) return `YOUR ${ORD[a]} + UNIT COSTS`;
  if (a === b) return `YOUR ${ORD[a]} UNIT COSTS`;
  return `YOUR ${ORD[a]} TO ${ORD[b]} UNITS COST`;
}
function mfmFrom(D, ids) {
  const out = { factions: {} };
  for (const f of D.factions.filter((x) => ids.includes(x.id))) {
    out.factions[f.id] = {
      units: f.units.map((u) => ({ name: u.n.replace(/ \[Legends\]$/, "").toUpperCase(), legends: !!u.lg, group: u.lg ? "LEGENDS" : "UNITS",
        tiers: u.t.map((t) => ({ label: tierLabel(t[0], t[1]), rows: t[2].map((r) => [r[2] || (r[0] === 1 ? "1 model" : `${r[0]} models`), r[1]]) })),
        wargear: (u.w || []).map((w) => [`per ${w[0]}`, w[1]]), other: [] })),
      detachments: f.dets.filter((d) => d.src === "mfm").map((d) => ({ name: d.n, dp: d.dp, enhancements: d.enh.map((e) => [e[0] + (e[3] ? " (Upgrade)" : ""), e[1]]) })),
      unknown: [] };
  }
  return out;
}
const IDS = ["world-eaters", "astra-militarum", "space-wolves", "black-templars", "grey-knights"];

test("points checker: clean baseline has zero mismatches and runs the spot checks", () => {
  const r = audit(mfmFrom(DATA, IDS), { ...DATA, factions: DATA.factions.filter((f) => IDS.includes(f.id)) }, 20261008);
  assert.deepEqual(r.issues, []);
  assert.ok(r.counts.units > 300 && r.counts.loadoutOptions > 20 && r.counts.enhancements > 50);
  assert.equal(r.counts.spot, 3 * IDS.length);
});

test("points checker catches count multipliers, wrong points, missing sizes/units/enhancements and DP", () => {
  const D = clone({ ...DATA, factions: DATA.factions.filter((f) => IDS.includes(f.id)) });
  const M = mfmFrom(DATA, IDS);
  const F = (id) => D.factions.find((f) => f.id === id);
  // 1) the original Forgefiend bug: "2 ectoplasma cannons" charged once
  const ff = F("world-eaters").units.find((u) => u.n === "Forgefiend");
  for (const m of ff.lo.m) for (const s of m[4]) for (const o of s[1]) if (o[5]) o.length = 5;
  // 2) a unit size priced wrong, 3) a size removed, 4) enhancement points and DP drift, 5) a unit dropped
  F("astra-militarum").units.find((u) => u.n === "Leman Russ Battle Tank").t[0][2][0][1] += 5;
  const ht = F("space-wolves").units.find((u) => u.n === "Wolf Guard Headtakers"); ht.t[0][2].splice(2, 1);
  const det = F("world-eaters").dets.find((d) => d.src === "mfm"); det.enh[0][1] += 5; det.dp += 1;
  F("grey-knights").units = F("grey-knights").units.filter((u) => u.n !== "Brotherhood Champion");
  const r = audit(M, D, 1);
  const has = (re) => assert.ok(r.issues.some((x) => re.test(x)), `expected an issue matching ${re}\n${r.issues.join("\n")}`);
  has(/FORGEFIEND: loadout option "2 ectoplasma cannons" charges 5 pts, MFM 2 x 5 = 10/i);
  has(/LEMAN RUSS BATTLE TANK .*app \d+ pts, MFM \d+ pts/);
  has(/WOLF GUARD HEADTAKERS .*"6 Wolf Guard Headtakers" .*not offered/);
  has(new RegExp(`${det.n}: enhancement .* app \\d+, MFM \\d+`));
  has(new RegExp(`detachment ${det.n}: app \\d DP, MFM \\d DP`));
  has(/BROTHERHOOD CHAMPION: in the MFM but missing in the app/);
  assert.equal(r.ok, false);
});

test("two sizes with the same model count are both selectable (Wolf Guard Headtakers)", () => {
  const C = require(path.join(ROOT, "app/js/core.js"));
  const I = C.indexData(DATA);
  const u = I.factions["space-wolves"].units["Wolf Guard Headtakers"];
  const opts = C.modelOptions(u, 1), six = opts.filter((o) => o.models === 6);
  assert.equal(six.length, 2);
  for (const o of six) {
    const l = C.newList({ name: "x", faction: "space-wolves", size: "strikeforce" });
    l.entries.push(Object.assign(C.newEntry(u), { models: 6, ml: o.label }));
    const row = C.calcList(l, I).entries[0];
    assert.equal(row.modelsLabel, o.label); assert.equal(row.base, o.points);
    // and it survives a share link
    const back = C.listFromShareable(JSON.parse(JSON.stringify(C.shareableList(l))));
    assert.equal(C.calcList(back, I).entries[0].base, o.points);
  }
});
