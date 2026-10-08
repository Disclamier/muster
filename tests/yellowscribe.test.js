/* Yellowscribe (Tabletop Simulator) export: BattleScribe-style .rosz built from Muster's own profiles.
   The structure checks mirror what Yellowscribe's bin/roszParser.js reads (github.com/ThePants999/Yellowscribe). */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { JSDOM } = require("jsdom");
const C = require("../app/js/core.js");
const { fixture } = require("./fixture.js");

const DATA = path.join(__dirname, "..", "app", "data");
const hasReal = fs.existsSync(path.join(DATA, "points.json")) && fs.existsSync(path.join(DATA, "datasheets.json"));
const XmlParser = new JSDOM("").window.DOMParser;

/* a small reader doing what Yellowscribe's roszParser does: units -> models (number) -> weapons per model, abilities, keywords */
function readRoster(xml) {
  const doc = new XmlParser().parseFromString(xml, "text/xml");
  assert.equal(doc.getElementsByTagName("parsererror").length, 0, "well-formed XML");
  const root = doc.documentElement;
  const kids = (el, tag) => [...el.children].filter((c) => c.localName === tag);
  const kid = (el, tag) => kids(el, tag)[0];
  const sels = (el) => { const s = kid(el, "selections"); return s ? kids(s, "selection") : []; };
  const profs = (el) => { const p = kid(el, "profiles"); return p ? kids(p, "profile") : []; };
  const chars = (p) => Object.fromEntries(kids(kid(p, "characteristics"), "characteristic").map((c) => [c.getAttribute("name"), c.textContent]));
  const force = kid(kid(root, "forces"), "force");
  const units = [];
  for (const s of sels(force)) {
    const type = s.getAttribute("type"); if (type !== "unit" && type !== "model") continue;
    const u = { name: s.getAttribute("name"), type, models: [], abilities: [], rules: [], stats: null, cats: kids(kid(s, "categories"), "category").map((c) => c.getAttribute("name")) };
    for (const p of profs(s)) { if (p.getAttribute("typeName") === "Unit") u.stats = chars(p); if (p.getAttribute("typeName") === "Abilities") u.abilities.push(p.getAttribute("name")); }
    const r = kid(s, "rules"); if (r) u.rules = kids(r, "rule").map((x) => x.getAttribute("name"));
    const readModel = (m) => {
      const n = +m.getAttribute("number"); const model = { name: m.getAttribute("name"), n, weapons: {}, abilities: [] };
      const walk = (el) => { for (const c of sels(el)) { walk(c); for (const p of profs(c)) {
        const t = p.getAttribute("typeName");
        if (/Weapons$/.test(t)) model.weapons[p.getAttribute("name").replace(/^➤ /, "")] = +c.getAttribute("number") / n;
        if (t === "Abilities") model.abilities.push(p.getAttribute("name")); } } };
      walk(m); return model;
    };
    if (type === "model") u.models.push(readModel(s)); else for (const m of sels(s)) if (m.getAttribute("type") === "model") u.models.push(readModel(m));
    units.push(u);
  }
  return { root, units, system: root.getAttribute("gameSystemId") };
}
function unzipOne(bytes) {
  const b = Buffer.from(bytes);
  assert.equal(b.readUInt32LE(0), 0x04034b50, "local file header");
  const method = b.readUInt16LE(8), crc = b.readUInt32LE(14), size = b.readUInt32LE(18), nlen = b.readUInt16LE(26), xlen = b.readUInt16LE(28);
  const name = b.slice(30, 30 + nlen).toString("utf8");
  const data = b.slice(30 + nlen + xlen, 30 + nlen + xlen + size);
  assert.equal(method, 0); assert.equal(C.crc32(data), crc, "CRC matches");
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); assert.ok(eocd > 0, "end of central directory");
  assert.equal(b.readUInt16LE(eocd + 10), 1, "one entry");
  return { name, text: data.toString("utf8") };
}

/* fixture faction + matching synthetic datasheets */
const idx = C.indexData(fixture());
const F = idx.factions.fx;
const DS = { weapon_keywords: { "Deep Strike": "Set up in reserves." }, factions: { fx: { rules: [["Fixture Rule", "Do the **thing**."]], units: {
  Captain: { s: { M: "6\"", T: "4", SV: "3+", W: "5", LD: "6+", OC: "1" }, inv: "4+", ab: [["Leader", "Can lead Squad"], ["Big Aura (Aura)", "Within 6\""]], wa: [], cr: ["Deep Strike"], fa: ["Fixture Rule"],
    wp: [["Sword", "m", [[null, "Melee", "5", "2+", "5", "-2", "1", []]]]], ml: [["Captain", ["Sword"]]] },
  Squad: { s: { M: "6\"", T: "4", SV: "3+", W: "2", LD: "6+", OC: "2" }, ab: [["Squad Thing", "text"]], wa: [["Rocket Pod", "Rocket Pod", "Once per battle."]], cr: [], fa: ["Fixture Rule"],
    wp: [["Bolt pistol", "r", [[null, "12\"", "1", "3+", "4", "0", "1", ["Pistol"]]]], ["Bolt Rifle", "r", [[null, "24\"", "2", "3+", "4", "-1", "1", ["Assault", "Heavy"]]]],
      ["Launcher", "r", [["frag", "24\"", "D3", "3+", "4", "0", "1", ["Blast"]], ["krak", "24\"", "1", "3+", "9", "-2", "D3", []]]], ["Plasma pistol", "r", [[null, "12\"", "1", "3+", "7", "-2", "1", ["Pistol"]]]],
      ["Power fist", "m", [[null, "Melee", "3", "3+", "8", "-2", "2", []]]], ["Krak", "r", [[null, "6\"", "1", "3+", "9", "-2", "D3", []]]], ["Frag", "r", [[null, "6\"", "D3", "3+", "4", "0", "1", ["Blast"]]]]], ml: [] },
  Tank: { s: { M: "10\"", T: "10", SV: "3+", W: "12", LD: "6+", OC: "3" }, ab: [], wa: [], cr: [], fa: [], wp: [["Big Gun", "r", [[null, "48\"", "2", "3+", "10", "-2", "3", []]]], ["Heavy bolter", "r", [[null, "36\"", "3", "3+", "5", "-1", "2", ["Sustained Hits 1"]]]]], ml: [["Tank", ["Heavy bolter"]]] },
} } } };
function fxList() {
  const l = C.newList({ name: "YS <Test> & Co", faction: "fx", sub: "fx", size: "strikeforce" }); l.dets = ["Det A"];
  const sq = C.newEntry(F.units.Squad); sq.models = 10;
  const lo = C.getLoadout(F.units.Squad, {}, 10, "10 models"); lo.c.Trooper = 8; lo.c["Trooper w/ Launcher"] = 1;   // 1 sergeant + 8 + 1 launcher
  lo.p["Sergeant|Weapon 1"] = { "Power fist": 1 }; lo.p["Trooper|Grenades"] = { Krak: 6, Frag: 2 }; lo.p["*|Rocket Pod"] = { "Rocket Pod": 1 };
  sq.lo = lo;
  const cap = C.newEntry(F.units.Captain); cap.warlord = true; cap.enh = { det: "Det A", name: "Relic" }; cap.attach = sq.uid;
  const tank = C.newEntry(F.units.Tank); tank.wargear = { "Big Gun": 1 };
  l.entries.push(sq, cap, tank, { ...C.newEntry(F.units.Drone), unit: "Gone Unit" });
  F.units.Captain.ldr = ["SQUAD"];
  return l;
}

test("Yellowscribe export: 11th-ed roster XML with units, model counts, per-model weapons, abilities, rules, keywords", () => {
  const r = C.exportYellowscribe(fxList(), idx, DS, { mfm_version: "v1" });
  const R = readRoster(r.xml);
  assert.equal(R.system, "sys-352e-adc2-7639-d610", "Yellowscribe treats this id as 11th edition");
  assert.equal(R.root.getAttribute("name"), "YS <Test> & Co", "names are XML-escaped and round-trip");
  assert.deepEqual(R.units.map((u) => u.name), ["Captain", "Squad", "Tank", "Gone Unit"], "attached leader first (above), then its bodyguard");
  const [cap, sq, tank, gone] = R.units;
  // Squad: 10 models, gear per model
  assert.equal(sq.type, "unit");
  assert.equal(sq.models.reduce((n, m) => n + m.n, 0), 10);
  const sgt = sq.models.find((m) => m.name === "Sergeant");
  assert.deepEqual(sgt.weapons, { "Bolt pistol": 1, "Power fist": 1 });
  const troopers = sq.models.filter((m) => /^Trooper/.test(m.name) && !/Launcher$/.test(m.name));
  assert.equal(troopers.reduce((n, m) => n + m.n, 0), 8);
  assert.equal(troopers.reduce((n, m) => n + m.n * (m.weapons.Krak || 0), 0), 6, "6 krak grenades across the 8 troopers");
  assert.equal(troopers.reduce((n, m) => n + m.n * (m.weapons.Frag || 0), 0), 2);
  assert.ok(troopers.every((m) => m.weapons["Bolt Rifle"] === 1 && m.weapons["Bolt pistol"] === 1));
  assert.ok(troopers.some((m) => / w\/ /.test(m.name)), "split-off loadouts get a 'w/' label");
  const ln = sq.models.find((m) => m.name === "Trooper w/ Launcher");
  assert.deepEqual(Object.keys(ln.weapons).sort(), ["Bolt pistol", "Launcher - frag", "Launcher - krak"], "multi-profile weapon = one profile per mode");
  assert.equal(sq.models.reduce((n, m) => n + m.n * (m.abilities.includes("Rocket Pod") ? 1 : 0), 0), 1, "unit-level wargear ability on exactly one model");
  assert.deepEqual(sq.stats, { M: "6\"", T: "4", SV: "3+", W: "2", LD: "6+", OC: "2", InSv: "-" });
  assert.ok(sq.abilities.includes("Squad Thing")); assert.deepEqual(sq.rules, ["Fixture Rule"]);
  assert.ok(sq.cats.includes("Faction: Fixture Xenos") && sq.cats.includes("Infantry"));
  assert.ok(sq.models[0].abilities.includes("Joined by"));
  // Captain: single model, invuln, enhancement + warlord + attachment, core + faction rules
  assert.equal(cap.type, "model"); assert.equal(cap.stats.InSv, "4+");
  assert.deepEqual(cap.models[0].weapons, { Sword: 1 });
  for (const a of ["Enhancement: Relic", "Warlord", "Attached (Leader)"]) assert.ok(cap.models[0].abilities.includes(a), a);
  assert.ok(cap.abilities.includes("Big Aura (Aura)") && cap.abilities.includes("Leader"));
  assert.deepEqual(cap.rules, ["Deep Strike", "Fixture Rule"]); assert.ok(cap.cats.includes("Warlord"));
  assert.match(r.xml, /<description>Do the thing\.<\/description>/, "markdown stripped from rule text");
  // Tank: loadout from the datasheet + MFM-priced wargear picked in Muster
  assert.deepEqual(tank.models[0].weapons, { "Heavy bolter": 1, "Big Gun": 1 });
  assert.match(r.xml, /<characteristic name="Keywords" typeId="keywords">Sustained Hits 1<\/characteristic>/);
  // unit missing from the data: exported by name, flagged
  assert.equal(gone.models[0].n, 1); assert.ok(r.issues.some((x) => /Gone Unit: no datasheet/.test(x)));
});

test("Yellowscribe export: .rosz is a valid zip holding the .ros; CRC32 is standard", () => {
  assert.equal(C.crc32(Buffer.from("123456789")), 0xcbf43926);
  const r = C.exportYellowscribeRosz(fxList(), idx, DS, {});
  assert.equal(r.filename, "YS_Test_Co.rosz");
  const z = unzipOne(r.bytes);
  assert.equal(z.name, "YS_Test_Co.ros"); assert.equal(z.text, r.xml);
  // unzip -t equivalent via zlib is not possible for stored entries; the central directory offset must point at a central header
  const b = Buffer.from(r.bytes); const eocd = b.length - 22;
  assert.equal(b.readUInt32LE(b.readUInt32LE(eocd + 16)), 0x02014b50);
  assert.ok(zlib);   // (kept for future deflate support)
});

test("Yellowscribe gear resolver: exact names, counts and compound options, partial matches", () => {
  const ds = { wp: [["Heavy bolter", "r", []], ["Bolt pistol", "r", []], ["Boltgun", "r", []], ["Thunder hammer", "m", []], ["Hellstrike missile", "r", []]], wa: [["Storm shield", "Storm shield", "4+ invuln"]] };
  const names = (r) => r.weapons.map(([w, k]) => `${k}x ${w[0]}`);
  assert.deepEqual(names(C.ysResolveGear(ds, "Heavy bolter")), ["1x Heavy bolter"]);
  assert.deepEqual(names(C.ysResolveGear(ds, "2 Heavy Bolters")), ["2x Heavy bolter"]);
  assert.deepEqual(names(C.ysResolveGear(ds, "Two heavy bolters")), ["2x Heavy bolter"]);
  assert.deepEqual(names(C.ysResolveGear(ds, "Bolt Pistol and Boltgun")), ["1x Bolt pistol", "1x Boltgun"]);
  assert.deepEqual(names(C.ysResolveGear(ds, "2 Hellstrike Missiles")), ["2x Hellstrike missile"]);
  const th = C.ysResolveGear(ds, "Thunder Hammer & Storm Shield");
  assert.deepEqual(names(th), ["1x Thunder hammer"]); assert.equal(th.abilities[0][1], "Storm shield");
  const part = C.ysResolveGear(ds, "Boltgun and Mystery Device");
  assert.deepEqual(names(part), ["1x Boltgun"]); assert.deepEqual(part.unmatched, ["Mystery Device"]);
  assert.equal(C.ysResolveGear(ds, "Mystery Device"), null);
});

test("real data: World Eaters (attached leader), Space Marines, Aeldari export with full profiles and correct model counts", { skip: !hasReal }, () => {
  const P = JSON.parse(fs.readFileSync(path.join(DATA, "points.json"), "utf8"));
  const D = JSON.parse(fs.readFileSync(path.join(DATA, "datasheets.json"), "utf8"));
  const I = C.indexData(P);
  const mk = (fid, specs) => {
    const Fx = I.factions[fid]; const l = C.newList({ name: fid, faction: fid, sub: fid, size: "strikeforce" }); l.dets = [Fx.f.dets[0].n];
    for (const [n, models, attachTo] of specs) { const u = C.findUnit(Fx, n); if (!u) return null; const e = C.newEntry(u); if (models) e.models = models; if (attachTo != null) e.attach = l.entries[attachTo].uid; l.entries.push(e); }
    return l;
  };
  const cases = [
    ["world-eaters", [["Khorne Berzerkers", 10], ["Master of Executions", 0, 0], ["Angron"]]],
    ["space-marines", [["Intercessor Squad", 10], ["Captain", 0, 0], ["Redemptor Dreadnought"]]],
    ["aeldari", [["Howling Banshees", 10], ["Autarch", 0, 0], ["Guardian Defenders"], ["Crimson Hunter"]]],
  ];
  for (const [fid, specs] of cases) {
    const l = mk(fid, specs); if (!l) continue;   // data renamed a unit: nothing to check
    const r = C.exportYellowscribe(l, I, D, P);
    const R = readRoster(r.xml);
    assert.equal(R.units.length, l.entries.length, fid);
    assert.deepEqual(r.issues, [], `${fid}: ${r.issues.join("; ")}`);
    R.units.forEach((u) => {
      const e = l.entries.find((x) => x.unit === u.name);
      const total = u.models.reduce((n, m) => n + m.n, 0);
      if (e.models) assert.equal(total, e.models, `${fid} ${u.name} model count`);
      assert.ok(u.stats && u.stats.T && u.stats.T !== "-", `${u.name} has stats`);
      assert.ok(u.models.every((m) => Object.keys(m.weapons).length > 0), `${u.name}: every model has weapons`);
      assert.ok(u.cats.some((c) => c.startsWith("Faction: ")), `${u.name} faction keyword`);
    });
    const bi = R.units.findIndex((u) => u.name === specs[0][0]), li = R.units.findIndex((u) => u.name === specs[1][0]);
    assert.equal(li, bi - 1, `${fid}: leader exported right before (above) its bodyguard`);
    assert.ok(R.units[li].models[0].abilities.includes("Attached (Leader)"), `${fid} leader attached`);
    assert.ok(R.units[bi].models[0].abilities.includes("Joined by"));
  }
  // every unit of every faction exports without throwing
  for (const f of P.factions) {
    const l = C.newList({ name: "all", faction: f.id, sub: f.id, size: "onslaught" }); l.dets = f.dets.length ? [f.dets[0].n] : [];
    for (const u of f.units) l.entries.push(C.newEntry(u));
    const R = readRoster(C.exportYellowscribe(l, I, D, P).xml);
    assert.equal(R.units.length, f.units.length, f.id);
  }
});

test("app: Export dialog has 'Export for Yellowscribe' with the upload hint; it downloads a .rosz and shows the steps", async () => {
  const APP = path.join(__dirname, "..", "app");
  const read = (p) => fs.readFileSync(path.join(APP, p), "utf8");
  const { TextEncoder, TextDecoder } = require("node:util");
  const server = { version: JSON.parse(read("data/version.json")), points: JSON.parse(read("data/points.json")), datasheets: hasReal ? JSON.parse(read("data/datasheets.json")) : null, downloads: [] };
  const dom = new JSDOM(read("index.html").replace(/<script src="[^"]+"><\/script>/g, ""), { url: "http://localhost:8765/", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; w.scrollTo = () => {};
      let lastBlob = null;
      w.URL.createObjectURL = (b) => { lastBlob = b; return "blob:x"; }; w.URL.revokeObjectURL = () => {};
      w.HTMLAnchorElement.prototype.click = function () { if (this.download) server.downloads.push({ name: this.download, blob: lastBlob }); };
      w.fetch = async (url) => { const p = String(url).split("?")[0];
        const body = p.endsWith("version.json") ? server.version : p.endsWith("points.json") ? server.points : p.endsWith("datasheets.json") ? server.datasheets : null;
        return body ? { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) } : { ok: false, status: 404, json: async () => ({}) }; };
    } });
  const w = dom.window, d = w.document;
  w.eval(read("js/core.js")); w.eval(read("js/app.js"));
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  const until = async (fn) => { for (let i = 0; i < 400; i++) { const v = fn(); if (v) return v; await tick(10); } throw new Error("timeout"); };
  const click = (el) => { assert.ok(el); el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true })); };
  await until(() => d.querySelector(".lists-page"));
  const MC = w.MusterCore; const P = server.points; const we = P.factions.find((f) => f.id === "world-eaters");
  const l = MC.newList({ name: "TTS Test", faction: "world-eaters", sub: "world-eaters", size: "strikeforce" }); l.dets = [we.dets[0].n];
  l.entries.push(MC.newEntry(we.units.find((u) => u.n === "Khorne Berzerkers")), MC.newEntry(we.units.find((u) => u.n === "Master of Executions")));
  l.entries[1].attach = l.entries[0].uid; l.entries[1].warlord = true;
  w.Muster.S.lists.push(l); w.location.hash = "#/list/" + l.id; await tick(5); w.Muster.route();
  await until(() => d.querySelector(".editor"));
  if (hasReal) await until(() => w.Muster.S.ds);
  click(d.querySelector("[data-action=export]"));
  const box = d.querySelector("[data-testid=ys-box]");
  assert.ok(box); assert.match(box.textContent, /Tabletop Simulator/); assert.match(box.textContent, /yellowscribe\.link/);
  const a = box.querySelector("a"); assert.equal(a.getAttribute("href"), "https://yellowscribe.link/"); assert.equal(a.getAttribute("target"), "_blank");
  click(box.querySelector("[data-action=exp-ys]"));
  if (!hasReal) return;
  assert.equal(server.downloads.length, 1); assert.equal(server.downloads[0].name, "TTS_Test.rosz");
  assert.ok(server.downloads[0].blob.size > 1000, "roster bytes");
  const help = d.querySelector("[data-testid=ys-help]"); assert.ok(help);
  assert.match(help.textContent, /Upload/); assert.match(help.textContent, /Create Army/); assert.match(help.textContent, /TTS_Test\.rosz/);
  assert.ok(d.querySelector('.modal a.btn[href="https://yellowscribe.link/"]'), "button opens Yellowscribe");
  dom.window.close();
});
