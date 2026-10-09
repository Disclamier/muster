/* Points left/over and enhancement stat modifiers (parsed from the current enhancement text; display only). */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const C = require(path.join(__dirname, "../app/js/core.js"));
const P = require(path.join(__dirname, "../app/data/points.json"));
const ap = (x) => String(x).replace(/[’‘]/g, "'");
const enh = (fid, det, name) => {
  const d = P.factions.find((f) => f.id === fid).dets.find((x) => x.n === det); assert.ok(d, `${fid}: ${det}`);
  const e = d.enh.find((x) => ap(x[0]) === name); assert.ok(e && e[2], `${det}: ${name}`); return e[2];
};
const sig = (mods) => mods.map((m) => `${m.cond ? (m.alt ? "alt:" : "cond:") : ""}${m.scope[0]}:${m.stat}${m.op === "set" ? "=" + m.v : (m.v > 0 ? "+" : "") + m.v}${m.filter && m.filter.kind ? "/" + m.filter.kind : ""}`).sort();

test("points left / over the battle size", () => {
  assert.deepEqual(C.pointsLeft(1885, 2000), { left: 115, over: 0, text: "115 pts left", cls: "left" });
  assert.deepEqual(C.pointsLeft(2035, 2000), { left: 0, over: 35, text: "35 pts over", cls: "over" });
  assert.equal(C.pointsLeft(2000, 2000).text, "0 pts left");
  assert.equal(C.pointsLeft(100, null), null);
});

test("enhancement stat mods: unconditional characteristic + weapon changes (old and new wording)", () => {
  assert.deepEqual(sig(C.enhStatMods(enh("adeptus-custodes", "Lions of the Emperor", "Admonimortis"))), ["m:AP+1/m", "m:D+1/m", "m:S+3/m"]);
  assert.deepEqual(sig(C.enhStatMods(enh("adeptus-custodes", "Shield Host", "Auric Mantle"))), ["m:W+2"]);
  assert.deepEqual(sig(C.enhStatMods(enh("adepta-sororitas", "Bringers of Flame", "Iron Surplice of Saint Istalela"))), ["m:SV=2+"]);
  assert.deepEqual(sig(C.enhStatMods(enh("space-wolves", "Champions of Fenris", "A Giant Amongst Giants"))), ["m:S+1/m", "m:W+2"]);
  assert.deepEqual(sig(C.enhStatMods(enh("space-wolves", "Saga of the Beastslayer", "Wolf-Touched"))), ["u:M+2"]);
  assert.deepEqual(sig(C.enhStatMods(enh("drukhari", "Exhibition of Slaughter", "Hyperstimm Trafficker"))), ["u:T+1"]);
  assert.deepEqual(sig(C.enhStatMods(enh("black-templars", "Devastator Brethren", "Master-forged Firearms"))), ["m:A+1/r", "m:AP+1/r", "m:D+1/r", "m:S+1/r"]);
  assert.deepEqual(sig(C.enhStatMods(enh("genestealer-cults", "Purestrain Broodswarm", "Mark of the Star Children (Upgrade)"))), ["u:S+1/m", "u:SV=4+", "u:T+1"]);
  assert.deepEqual(sig(C.enhStatMods(enh("adeptus-mechanicus", "Data-psalm Conclave", "Mechanicus Locum"))), ["m:LD=6+"]);
  assert.deepEqual(sig(C.enhStatMods(enh("world-eaters", "Butchers of Khorne", "Gore-stained Veterans (Upgrade)"))), ["u:WS+1/m"]);
  const t = C.enhStatMods(enh("tau-empire", "Experimental Prototype Cadre", "Plasma Accelerator Rifle"));
  assert.ok(t.every((m) => m.filter.name === "Plasma Rifle" && m.pick), "only the selected Plasma Rifle");
});

test("enhancement stat mods: conditional ones are marked with their condition; 'instead' variants are alternatives", () => {
  const md = C.enhStatMods(enh("grey-knights", "Warpbane Task Force", "Mandulian Reliquary"));
  assert.deepEqual(sig(md), ["cond:m:OC+3"]); assert.match(md[0].cond, /not Battle-shocked/);
  assert.deepEqual(sig(C.enhStatMods(enh("aeldari", "Aspect Host", "Strategic Savant"))), ["cond:u:OC+1"]);
  assert.deepEqual(sig(C.enhStatMods(enh("orks", "War Horde", "Headwoppa's Killchoppa"))), ["cond:m:AP+1/m"]);
  assert.deepEqual(sig(C.enhStatMods(enh("adeptus-custodes", "Null Maiden Vigil", "Raptor Blade"))), ["m:A+1/m", "m:D+1/m", "m:S+1/m"]);
  assert.deepEqual(sig(C.enhStatMods(enh("space-marines", "Spearpoint Task Force", "Spearpoint Paragon"))), ["alt:m:AP+2/m", "alt:m:S+2/m", "m:AP+1/m", "m:S+1/m"]);
  assert.ok(C.enhStatMods(enh("adepta-sororitas", "Sanctified Orators", "Hagiomnifex (Upgrade)")).every((m) => m.cond), "choose-one ability = conditional");
});

test("enhancement stat mods: no false positives (enemy/other units, attacks against the bearer, hit rolls, ability ranges)", () => {
  for (const [f, d, n] of [["adeptus-mechanicus", "Data-psalm Conclave", "Mantle of the Gnosticarch"], ["tyranids", "Synaptic Nexus", "The Dirgeheart of Kharis"],
    ["tau-empire", "Auxiliary Cadre", "Admired Leader"], ["leagues-of-votann", "Hearthband", "Bastion Shield"], ["world-eaters", "Cult of Blood", "Chosen of the Blood God"], ["chaos-space-marines", "Cult of the Arkifane", "Crown of Worms"],
    ["chaos-daemons", "Plague Legion", "Font of Spores"], ["emperors-children", "Mercurial Host", "Intoxicating Musk"], ["astra-militarum", "Steel Hammer", "Engine Speaker"]])
    assert.deepEqual(C.enhStatMods(enh(f, d, n)), [], n);
});

test("applying mods to characteristic values", () => {
  const a = (stat, v, m) => C.applyStatMod(stat, v, Object.assign({ op: "add" }, m));
  assert.equal(a("D", "2", { v: 1 }), "3"); assert.equal(a("D", "D6", { v: 1 }), "D6+1"); assert.equal(a("D", "D3+1", { v: 1 }), "D3+2");
  assert.equal(a("AP", "-1", { v: 1 }), "-2"); assert.equal(a("AP", "0", { v: 1 }), "-1");
  assert.equal(a("WS", "3+", { v: 1 }), "2+"); assert.equal(a("WS", "2+", { v: 1 }), "2+");
  assert.equal(a("M", '6"', { v: 2 }), '8"'); assert.equal(a("RANGE", '24"', { v: 6 }), '30"'); assert.equal(a("RANGE", "Melee", { v: 6 }), null);
  assert.equal(a("LD", "6+", { v: 1 }), "5+");
  assert.equal(C.applyStatMod("SV", "3+", { op: "set", v: "2+" }), "2+");
  assert.equal(C.applyStatMod("INV", "4+", { op: "set", v: "5+" }), null, "a worse invulnerable save is not an improvement");
  assert.equal(C.applyStatMod("INV", "-", { op: "set", v: "5+" }), "5+");
});

test("count: stat-modifying enhancements across all armies", () => {
  const seen = new Set(); let n = 0, cond = 0;
  for (const f of P.factions) for (const d of f.dets) for (const e of d.enh) {
    if (!e[2] || seen.has(e[2])) continue; seen.add(e[2]);
    const m = C.enhStatMods(e[2]); if (m.length) { n++; if (m.every((x) => x.cond)) cond++; }
  }
  assert.ok(n >= 140 && cond >= 30, `${n} stat-modifying (${cond} only conditional)`);
});
