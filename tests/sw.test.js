/* Space Wolves detachments after Codex: Space Marines (MFM v1.5, 30 Sep 2026; Warhammer 40,000 app data 30 Sep 2026;
   Warhammer Community 16 Sep 2026): exactly the MFM detachment list, current saga / Champions of Fenris text,
   Deathwatch Support filled in, and the per-unit stratagem matcher on the new targets. */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const C = require(path.join(__dirname, "../app/js/core.js"));
const D = require(path.join(__dirname, "../app/data/points.json"));
const I = C.indexData(D);
const SW = I.factions["space-wolves"];
const det = (n) => { const d = SW.dets[n]; assert.ok(d, n); return d; };
const strat = (d, n) => { const s = det(d).st.find((x) => x[0] === n); assert.ok(s, `${d}: ${n}`); return s; };
const ap = (x) => x.replace(/[’‘]/g, "'");   // MFM names use typographic apostrophes
const enh = (d, n) => { const e = det(d).enh.find((x) => ap(x[0]) === n); assert.ok(e, `${d}: ${n}`); return e; };

const SW_DETS = ["Assault Brethren", "Champions of Fenris", "Deathwatch Support", "Devastator Brethren", "Gauntlet Task Force",
  "Gladius Task Force", "Gravis Linebreaker Force", "Gravis Siege Force", "Ironclad Champions", "Ironstorm Spearhead",
  "Phobos Shadow Force", "Phobos Shock Force", "Saga of the Beastslayer", "Saga of the Great Wolf", "Stormlance Task Force",
  "Tactical Brethren", "Tacticus Attack Force", "Tacticus Firestorm Force", "Terminator Storm Force"];

test("Space Wolves offer exactly the 19 current MFM detachments (no pre-codex leftovers)", () => {
  assert.deepEqual(SW.f.dets.map((d) => d.n).sort(), SW_DETS.slice().sort());
  for (const d of SW.f.dets) assert.equal(d.src, "mfm", d.n);
  for (const gone of ["Saga of the Hunter", "Saga of the Bold", "Legends of Saga and Song", "Veterans of the Fang", "Vanguard Spearhead",
    "Firestorm Assault Force", "1st Company Task Force", "Anvil Siege Force"]) assert.equal(SW.dets[gone], undefined, gone);
});

test("codex-override Adeptus Astartes factions: no pre-codex GrimSlate-only detachments", () => {
  // only a current codex detachment an MFM faction page omits survives as "not in current MFM" (Black Templars Gladius)
  for (const fid of ["space-marines", "black-templars", "blood-angels", "dark-angels", "deathwatch", "space-wolves"])
    assert.deepEqual(I.factions[fid].f.dets.filter((d) => d.src === "gs" && !d.cx).map((d) => d.n), [], fid);
  assert.deepEqual(I.factions["black-templars"].f.dets.filter((d) => d.src === "gs").map((d) => d.n), ["Gladius Task Force"]);
  for (const gone of ["Vanguard Spearhead", "Firestorm Assault Force", "Godhammer Assault Force"]) assert.equal(I.factions["black-templars"].dets[gone], undefined, gone);
});

test("every Space Wolves detachment has rule, enhancement text and stratagems", () => {
  for (const d of SW.f.dets) {
    assert.ok(d.rule && d.rule[1] && !/pending/i.test(d.rule[1]), `${d.n} rule`);
    assert.ok(d.st.length >= 3, `${d.n} stratagems`);
    for (const e of d.enh) assert.ok(e[2] && !/pending/i.test(e[2]), `${d.n}: ${e[0]} text`);
  }
});

test("Champions of Fenris: current rule, enhancements and stratagems; MFM points/DP", () => {
  const d = det("Champions of Fenris");
  assert.equal(d.dp, 1);
  assert.equal(d.rule[0], "The Great Wolf Watches");
  assert.match(d.rule[1], /ADEPTUS ASTARTES CHARACTER units/);
  assert.match(d.rule[1], /Heroic Intervention Stratagem, that use is -1CP/i);
  assert.deepEqual(d.st.map((s) => [s[0], s[1]]), [["Champion's Guidance", 1], ["Birth of a Saga", 1], ["Heroic Resolve", 2]]);
  assert.match(strat("Champions of Fenris", "Heroic Resolve")[5], /-1 D until that enemy unit has attacked/);
  assert.equal(enh("Champions of Fenris", "Preyslayer")[1], 15);
  assert.match(enh("Champions of Fenris", "Preyslayer")[2], /re-roll charge rolls/);
  assert.equal(enh("Champions of Fenris", "A Giant Amongst Giants")[1], 15);
});

test("Saga of the Beastslayer: Legendary Slayers + 3 stratagems (was 'rules pending')", () => {
  const d = det("Saga of the Beastslayer");
  assert.equal(d.dp, 1);
  assert.equal(d.rule[0], "Legendary Slayers");
  assert.match(d.rule[1], /\[LETHAL HITS: CHARACTER\/MONSTER\/VEHICLE\]/);
  assert.deepEqual(d.st.map((s) => s[0]), ["Co-ordinated Strike", "Impetuosity", "Unbridled Ferocity"]);
  assert.deepEqual(d.enh.map((e) => [ap(e[0]), e[1]]).sort(), [["Hunter's Guile", 20], ["Wolf-Touched", 15]]);
});

test("Saga of the Great Wolf: Master of Wolves (combat doctrines) + 6 current stratagems", () => {
  const d = det("Saga of the Great Wolf");
  assert.equal(d.dp, 2);
  assert.equal(d.rule[0], "Master of Wolves");
  for (const x of ["Encircling Jaws", "Hunter's Eye", "Ferocious Strike", "Howling Onslaught", "cannot include any ADEPTUS ASTARTES units drawn from any other Chapter"])
    assert.ok(d.rule[1].includes(x), x);
  assert.deepEqual(d.st.map((s) => s[0]).sort(), ["Battle Instincts", "Eye of the Pack", "Fangs of the Pack", "Fenrisian Ferocity", "Grimnar's Command", "Wolf Totems"]);
  assert.ok(d.st.every((s) => s[1] === 1));
  assert.match(strat("Saga of the Great Wolf", "Grimnar's Command")[5], /Select one combat doctrine/);
  assert.match(strat("Saga of the Great Wolf", "Battle Instincts")[5], /D3\+3"/);
  // the stale pre-codex version (Faction Pack v1.2: Hunting Packs, The Foe Foreseen, Unrelenting Hunters) must not come back
  assert.doesNotMatch(JSON.stringify(d), /Hunting Pack|The Foe Foreseen|Unrelenting Hunters/);
  assert.equal(strat("Saga of the Great Wolf", "Wolf Totems")[2], "Any phase");
  assert.equal(strat("Saga of the Great Wolf", "Fenrisian Ferocity")[2], "Movement phase or Charge phase");
  assert.deepEqual(d.enh.map((e) => [ap(e[0]), e[1]]).sort(), [["Chariots of the Storm", 25], ["Grimnar's Mark", 15], ["Howlmaw", 15], ["Skjald's Foretelling", 20]]);
  assert.match(enh("Saga of the Great Wolf", "Skjald's Foretelling")[2], /\[LANCE\]/);
});

test("Deathwatch Support: Mission Tactics + 4 stratagems in every chapter that lists it", () => {
  for (const fid of ["space-wolves", "space-marines", "blood-angels", "dark-angels", "black-templars"]) {
    const d = I.factions[fid].dets["Deathwatch Support"];
    assert.ok(d, fid);
    assert.equal(d.rule[0], "Mission Tactics");
    assert.deepEqual(d.st.map((s) => s[0]), ["Blackstar Extraction", "Kraken Rounds", "Dragonfire Rounds", "Hellfire Rounds"]);
    assert.equal(d.enh[0][0], "Beacon Angelis");
    assert.equal(d.enh[0][1], 25);
  }
});

test("per-unit stratagem matcher on the new Space Wolves targets", () => {
  const m = (u, d, s) => C.unitStratMatch(SW.units[u], SW, strat(d, s));
  for (const u of ["Blood Claws", "Thunderwolf Cavalry", "Wulfen"]) assert.equal(m(u, "Saga of the Beastslayer", "Unbridled Ferocity").ok, true, u);
  assert.equal(m("Grey Hunters", "Saga of the Beastslayer", "Unbridled Ferocity").ok, false);
  assert.equal(m("Thunderwolf Cavalry", "Saga of the Great Wolf", "Fenrisian Ferocity").ok, true);
  assert.equal(m("Land Raider", "Saga of the Great Wolf", "Grimnar's Command").ok, false);
  assert.equal(m("Logan Grimnar", "Champions of Fenris", "Heroic Resolve").ok, true);
  assert.equal(m("Grey Hunters", "Champions of Fenris", "Champion's Guidance").ok, false);
  // KILL TEAM is a Deathwatch datasheet keyword: no Space Wolves unit gets the Deathwatch Support stratagems (not even "check")
  for (const s of ["Blackstar Extraction", "Kraken Rounds"]) assert.equal(m("Grey Hunters", "Deathwatch Support", s).ok, false, s);
});
