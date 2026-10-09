/* All armies: detachment rules / stratagems / enhancement text come from the newest Warhammer 40,000 app data
   (scraper/overrides/gwapp_detachments.json, applied last by build_data.py so it wins on every daily refresh);
   points stay MFM (audit.test.js + audit/check_points.js). Guards against stale or empty detachments coming back. */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const C = require(path.join(__dirname, "../app/js/core.js"));
const P = require(path.join(__dirname, "../app/data/points.json"));
const OV = require(path.join(__dirname, "../scraper/overrides/gwapp_detachments.json"));
const I = C.indexData(P);
const n = (x) => String(x).toLowerCase().replace(/[’‘]/g, "'");
const det = (fid, d) => { const x = I.factions[fid].dets[d]; assert.ok(x, `${fid}: ${d}`); return x; };
const st = (fid, d, name) => { const s = det(fid, d).st.find((x) => n(x[0]) === n(name)); assert.ok(s, `${fid}/${d}: ${name}`); return s; };
const NO_ST = new Set(["Sanctified Orators", "Brute Bosses", "Wurrband"]);
const names = (fid, d) => det(fid, d).st.map((s) => n(s[0])).sort();

test("every detachment of every army has app rules text, stratagems with CP + phase, and enhancement text", () => {
  let dets = 0, strats = 0, enh = 0;
  for (const f of P.factions) for (const d of f.dets) {
    dets++;
    assert.equal(d.ga, 1, `${f.id}: ${d.n} not matched to the app data`);
    assert.ok(d.rule && d.rule[0] && d.rule[1] && d.rule[1].length > 20 && !/rules pending/i.test(d.rule[1]), `${f.id}: ${d.n} rule`);
    // three detachments have no stratagems in the app data (Sanctified Orators, Brute Bosses, Wurrband)
    if (!NO_ST.has(d.n)) assert.ok(d.st.length >= 1, `${f.id}: ${d.n} stratagems`);
    for (const s of d.st) {
      strats++;
      assert.ok(Number.isInteger(s[1]) && s[1] >= 0 && s[1] <= 3, `${f.id}/${d.n}/${s[0]} CP ${s[1]}`);
      assert.ok(s[2], `${f.id}/${d.n}/${s[0]} phase`);
      assert.match(s[5], /^WHEN: .+\nTARGET: .+\nEFFECT: /s, `${f.id}/${d.n}/${s[0]} WHEN/TARGET/EFFECT`);
    }
    for (const e of d.enh) { enh++; assert.ok(e[2] && e[2].length > 15, `${f.id}/${d.n}/${e[0]} text`); }
  }
  assert.ok(dets >= 330 && strats >= 1450 && enh >= 970, `${dets} ${strats} ${enh}`);
});

test("no site/markup leftovers or flattened weapon tables in rules text", () => {
  const bad = /Discover more|Become a supporter|Shop Miniatures|\(#\w+\)|\]\(#|\n(?:A|WS|BS|AP|RNG|D)\n|(?:MELEE|RANGED) WEAPONS\n/;
  for (const f of P.factions) for (const d of f.dets)
    for (const t of [d.rule[1], ...d.enh.map((e) => e[2]), ...d.st.map((s) => s[5])]) assert.doesNotMatch(t, bad, `${f.id}: ${d.n}`);
  assert.match(det("space-marines", "Assault Brethren").enh.find((e) => /Imperium/.test(e[0]))[2], /Imperium's Sword \(melee\): A 6, WS 2\+, S 7, AP -3, D 3/);
  assert.match(det("orks", "Wurrband").enh.find((e) => /Krunch/.test(e[0]))[2], /Da Krunch \(ranged\): Range 24", A 3, BS 4\+, S 5, AP -1, D 1 \[BLAST 3, HAZARDOUS, LETHAL HITS, PSYCHIC\]/);
});

test("formerly empty detachments are filled (BT, BA, DA, GSC, Iron Hands)", () => {
  assert.deepEqual(names("black-templars", "Fist of the God-Emperor"), ["angels defiant", "avowed destruction", "doctrinal flexibility"]);
  assert.deepEqual(names("black-templars", "Vow-Sworn Crusaders"), ["devout push", "dread crusaders", "for the emperor's honour!", "heresy begets retribution", "pious enmity", "spoor of the unholy"]);
  assert.equal(det("blood-angels", "Angelic Inheritors").st.length, 6);
  assert.deepEqual(names("dark-angels", "Inner Circle Task Force"), ["duty unto death", "relic teleportarium", "wrath of the lion"]);
  assert.equal(det("genestealer-cults", "Brood Brothers Auxilia").st.length, 6);
  assert.ok(det("space-marines", "Medusa's Wrath").st.length >= 3);
  // the misspelled secondary-source duplicate is gone
  assert.equal(I.factions["genestealer-cults"].dets["Brood Brother Auxilia"], undefined);
});

test("stale stratagem sets replaced (DA Wrath of the Rock, Orks Blitz/Taktikal, CD Legion of Excess)", () => {
  const w = names("dark-angels", "Wrath of the Rock");
  assert.ok(w.includes("in sacrifice, victory") && w.includes("knights of iron") && !w.includes("leonine aggression"), w.join());
  assert.equal(st("dark-angels", "Wrath of the Rock", "Inescapable Justice")[1], 1);
  assert.deepEqual(names("orks", "Blitz Brigade"), ["impending krunch", "keep it runnin'", "readied brawlers"]);
  assert.deepEqual(names("orks", "Taktikal Brigade"), ["dubious restraint", "mind mostly on the mission", "while their backs are turned"]);
  assert.ok(names("chaos-daemons", "Legion of Excess").includes("rapturous agony"));
  assert.ok(!names("chaos-daemons", "Legion of Excess").includes("thieves of pain"));
});

test("stratagem CP fixed to the app values", () => {
  for (const [fid, d, s, cp] of [["chaos-daemons", "Blood Legion", "Blood Begets Skulls", 1], ["chaos-daemons", "Blood Legion", "Fools' Flight", 2],
    ["chaos-daemons", "Legion of Excess", "Cavalcade of Blades", 1], ["chaos-daemons", "Legion of Excess", "Archagonists", 2], ["chaos-daemons", "Shadow Legion", "Shade Path", 2],
    ["chaos-space-marines", "Warpstrike Champions", "Empyric Dislocation", 1], ["chaos-space-marines", "Warpstrike Champions", "Armour of Corruption", 2],
    ["chaos-space-marines", "Creations of Bile", "Delayed Mutations", 2], ["drukhari", "Reaper's Wager", "Scintillating Tempo", 1],
    ["thousand-sons", "Rubricae Phalanx", "Infernal Fusillade", 1], ["emperors-children", "Court of the Phoenician", "Prideful Superiority", 2],
    ["space-marines", "Ceramite Sentinels", "Unyielding Might", 1], ["space-marines", "Forgefather's Seekers", "Immolation Protocols", 1]])
    assert.equal(st(fid, d, s)[1], cp, `${fid}/${d}/${s}`);
});

test("app typos corrected; bogus secondary-source stratagems gone", () => {
  assert.ok(st("space-wolves", "Saga of the Beastslayer", "Unbridled Ferocity"));
  assert.ok(st("space-marines", "Ironclad Champions", "Unstoppable Advance"));
  assert.ok(st("space-marines", "Spearpoint Task Force", "Evasive Manoeuvres"));
  assert.match(st("black-templars", "Vow-Sworn Crusaders", "Pious Enmity")[5], /CHAPLAIN/);
  assert.equal(det("adeptus-mechanicus", "Lords of the Forge").st.some((s) => /have the following ability/i.test(s[0])), false);
  assert.equal(det("deathwatch", "Black Spear Task Force").st.some((s) => /–\s*$/.test(s[0])), false);
  assert.equal(det("world-eaters", "Brazen Engines").st.some((s) => /Upgrade/i.test(s[0])), false);
});

test("enhancement eligibility follows the app text", () => {
  const ok = (fid, d, e, u) => { const F = I.factions[fid]; const en = det(fid, d).enh.find((x) => n(x[0]) === n(e)); assert.ok(en, e); return C.enhEligible(F.units[u], en, F).ok; };
  assert.equal(ok("adeptus-custodes", "Lions of the Emperor", "Admonimortis", "Shield-Captain"), true);
  assert.equal(ok("adeptus-custodes", "Lions of the Emperor", "Admonimortis", "Blade Champion"), false);
  assert.equal(ok("adeptus-custodes", "Null Maiden Vigil", "Huntress' Eye", "Shield-Captain"), false);
  assert.equal(ok("necrons", "Pantheon of Woe", "Animus Damper", "C'tan Shard of the Void Dragon"), true);
  assert.equal(ok("thousand-sons", "Rubricae Phalanx", "Stave Abominus", "Lord of Change"), false);
});

test("Black Templars Gladius (codex detachment the MFM page omits): MFM Space Marines enhancement costs", () => {
  const g = det("black-templars", "Gladius Task Force");
  assert.equal(g.src, "gs");
  assert.deepEqual(g.enh.map((e) => [e[0], e[1]]).sort(), [["Adept of the Codex", 20], ["Artificer Armour", 15], ["Laurels of Triumph", 20], ["Standard of the Emperor Ascendant", 25]]);
});

test("compiled app data: version + every MFM detachment present", () => {
  assert.ok(Number(OV.app_version) >= 972 && OV.released >= "2026-10-02");
  const all = new Set(Object.values(OV.factions).flat().map((d) => n(d.name).replace(/[^a-z0-9]/g, "")));
  for (const f of P.factions) for (const d of f.dets) assert.ok(all.has(n(d.n).replace(/[^a-z0-9]/g, "")), `${f.id}: ${d.n}`);
});
