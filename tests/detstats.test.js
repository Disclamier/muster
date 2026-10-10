/* Detachment-rule stat changes: parsed from the current detachment rule text, applied only to eligible units. */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const C = require(path.join(__dirname, "../app/js/core.js"));
const P = require(path.join(__dirname, "../app/data/points.json"));
const I = C.indexData(P);
const F = (fid) => I.factions[fid];
const mods = (fid, det) => { const d = F(fid).dets[det]; assert.ok(d, det); return C.detStatMods(d); };
const elig = (fid, det, unit, stat) => {
  const u = F(fid).units[unit]; assert.ok(u, unit);
  return mods(fid, det).filter((m) => m.stat === stat && C.detModEligible(m, u, F(fid)));
};
const entry = (fid, det, unit, enh) => { const u = F(fid).units[unit]; return { unit: u, name: u.n, entry: { enh: enh ? { det, name: enh } : null } }; };

test("unconditional detachment changes, only for the named keywords", () => {
  assert.equal(elig("necrons", "Cursed Legion", "Skorpekh Lord", "S")[0].v, 2);           // DESTROYER CULT weapons +2 S
  assert.equal(elig("necrons", "Cursed Legion", "Necron Warriors", "S").length, 0);
  assert.equal(elig("chaos-knights", "Lords of Dread", "Knight Abominant", "OC").length, 1);   // CHAOS KNIGHTS CHARACTER +2 OC
  assert.equal(elig("chaos-knights", "Lords of Dread", "War Dog Karnivore", "OC").length, 0);
  const inv = elig("chaos-space-marines", "Cult of the Arkifane", "Lord Discordant on Helstalker", "INV");   // granted SOUL FORGE keyword
  assert.equal(inv.length, 1); assert.equal(inv[0].cond, null);
  assert.equal(elig("chaos-space-marines", "Cult of the Arkifane", "Legionaries", "INV").length, 0);
  assert.equal(elig("adeptus-mechanicus", "Cohort Cybernetica", "Kastelan Robots", "M")[0].v, 2);
  assert.equal(elig("adeptus-mechanicus", "Cohort Cybernetica", "Skitarii Rangers", "M").length, 0);
});

test("conditional / choose-one detachment changes are dashed with the condition (options listed)", () => {
  const ap = elig("adeptus-custodes", "Shield Host", "Custodian Guard", "AP");
  assert.ok(ap[0].cond && /select one of the bullet points/.test(ap[0].cond));
  const cob = mods("chaos-space-marines", "Creations of Bile");
  assert.deepEqual(cob.map((m) => m.stat).sort(), ["A", "BS", "M", "S", "T", "WS"]);
  assert.ok(cob.every((m) => m.cond && /select which augmentations/.test(m.cond)));
  assert.ok(C.detModEligible(cob[0], F("chaos-space-marines").units["Legionaries"], F("chaos-space-marines")));
  assert.ok(!C.detModEligible(cob[0], F("chaos-space-marines").units["Cultist Mob"], F("chaos-space-marines")), "DAMNED excluded");
  assert.ok(elig("adeptus-mechanicus", "Haloscreed Battleclade", "Skitarii Rangers", "T")[0].cond);
  assert.ok(elig("emperors-children", "Court of the Phoenician", "Lord Exultant", "S")[0].cond);
  const kroot = elig("tau-empire", "Kroot Hunting Pack", "Kroot Carnivores", "INV");
  assert.equal(kroot.length, 2); assert.equal(elig("tau-empire", "Kroot Hunting Pack", "Strike Team", "INV").length, 0);
});

test("no false positives: enemy targets, keyword thresholds; doctrines/sagas have no stat change in the detachment text", () => {
  assert.deepEqual(mods("orks", "Madcap Meks"), []);
  assert.deepEqual(mods("astra-militarum", "Armoured Infantry"), []);
  assert.deepEqual(mods("space-marines", "Gladius Task Force"), []);
  assert.deepEqual(mods("space-wolves", "Saga of the Great Wolf"), []);
});

test("entry mods combine enhancement + detachment on the same stat (both sources)", () => {
  const r = entry("emperors-children", "Court of the Phoenician", "Daemon Prince of Slaanesh", "Spiritsliver");
  const ms = C.entryStatMods(F("emperors-children"), r, ["Court of the Phoenician"]).filter((m) => m.stat === "S");
  assert.deepEqual(ms.map((m) => m.src || "enh").sort(), ["det", "enh"]);
  const x = C.statWithMods("S", "6", ms);
  assert.equal(x.v, "7"); assert.equal(x.cond, false); assert.equal(x.mods.length, 2);
  // detachment only, unconditional: Cursed Legion
  const y = C.statWithMods("S", "5", C.entryStatMods(F("necrons"), entry("necrons", "Cursed Legion", "Skorpekh Lord"), ["Cursed Legion"]));
  assert.equal(y.v, "7"); assert.equal(y.mods[0].src, "det"); assert.match(y.mods[0].enh, /Cursed Legion – /);
});

test("count: stat-modifying detachment rules", () => {
  const seen = new Set(); let n = 0;
  for (const f of P.factions) for (const d of f.dets) { const t = (d.rule || [])[1] || ""; if (seen.has(t)) continue; seen.add(t); if (C.detStatMods(d).length) n++; }
  assert.ok(n >= 38, String(n));
});
