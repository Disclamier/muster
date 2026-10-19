/* Custodes codex army rules (printed codex photos from James, 2026-10-18; Wahapedia 11e agrees) */
const test = require("node:test"), assert = require("node:assert");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const C = require("../app/js/core.js"), P = require("../app/data/points.json"), D = require("../app/data/datasheets.json");
const CUR = require("../scraper/overrides/curated_datasheets.json");
const FR = D.factions["adeptus-custodes"].rules, R = (n) => FR.find((r) => C.norm(r[0]) === C.norm(n));
const F = P.factions.find((f) => f.id === "adeptus-custodes");

test("Custodes army rules: every faction ability a datasheet names has codex text", () => {
  const own = F.units.filter((u) => !u.ally).map((u) => u.n);   // allied Assigned Agents carry their own rule
  const names = new Set(own.flatMap((n) => (D.factions["adeptus-custodes"].units[n] || {}).fa || []));
  assert.equal(names.size, 4);
  for (const n of names) assert.ok(R(n) && R(n)[1].length > 40, n);
  for (const n of ["Martial Ka’tah", "Aegis of the Emperor", "Aquila Commander", "Daughters of the Abyss", "Anathema Psykana"]) assert.ok(R(n), n);
});

test("Martial Ka'tah: readied units + six ka'tah abilities (no 10e stances left)", () => {
  const m = R("Martial Ka'tah");
  assert.match(m[1], /At the start of your Command phase, friendly ADEPTUS CUSTODES units with this ability are readied/);
  assert.doesNotMatch(m[1], /STANCE|SUSTAINED HITS 1/);
  assert.deepEqual(m[2].ka.map((k) => k[0]), ["CONSERVAI", "CALISTUS", "SALVUS", "DACATARAI", "KAPTARIS", "RENDAX"]);
  const k = Object.fromEntries(m[2].ka.map((x) => [x[0], x]));
  assert.match(k.RENDAX[3], /\[LETHAL HITS: MONSTER\/VEHICLE\]/);
  assert.match(k.KAPTARIS[3], /Melee attacks that target your unit have -1 to hit rolls/);
  assert.match(k.DACATARAI[3], /excluding MONSTER\/VEHICLE units\) can re-roll hit rolls of 1/);
  assert.match(k.CALISTUS[1], /Movement phase/); assert.match(k.SALVUS[3], /BS/);
  assert.match(m[1], /FAVOURED KA'TAH[\s\S]*Solar Watch[\s\S]*\+2" M/);
  assert.doesNotMatch(C.armyRuleBody(m), /CONSERVAI|RENDAX/);   // shown as cards, not twice
});

test("every UNIQUE: SHIELD HOST detachment states a Favoured Ka'tah with its additional effect", () => {
  const hosts = F.dets.filter((d) => (d.rs || []).includes("UNIQUE: SHIELD HOST"));
  assert.deepEqual(hosts.map((d) => d.n).sort(), ["Aquilan Shield", "Dread Host", "Emissaries Imperatus", "Emperor’s Chosen", "Shadowkeepers", "Solar Watch"]);
  const fav = Object.fromEntries(hosts.map((d) => { const f = C.favouredKatah(d); assert.ok(f && f.effect, d.n); return [d.n, f.name]; }));
  assert.deepEqual(fav, { "Aquilan Shield": "SALVUS", "Dread Host": "DACATARAI", "Emissaries Imperatus": "CONSERVAI", "Emperor’s Chosen": "RENDAX", Shadowkeepers: "KAPTARIS", "Solar Watch": "CALISTUS" });
  for (const d of F.dets.filter((x) => !hosts.includes(x))) assert.equal(C.favouredKatah(d), null, d.n);
});

test("Favoured Ka'tah effects are not standing stat mods (Solar Watch +2\" M only with Calistus)", () => {
  assert.deepEqual(C.detStatMods(F.dets.find((d) => d.n === "Solar Watch"), []), []);
  assert.deepEqual(C.detStatMods(F.dets.find((d) => d.n === "Aquilan Shield"), []), []);
});

test("Daughters of the Abyss: FNP 3+ vs psychic attacks only + Psychic Null 6\" aura on every Anathema Psykana unit", () => {
  const d = R("Daughters of the Abyss");
  assert.match(d[1], /Feel No Pain 3\+ against psychic attacks/); assert.doesNotMatch(d[1], /mortal wounds/);
  assert.deepEqual(d[2].grants, [["Psychic Null (Aura)", "Friendly ADEPTUS CUSTODES units within 6\" of this unit have Feel No Pain 5+ against psychic attacks."]]);
  for (const n of ["Witchseeker Squad", "Prosecutor Squad", "Vigilator Squad", "Knight-Centura", "Aleya", "Anathema Psykana Rhino"])
    assert.ok(D.factions["adeptus-custodes"].units[n].fa.includes("Daughters of the Abyss"), n);
});

test("Aquila Commander / Aegis / Anathema Psykana text; Sisters still can't be Warlord outside Null Maiden Vigil", () => {
  assert.equal(R("Aquila Commander")[1], "At the start of the battle round, if a model with this ability is your WARLORD, gain 1CP.");
  assert.match(R("Aegis of the Emperor")[1], /Feel No Pain 5\+ against mortal wounds/);
  assert.match(R("Anathema Psykana")[1], /unless otherwise stated:[\s\S]*cannot select ANATHEMA PSYKANA as your army faction[\s\S]*WARLORD/);
  for (const n of ["Shield-Captain", "Shield-Captain in Allarus Terminator Armour", "Shield-Captain on Dawneagle Jetbike", "Trajann Valoris", "Valerian"])
    assert.ok(D.factions["adeptus-custodes"].units[n].fa.includes("Aquila Commander"), n);
  for (const n of ["Aleya", "Knight-Centura"]) assert.deepEqual(F.units.find((u) => u.n === n).wr, ["Null Maiden Vigil"], n);
  assert.match(F.dets.find((d) => d.n === "Null Maiden Vigil").rule[1], /can select a friendly ANATHEMA PSYKANA CHARACTER model to be your WARLORD/);
});

test("refresh: curated army rules beat older text, a newer GW app version with the same rule wins", () => {
  const rec = CUR.rules["adeptus-custodes"]; assert.equal(rec.app_version, "995");
  const py = (app) => JSON.parse(execFileSync("python3", ["-c", `import json,sys; sys.path.insert(0,'scraper'); import curated
f=[["Martial Ka'tah","old 10e stances"],["Other","x"]]; curated.apply_rules("adeptus-custodes", f, {}, app=json.loads(sys.argv[1])); print(json.dumps(f))`, JSON.stringify(app)], { cwd: path.join(__dirname, "..") }));
  let f = py({ version: 995, rules: [["Aquila Commander", "older app text"]] });
  assert.match(f[0][1], /readied/); assert.equal(f.find((r) => r[0] === "Aquila Commander")[1], rec.set[2][1]); assert.equal(f[1][0], "Other");
  f = py({ version: 1001, rules: [["Aquila Commander", "newer app text"]] });
  assert.equal(f.find((r) => r[0] === "Aquila Commander")[1], "newer app text"); assert.match(f[0][1], /readied/);
  // the committed datasheets equal the curated set (build applies it last)
  for (const r of rec.set) assert.deepEqual(R(r[0]), r, r[0]);
});
