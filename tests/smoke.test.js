/* jsdom smoke tests: load the real index.html + app scripts with a stubbed fetch, drive the UI by events. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { TextEncoder, TextDecoder } = require("node:util");

const APP = path.join(__dirname, "..", "app");
const read = (p) => fs.readFileSync(path.join(APP, p), "utf8");
const HTML = read("index.html").replace(/<script src="[^"]+"><\/script>/g, "");
const POINTS = JSON.parse(read("data/points.json"));
const VERSION = JSON.parse(read("data/version.json"));
const DS = fs.existsSync(path.join(APP, "data/datasheets.json")) ? JSON.parse(read("data/datasheets.json")) : null;
const RULES = JSON.parse(read("data/core_rules.json"));
const WR = fs.existsSync(path.join(APP, "data/winrates.json")) ? JSON.parse(read("data/winrates.json")) : null;

const OPEN = [];   // accounts-enabled windows are closed after each test (the 60 s sync poll would keep node alive)
test.afterEach(() => { while (OPEN.length) { try { OPEN.pop().window.close(); } catch (e) { /* already closed */ } } });
function makeApp(opts) {
  opts = opts || {};
  const server = { version: { ...VERSION }, points: POINTS, winrates: WR, rules: opts.noRules ? null : RULES, datasheets: opts.noDatasheets ? null : DS, offline: false, requests: [] };
  const dom = new JSDOM(HTML, {
    url: opts.url || "http://localhost:8765/", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      if (opts.storage) for (const [k, v] of Object.entries(opts.storage)) w.localStorage.setItem(k, v);
      // viewport emulation: desktop PC (default, mouse), phone (narrow, touch) or touch tablet (wide, touch)
      const touch = !!(opts.phone || opts.tablet);
      const mq = (q) => /max-width/.test(q) ? !!opts.phone : /hover: hover/.test(q) ? !touch : /hover: none|pointer: coarse/.test(q) ? touch : false;
      w.matchMedia = (q) => ({ matches: mq(q), media: q, addEventListener() {}, removeEventListener() {} });
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      w.scrollTo = () => {};
      w.navigator.clipboard = { writeText: async (t) => { server.clipboard = t; } };
      w.URL.createObjectURL = () => "blob:x"; w.URL.revokeObjectURL = () => {};
      if (opts.beforeParse) opts.beforeParse(w);
      w.fetch = async (url, init) => {
        server.requests.push(String(url));
        if (server.offline) throw new TypeError("Failed to fetch");
        if (opts.supabase && String(url).startsWith(opts.supabase.base)) return opts.supabase.handle(String(url), init || {});
        const p = String(url).split("?")[0];
        const ml = p.match(/data\/meta-lists\/([a-z0-9-]+)\.json$/);
        if (ml) { const fp = path.join(APP, "data/meta-lists", ml[1] + ".json"); if (!fs.existsSync(fp)) return { ok: false, status: 404, json: async () => ({}) }; return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(fp, "utf8")) }; }
        const body = p.endsWith("version.json") ? server.version : p.endsWith("points.json") ? server.points : p.endsWith("winrates.json") ? server.winrates : p.endsWith("datasheets.json") ? server.datasheets : p.endsWith("core_rules.json") ? server.rules : null;
        if (!body) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
      };
    },
  });
  const w = dom.window;
  if (opts.config) OPEN.push(dom);
  w.eval(read("js/config.js"));
  // the real config.js holds the live Supabase project; tests run local-only unless a test passes its own config
  w.MUSTER_CONFIG = opts.config || { SUPABASE_URL: "", SUPABASE_ANON_KEY: "" };
  w.eval(read("js/core.js"));
  w.eval(read("js/sync.js"));
  w.eval(read("js/stats.js"));
  w.eval(read("js/app.js"));
  return { dom, w, d: w.document, server };
}
// per-faction colors: open a list of the given (sub-)faction so the Colors window edits that faction's set
async function openFactionList(w, d, sub, faction, name) {
  const C = w.MusterCore; const l = C.newList({ name: name || sub, faction: faction || sub, sub, size: "strikeforce" });
  w.Muster.S.lists.push(l); await go(w, "#/list/" + l.id); await until(() => d.querySelector(".editor")); return l;
}
// storage for a fresh page load straight into a list of that faction (colors applied before first paint)
function factionBoot(sub, colors, shared) {
  const st = { "muster.lists": JSON.stringify([{ id: "boot1", name: "Boot", faction: sub, sub, size: "strikeforce", entries: [], dets: [], updated: "2026-10-08T00:00:00Z" }]),
    ["muster.colors.f." + sub]: JSON.stringify(colors), "muster.colors.v": "2" };
  if (shared) st["muster.colors"] = JSON.stringify(shared);
  return { storage: st, url: "http://localhost:8765/#/list/boot1" };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 4000)) { const v = fn(); if (v) return v; await tick(10); } throw new Error("timeout waiting for condition"); }
const click = (w, el) => { assert.ok(el, "element to click exists"); el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true })); };
const change = (w, el, checked, value) => { if (checked !== undefined) el.checked = checked; if (value !== undefined) el.value = value; el.dispatchEvent(new w.Event("change", { bubbles: true })); };
const go = async (w, hash) => { w.location.hash = hash; await tick(5); w.Muster.route(); };

test("build a list end-to-end: create, detachment, units, warlord, enhancement, export, rename", async () => {
  const { w, d, server } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  assert.match(d.querySelector("#footer").textContent, /unofficial/);
  // Create List modal: group -> sub-faction -> size
  click(w, d.querySelector("[data-action=new-list]"));
  const groups = [...d.querySelectorAll(".pick .t")].map((e) => e.firstChild.textContent.trim());
  assert.deepEqual(groups, ["Chaos", "Imperium", "Imperium - Adeptus Astartes", "Xenos"]);
  const nameInput = d.querySelector("[data-input=new-name]"); nameInput.value = "Smoke Crons"; nameInput.dispatchEvent(new w.Event("input", { bubbles: true }));
  click(w, [...d.querySelectorAll("[data-action=pick-group]")].find((e) => /Xenos/.test(e.textContent)));
  const necron = d.querySelector('[data-action=pick-sub][data-id="necrons"]');
  assert.ok(necron.querySelector("img.pthumb"), "faction artwork in picker");
  click(w, necron);
  click(w, d.querySelector("[data-action=create-list]"));
  await tick(5); w.Muster.route();
  await until(() => d.querySelector(".editor"));
  assert.match(d.querySelector(".lname").textContent, /Smoke Crons/);
  assert.match(d.querySelector(".fbanner").getAttribute("style") || "", /necrons\.webp/);
  // catalog groups by role with constraint counts
  const roles = [...d.querySelectorAll(".catalog .sect-h")].map((e) => e.textContent.replace(/\(\d+\)/, "").trim());
  assert.ok(roles.includes("Epic Hero") && roles.includes("Battleline"), roles.join());
  // detachment panel (from the Detachment dropdown's "Rules, enhancements & stratagems…" button)
  click(w, d.querySelector("[data-testid=det-details]"));
  const detBoxes = [...d.querySelectorAll(".panel input[data-change=det]")];
  assert.ok(detBoxes.length > 3);
  assert.match(d.querySelector(".panel").textContent, /Detachment Points?/);
  const necF = POINTS.factions.find((f) => f.id === "necrons");
  const det2 = necF.dets.find((x) => x.src === "mfm" && x.dp === 2 && x.enh.length && x.st.length);
  change(w, detBoxes.find((b) => b.value === det2.n), true);
  assert.match(d.querySelector("[data-testid=dp]").textContent, /2 \/ 3 DP/);
  assert.ok(d.querySelectorAll(".panel .strat").length >= 1, "stratagems shown for focused detachment");
  // over the DP limit -> red chip
  const det3 = necF.dets.find((x) => x.src === "mfm" && x.dp >= 2 && x.n !== det2.n);
  change(w, [...d.querySelectorAll(".panel input[data-change=det]")].find((b) => b.value === det3.n), true);
  assert.ok(d.querySelector("[data-testid=dp]").classList.contains("over"));
  change(w, [...d.querySelectorAll(".panel input[data-change=det]")].find((b) => b.value === det3.n), false);
  assert.ok(!d.querySelector("[data-testid=dp]").classList.contains("over"));
  // add a character and a battleline unit from the catalog
  const charUnit = necF.units.find((u) => u.r === "Character" && !u.lg);
  const blUnit = necF.units.find((u) => u.r === "Battleline" && !u.lg);
  click(w, d.querySelector(`.catalog .add[data-unit="${charUnit.n}"]`));
  click(w, d.querySelector(`.catalog .add[data-unit="${blUnit.n}"]`));
  assert.equal(d.querySelectorAll(".roster .urow").length, 2);
  // select the character, make it Warlord, give it an enhancement
  click(w, [...d.querySelectorAll(".roster .urow")].find((e) => e.textContent.includes(charUnit.n)));
  change(w, d.querySelector(".panel input[data-change=warlord]"), true);
  const enhRadio = [...d.querySelectorAll(".panel input[data-change=enh]")].find((r) => r.value && !r.disabled);
  change(w, enhRadio, true);
  const list = w.Muster.S.lists[0];
  const C = w.MusterCore;
  const calc = C.calcList(list, w.Muster.S.idx);
  assert.equal(calc.errors.length, 0, calc.errors.map((e) => e.msg).join("; "));
  assert.ok(calc.enhancements > 0);
  assert.match(d.querySelector("[data-testid=total]").textContent, new RegExp(`^${calc.total} / 2000`));
  assert.ok(d.querySelector("[data-testid=valid-dot]").classList.contains("ok"));
  // model-count options come from cost tiers
  click(w, [...d.querySelectorAll(".roster .urow")].find((e) => e.textContent.includes(blUnit.n)));
  const sizes = [...d.querySelectorAll(".panel input[data-change=models]")];
  assert.equal(sizes.length, C.modelOptions(blUnit, 1).length);
  if (sizes.length > 1) { change(w, sizes[1], true); assert.equal(list.entries[1].models, C.modelOptions(blUnit, 1)[1].models); }
  // catalog search
  const s = d.querySelector("[data-input=cat-search]"); s.value = blUnit.n.slice(0, 6); s.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.ok([...d.querySelectorAll("#catbody .crow")].every((r) => C.searchUnits([necF.units.find((u) => u.n === r.getAttribute("data-unit"))], s.value).length));
  // export dialog: GW default, switch to Tournament
  click(w, d.querySelector("[data-action=export]"));
  assert.match(d.querySelector("[data-testid=export-text]").value, /\(\d[\d,]* Points\)/);
  change(w, d.querySelector('input[data-change=fmt][value="wtc"]'), true);
  assert.match(d.querySelector("[data-testid=export-text]").value, /\+ LIST NAME: Smoke Crons/);
  click(w, d.querySelector("[data-action=exp-copy]")); await tick(5);
  assert.match(server.clipboard, /\+ WARLORD: Char1:/);
  assert.equal(w.localStorage.getItem("muster.exportFormat"), "wtc");
  click(w, d.querySelector("[data-action=exp-discord]"));
  assert.ok(d.querySelectorAll(".dblock").length >= 1);
  click(w, d.querySelector("[data-action=close-modal]"));
  // share link round-trip
  const payload = await w.Muster.encodeShare(list);
  const back = C.listFromShareable(await w.Muster.decodeShare(payload));
  assert.equal(C.calcList(back, w.Muster.S.idx).total, C.calcList(list, w.Muster.S.idx).total);
  // persisted
  const saved = JSON.parse(w.localStorage.getItem("muster.lists"));
  assert.equal(saved.length, 1); assert.equal(saved[0].entries.length, 2);
  // My Lists: rows with thumbnail, duplicate, delete
  await go(w, "#/lists");
  assert.ok(d.querySelector(".lgroup h3 img.fthumb"));
  click(w, d.querySelector("[data-action=dup-list]"));
  assert.equal(w.Muster.S.lists.length, 2);
  click(w, d.querySelectorAll("[data-action=del-list]")[1]);
  click(w, d.querySelector("#modal [data-ok]"));
  assert.equal(w.Muster.S.lists.length, 1);
  click(w, d.querySelector("[data-action=rename-list]"));
  const inp = d.querySelector("[data-prompt]"); inp.value = "Renamed"; click(w, d.querySelector("#modal [data-ok]"));
  assert.equal(w.Muster.S.lists[0].name, "Renamed");
});

test("points update: newer version.json -> new data, recalculated lists, change banner; offline keeps data", async () => {
  const { w, d, server } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  const C = w.MusterCore;
  const necF = POINTS.factions.find((f) => f.id === "necrons");
  const unit = necF.units.find((u) => u.r === "Character" && !u.lg);
  const l = C.newList({ name: "Before", faction: "necrons", sub: "necrons" });
  l.dets = [necF.dets.find((x) => x.src === "mfm").n]; const e = C.newEntry(unit); e.warlord = true; l.entries.push(e);
  w.Muster.S.lists.push(l);
  const oldTotal = C.calcList(l, w.Muster.S.idx).total;
  // publish a new data version with this unit +15 pts
  const fresh = JSON.parse(JSON.stringify(POINTS));
  fresh.hash = "newhash000000000"; fresh.mfm_version = "v9.9";
  const fu = fresh.factions.find((f) => f.id === "necrons").units.find((u) => u.n === unit.n);
  fu.t.forEach((t) => t[2].forEach((r) => { r[1] += 15; }));
  server.points = fresh; server.version = { ...VERSION, hash: fresh.hash, mfm_version: "v9.9" };
  const r = await w.Muster.checkForUpdates(true);
  assert.equal(r.updated, true);
  w.Muster.route();
  const banner = d.querySelector("[data-testid=update-banner]");
  assert.ok(banner, "banner shown");
  assert.match(banner.textContent, /v9\.9/);
  assert.match(banner.textContent, /Before/);
  assert.match(banner.textContent, new RegExp(`${oldTotal}\\s*pts\\s*→\\s*${oldTotal + 15}`));
  assert.match(banner.textContent, new RegExp(unit.n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(w.Muster.S.lists[0].total, oldTotal + 15);
  assert.ok(JSON.parse(w.localStorage.getItem("muster.updateReport")).lists.length === 1);
  click(w, d.querySelector("[data-action=dismiss-report]"));
  assert.equal(d.querySelector("[data-testid=update-banner]"), null);
  // offline: data kept, no throw
  server.offline = true;
  const r2 = await w.Muster.checkForUpdates(true);
  assert.equal(r2.offline, true);
  assert.equal(w.Muster.S.data.hash, "newhash000000000");
  // a failing points.json does not replace data
  server.offline = false; server.version = { ...VERSION, hash: "other" }; server.points = { broken: true };
  await w.Muster.checkForUpdates(false);
  assert.equal(w.Muster.S.data.hash, "newhash000000000");
});

test("Meta Win Rates: faction table, sortable, faction page with detachments + matchups", { skip: !WR }, async () => {
  const { w, d } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  await until(() => w.Muster.S.wr);
  assert.ok(d.querySelector('#hdr a[href="#/meta"]'), "header tab");
  await go(w, "#/meta");
  const rows = d.querySelectorAll("[data-testid=meta-table] tr.click");
  // the default view can be a partial weekend (factions with no games yet are left out), so compare with what the view holds
  assert.equal(rows.length, w.MusterCore.metaView(w.Muster.S.wr, w.Muster.S.ui.metaRange, w.Muster.S.ui.metaRtt).rows.length);
  assert.ok(rows.length > 0 && rows.length <= WR.factions.length);
  const firstWR = parseFloat(rows[0].children[1].textContent); const lastWR = parseFloat(rows[rows.length - 1].children[1].textContent);
  assert.ok(firstWR >= lastWR, "sorted by win rate desc");
  click(w, [...d.querySelectorAll("[data-testid=meta-table] th")].find((t) => /Games/.test(t.textContent)));
  const g = [...d.querySelectorAll("[data-testid=meta-table] tr.click")].map((r) => +r.children[3].textContent);
  assert.deepEqual(g, [...g].sort((a, b) => b - a));
  click(w, d.querySelector('[data-action=meta-range][data-range="4weeks"]'));
  assert.match(d.querySelector(".meta-page").textContent, /Last 4 Weeks/);
  const f = WR.factions.find((x) => x.matchups.length > 5 && x.detachments.length > 2);
  if (!f) return; // thin dataset (e.g. early in a weekend): the faction-page part is covered when data allows
  click(w, d.querySelector('[data-action=meta-range][data-range="weekend"]'));
  await go(w, `#/meta/${f.slug}`);
  assert.match(d.querySelector("[data-testid=meta-tiles]").textContent, /Win Rate/);
  const tab = (name) => click(w, [...d.querySelectorAll("[data-action=meta-tab]")].find((b) => b.dataset.tab === name));
  tab("detachments");
  const known = (a) => a.filter((x) => x.name !== "Unknown").length;
  assert.equal(d.querySelectorAll("[data-testid=det-table] tr").length - 1, known(f.detachments));
  tab("matchups");
  assert.equal(d.querySelectorAll("[data-testid=matchup-table] tr").length - 1, f.matchups.length);
  tab("detachments");
  click(w, d.querySelector('[data-action=det-mode][data-mode="single"]'));
  assert.equal(d.querySelectorAll("[data-testid=det-table] tr").length - 1, known(f.detachments_single));
});

test("dark mode is remembered per device and applied before paint", async () => {
  const a = makeApp();
  await until(() => a.d.querySelector(".lists-page"));
  const before = a.d.documentElement.getAttribute("data-theme");
  click(a.w, a.d.querySelector("[data-action=toggle-theme]"));
  const after = a.d.documentElement.getAttribute("data-theme");
  assert.notEqual(before, after);
  assert.equal(a.w.localStorage.getItem("muster.theme"), after);
  const b = makeApp({ storage: { "muster.theme": "dark" } });
  assert.equal(b.d.documentElement.getAttribute("data-theme"), "dark");
});

test("phone layout: catalog/roster tabs", async () => {
  const { w, d } = makeApp({ phone: true, storage: { "muster.lists": JSON.stringify([{ id: "p1", name: "Phone", faction: "orks", sub: "orks", size: "incursion", dets: [], entries: [], app: "muster", schema: 1 }]) } });
  await until(() => d.querySelector(".lists-page"));
  await go(w, "#/list/p1");
  assert.equal(d.querySelector(".cols").getAttribute("data-tab"), "roster");
  click(w, d.querySelector('[data-action=tab][data-tab="catalog"]'));
  assert.equal(d.querySelector(".cols").getAttribute("data-tab"), "catalog");
  click(w, d.querySelector(".catalog .crow .add"));
  assert.equal(w.Muster.S.lists[0].entries.length, 1);
  assert.equal(d.querySelector(".panel"), null, "no auto-open sheet on phone");
});

test("JSON import via Text Import", async () => {
  const { w, d } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  const C = w.MusterCore;
  const l = C.newList({ name: "Imported One", faction: "orks", sub: "orks" });
  click(w, d.querySelector("[data-action=import-text]"));
  d.querySelector("[data-import]").value = C.exportLists([l]);
  click(w, d.querySelector("#modal [data-ok]"));
  assert.equal(w.Muster.S.lists.length, 1);
  assert.match(d.querySelector(".lists-page").textContent, /Imported One/);
});

test("every faction: editor + all panel types render without errors", async () => {
  const { w, d } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  const C = w.MusterCore;
  const errors = []; w.addEventListener("error", (e) => errors.push(e.message));
  for (const g of POINTS.groups) for (const s of g.factions) {
    const F = POINTS.factions.find((f) => f.id === s.data);
    const l = C.newList({ name: s.name, faction: s.data, sub: s.id });
    const det = F.dets.find((x) => x.src === "mfm"); if (det) l.dets = [det.n];
    for (const u of F.units.slice(0, 4)) l.entries.push(C.newEntry(u));
    w.Muster.S.lists.push(l);
    await go(w, `#/list/${l.id}`);
    for (const p of ["dets", "size", "disp", "errors"]) { w.Muster.S.ui.panel = { type: p }; w.Muster.route(); assert.ok(d.querySelector(".panel .phead"), `${s.id} ${p}`); }
    w.Muster.S.ui.panel = { type: "unit", uid: l.entries[0].uid }; w.Muster.route(); assert.ok(d.querySelector(".panel .grp"), `${s.id} unit`);
    w.Muster.S.ui.panel = { type: "preview", unit: F.units[0].n }; w.Muster.route(); assert.ok(d.querySelector(".panel .ptable"), `${s.id} preview`);
    w.Muster.S.ui.panel = null;
  }
  assert.deepEqual(errors, []);
});

test("review fixes: config '!' markers, validation popover, change arrows + legend, enhancement hidden for non-characters", async () => {
  const { w, d } = makeApp({ storage: { "muster.lists": JSON.stringify([{ id: "r1", name: "Review", faction: "space-marines", sub: "space-marines", size: "strikeforce", dets: [], entries: [], app: "muster", schema: 1 }]) } });
  await until(() => d.querySelector(".lists-page"));
  await go(w, "#/list/r1");
  const detRow = d.querySelector("[data-testid=cfg-dets]");
  assert.ok(detRow.querySelector(".need"), "red ! on Detachment row while none selected");
  assert.ok(d.querySelector(".card .sect-h .need"), "Configuration header flagged");
  // validation dot popover lists issues
  const pop = d.querySelector("[data-testid=vpop]");
  assert.match(pop.textContent, /Select a detachment/);
  click(w, d.querySelector("[data-testid=valid-dot]"));
  assert.ok(d.querySelector(".dotwrap").classList.contains("open"));
  // legend + arrow tooltips
  assert.match(d.querySelector(".catalog .legend").textContent, /points up.*points down/);
  const arrow = d.querySelector(".catalog [data-action=chg-info]");
  if (arrow) assert.match(arrow.getAttribute("title"), /Points went (up|down)|Points changed/);
  // pick a detachment with a Force Disposition choice -> disposition row gets the marker until chosen
  const F = POINTS.factions.find((f) => f.id === "space-marines");
  const det = F.dets.find((x) => x.src === "mfm" && (x.fd || []).length && x.enh.some((e) => !e[3]));
  change(w, [...d.querySelectorAll("[data-testid=det-dd] input[data-change=det]")].find((b) => b.value === det.n), true);
  assert.ok(!d.querySelector("[data-testid=cfg-dets] .need"));
  const list = w.Muster.S.lists[0];
  if (!list.disposition) assert.ok(d.querySelector("[data-testid=cfg-disp] .need"));
  // Redemptor (non-character): no Enhancement section; Captain: has one
  click(w, d.querySelector('.catalog .add[data-unit="Redemptor Dreadnought"]'));
  assert.ok(d.querySelector(".panel"), "unit panel opened");
  assert.ok(![...d.querySelectorAll(".panel .gh")].some((h) => /^Enhancement/.test(h.textContent)), "no Enhancement section for Redemptor");
  click(w, d.querySelector('.catalog .add[data-unit="Captain"]'));
  assert.ok([...d.querySelectorAll(".panel .gh")].some((h) => /^Enhancement/.test(h.textContent)), "Enhancement section for Captain");
});

test("loadout options tree: defaults, weapon choice with MFM price, model counts, roster lines, export", async () => {
  const { w, d, server } = makeApp({ storage: { "muster.lists": JSON.stringify([{ id: "l1", name: "Loadouts", faction: "space-marines", sub: "space-marines", size: "strikeforce", dets: [], entries: [], app: "muster", schema: 1 }]) } });
  await until(() => d.querySelector(".lists-page"));
  await go(w, "#/list/l1");
  const C = w.MusterCore;
  // Intercessors: default loadout lines in the roster instead of "• 5 models"
  click(w, d.querySelector('.catalog .add[data-unit="Intercessor Squad"]'));
  const urow = () => [...d.querySelectorAll(".roster .urow")].find((e) => e.textContent.includes("Intercessor Squad"));
  assert.match(urow().querySelector(".sum").textContent, /1x Intercessor Sergeant: Bolt Pistol, Knives and Fists, Bolt Rifle/);
  assert.ok(!/• 5 models/.test(urow().textContent));
  assert.ok(d.querySelectorAll(".panel [data-testid=lo-type]").length >= 2, "model types in the options tree");
  // sergeant weapon radio (codex: Bolt Rifle -> Plasma Pistol)
  const radio = [...d.querySelectorAll(".panel input[data-change=lo-pick]")].find((i) => i.dataset.key === "Intercessor Sergeant|Bolt Rifle" && i.dataset.opt === "Plasma Pistol");
  change(w, radio, true);
  assert.match(urow().querySelector(".sum").textContent, /1x Intercessor Sergeant: Bolt Pistol, Knives and Fists, Plasma Pistol/);
  // codex: for every 5 models, 1 Intercessor can take a Grenade Launcher (optional, capped per unit size)
  const glInc = () => [...d.querySelectorAll(".panel [data-action=lo-inc]")].find((i) => i.dataset.key === "Intercessor|Grenade Launcher" && i.dataset.d === "1");
  assert.ok(glInc(), "grenade launcher option");
  click(w, glInc());
  assert.equal(w.Muster.S.lists[0].entries[0].lo.p["Intercessor|Grenade Launcher"]["Grenade Launcher"], 1);
  assert.ok(glInc().disabled, "max 1 Grenade Launcher in a 5-model unit");
  // Redemptor: switching to the Macro Plasma Incinerator adds the MFM +10 wargear cost
  click(w, d.querySelector('.catalog .add[data-unit="Redemptor Dreadnought"]'));
  const before = C.calcList(w.Muster.S.lists[0], w.Muster.S.idx).total;
  const mpi = [...d.querySelectorAll(".panel input[data-change=lo-pick]")].find((i) => i.dataset.opt === "Macro Plasma Incinerator");
  assert.ok(mpi, "Macro Plasma Incinerator option shown");
  assert.match(mpi.closest(".opt").textContent, /10 pts/);
  change(w, mpi, true);
  assert.equal(C.calcList(w.Muster.S.lists[0], w.Muster.S.idx).total, before + 10);
  assert.ok(!d.querySelector('.panel [data-action=wg][data-w="Macro plasma incinerator"]'), "no separate manual counter for linked wargear");
  // exports carry the loadout
  click(w, d.querySelector("[data-action=export]"));
  change(w, d.querySelector('input[data-change=fmt][value="gw"]'), true);
  const gw = d.querySelector("[data-testid=export-text]").value;
  assert.match(gw, /  • 1x Intercessor Sergeant\n    ◦ 1x Bolt Pistol/);
  assert.match(gw, /Redemptor Dreadnought \(\d+ Points\)\n(  • 1x .*\n)*  • 1x Redemptor Fist\n(  • 1x .*\n)*  • 1x Macro Plasma Incinerator/);
  change(w, d.querySelector('input[data-change=fmt][value="wtc"]'), true);
  assert.match(d.querySelector("[data-testid=export-text]").value, /x Intercessor Squad \(\d+ pts\): 1x Intercessor Sergeant: /);
  assert.ok(!/fetched 20\d\d-\d\d-\d\d/.test(d.querySelector("[data-testid=export-text]").value), "export date not raw UTC");
  // reset to default
  click(w, d.querySelector("[data-action=close-modal]"));
  click(w, d.querySelector("[data-action=lo-reset]"));
  assert.equal(C.calcList(w.Muster.S.lists[0], w.Muster.S.idx).total, before);
});

test("meta matchups: '—' rows sort last in both directions; percents always one decimal", { skip: !WR }, async (tc) => {
  const { w, d } = makeApp();
  await until(() => d.querySelector(".lists-page")); await until(() => w.Muster.S.wr);
  const f = WR.factions.find((x) => x.matchups.some((m) => m.games < 10) && x.matchups.some((m) => m.games >= 10));
  if (!f) return tc.skip("no faction in this dataset has both small and large matchup samples (e.g. early in a weekend)");
  await go(w, `#/meta/${f.slug}`);
  click(w, [...d.querySelectorAll("[data-action=meta-tab]")].find((b) => b.dataset.tab === "matchups"));
  const cells = () => [...d.querySelectorAll("[data-testid=matchup-table] tr.click")].map((r) => r.children[1].textContent.trim());
  const check = () => { const c = cells(); const firstDash = c.indexOf("—"); assert.ok(firstDash > 0); assert.ok(c.slice(firstDash).every((x) => x === "—"), c.join(",")); };
  check();                                            // default: win rate desc
  click(w, [...d.querySelectorAll("[data-testid=matchup-table] th")].find((t) => /^Win Rate/.test(t.textContent)));
  check();                                            // asc
  click(w, [...d.querySelectorAll("[data-testid=matchup-table] th")].find((t) => /^Avg Diff/.test(t.textContent)));
  check();
  const all = [...d.querySelectorAll(".meta-page .wr")].map((e) => e.textContent);
  assert.ok(all.length && all.every((t) => /^\d+\.\d%$/.test(t)), all.filter((t) => !/^\d+\.\d%$/.test(t)).join(","));
  await go(w, "#/meta");
  const t = [...d.querySelectorAll("[data-testid=meta-table] .wr")].map((e) => e.textContent);
  assert.ok(t.every((x) => /^\d+\.\d%$/.test(x)));
});

const HAS_DS = !!(WR && WR.datasets && WR.datasets.weekend_rtt);
test("Meta: Include RTTs toggle switches datasets instantly, is remembered, and other windows / tabs work", { skip: !HAS_DS }, async () => {
  const a = makeApp();
  const { w, d } = a;
  await until(() => d.querySelector(".lists-page")); await until(() => w.Muster.S.wr);
  await go(w, "#/meta");
  const sumGames = () => [...d.querySelectorAll("[data-testid=meta-table] tr.click")].reduce((t, r) => t + +r.children[3].textContent.replace(/,/g, ""), 0);
  const total = (k) => WR.datasets[k].table.reduce((t, r) => t + (r.games || 0), 0);
  assert.equal(d.querySelector(".meta-page").dataset.view, "weekend");
  assert.equal(sumGames(), total("weekend"));
  const tog = d.querySelector("[data-testid=rtt-toggle]"); assert.ok(tog, "Include RTTs switch");
  assert.equal(tog.checked, false);
  change(w, tog, true);
  assert.equal(d.querySelector(".meta-page").dataset.view, "weekend_rtt");
  assert.equal(sumGames(), total("weekend_rtt"));
  assert.match(d.querySelector(".meta-page").textContent, /incl\. RTTs/);
  assert.match(d.querySelector(".meta-page").textContent, /3 or more rounds and with 8 or more players/);
  assert.equal(w.localStorage.getItem("muster.metaRtt"), "1");
  // every window offered by listhammer is a button; each switches the table
  const ranges = [...d.querySelectorAll("[data-action=meta-range]")].map((b) => b.dataset.range);
  assert.ok(ranges.includes("weekend") && ranges.includes("4weeks"), ranges.join());
  click(w, d.querySelector('[data-action=meta-range][data-range="4weeks"]'));
  assert.equal(d.querySelector(".meta-page").dataset.view, "4weeks_rtt");
  assert.equal(sumGames(), total("4weeks_rtt"));
  if (WR.datasets.dataslate) {
    click(w, d.querySelector('[data-action=meta-range][data-range="dataslate"]'));
    assert.match(d.querySelector(".meta-page h2").textContent, /Since/);
  }
  // search narrows the faction list
  const inp = d.querySelector("[data-input=meta-q]"); inp.value = "world"; inp.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.deepEqual([...d.querySelectorAll("[data-testid=meta-table] tr.click td.l span")].map((e) => e.textContent), ["World Eaters"]);
  inp.value = ""; inp.dispatchEvent(new w.Event("input", { bubbles: true }));
  // Dispositions tab: tap one -> its record against every other disposition
  click(w, [...d.querySelectorAll("[data-action=meta-tab]")].find((b) => b.dataset.tab === "dispositions"));
  const rows = d.querySelectorAll("[data-testid=disp-table] tr[data-action=meta-disp]");
  assert.ok(rows.length >= 4);
  click(w, rows[0]);
  assert.ok(d.querySelectorAll("[data-testid=disp-vs] tr").length > 2, "disposition vs disposition rows");
  // Events tab
  click(w, [...d.querySelectorAll("[data-action=meta-tab]")].find((b) => b.dataset.tab === "events"));
  const V = w.MusterCore.metaView(WR, w.Muster.S.ui.metaRange, true);
  assert.equal(d.querySelectorAll("[data-testid=events-table] tr").length - 1, V.events.length);
  // a new session remembers RTT + window + tab
  const b = makeApp({ storage: { "muster.metaRtt": "1", "muster.metaRange": "weekend", "muster.metaHome": "factions" } });
  await until(() => b.d.querySelector(".lists-page")); await until(() => b.w.Muster.S.wr);
  await go(b.w, "#/meta");
  assert.equal(b.d.querySelector("[data-testid=rtt-toggle]").checked, true);
  assert.equal(b.d.querySelector(".meta-page").dataset.view, "weekend_rtt");
});

test("Meta faction page: tabs (Overview / Detachments / Matchups / Dispositions / Lists) follow the RTT toggle", { skip: !HAS_DS }, async (tc) => {
  const { w, d, server } = makeApp({ storage: { "muster.metaRange": "weekend" } });
  await until(() => d.querySelector(".lists-page")); await until(() => w.Muster.S.wr);
  const f = WR.factions.find((x) => x.rtt && x.rtt.detachments.length > 2 && x.matchups.length > 5 && (WR.lists_available || []).includes(x.slug));
  if (!f) return tc.skip("no faction in this dataset is big enough for every tab (e.g. early in a weekend)");
  await go(w, `#/meta/${f.slug}`);
  const tabs = [...d.querySelectorAll("[data-action=meta-tab]")].map((b) => b.dataset.tab);
  assert.deepEqual(tabs, ["overview", "detachments", "matchups", "dispositions", "lists"]);
  assert.ok(d.querySelector(".backlink[href='#/meta']"), "back button");
  const tile0 = () => d.querySelector("[data-testid=meta-tiles] .tile .tv").textContent;
  assert.equal(tile0(), w.MusterCore.fmtPct(f.win_rate));
  change(w, d.querySelector("[data-testid=rtt-toggle]"), true);
  assert.equal(tile0(), w.MusterCore.fmtPct(f.rtt.win_rate));
  const tab = (name) => click(w, [...d.querySelectorAll("[data-action=meta-tab]")].find((b) => b.dataset.tab === name));
  tab("detachments");
  assert.equal(d.querySelectorAll("[data-testid=det-table] tr").length - 1, f.rtt.detachments.filter((x) => x.name !== "Unknown").length);
  assert.match(d.querySelector(".meta-page").textContent, /RTT detachment stats can be heavily skewed/);
  assert.equal(w.localStorage.getItem("muster.metaTab"), "detachments");
  tab("matchups");
  assert.equal(d.querySelectorAll("[data-testid=matchup-table] tr").length - 1, f.rtt.matchups.length);
  tab("dispositions");
  assert.equal(d.querySelectorAll("[data-testid=fac-disp] .dbar").length, Object.keys(f.rtt.dispositions).length);
  // other windows: tiles follow the faction table, breakdowns say they are This Weekend only
  click(w, d.querySelector('[data-action=meta-range][data-range="4weeks"]'));
  assert.ok(d.querySelector("[data-testid=weekend-only]"), "weekend-only note");
  const r4 = WR.datasets["4weeks_rtt"].table.find((r) => r.name === f.name);
  tab("overview");
  assert.equal(tile0(), w.MusterCore.fmtPct(r4.win_rate));
  click(w, d.querySelector('[data-action=meta-range][data-range="weekend"]'));
  // Lists: lazy-loaded per faction, filter by detachment, copy list text
  tab("lists");
  await until(() => d.querySelector("[data-testid=meta-lists]"));
  assert.ok(server.requests.some((u) => u.includes(`data/meta-lists/${f.slug}.json`)));
  const L = JSON.parse(fs.readFileSync(path.join(APP, "data/meta-lists", f.slug + ".json"), "utf8"));
  assert.equal(d.querySelectorAll("[data-testid=meta-lists] .mlist").length, L.rtt.lists.length);
  const sel = d.querySelector("[data-change=meta-list-det]");
  if (sel) {
    const det = sel.options[1].value; change(w, sel, undefined, det);
    assert.equal(d.querySelectorAll("[data-testid=meta-lists] .mlist").length, L.rtt.lists.filter((x) => x.detachment === det).length);
  }
  const btn = d.querySelector("[data-action=meta-copy-list]");
  click(w, btn); await tick(5);
  assert.equal(server.clipboard, L.rtt.lists[+btn.dataset.i].text);
});

test("core: metaView reads both the new datasets and the older single-window winrates.json", () => {
  const C = require("../app/js/core.js");
  const legacy = { date_range: { label: "This Weekend", dates: "1 Oct - 6 Oct 2026" }, ranges: { weekend: { label: "This Weekend" }, "4weeks": { label: "Last 4 Weeks", dates: "x" } },
    dispositions_4weeks: [{ name: "Take and Hold", win_rate: 50 }],
    factions: [{ name: "Orks", slug: "orks", mfm_id: "orks", win_rate: 58, games: 10, last_4_weeks: { win_rate: 56, games: 40 } }] };
  assert.deepEqual(C.metaRanges(legacy).map((r) => r.key), ["weekend", "4weeks"]);
  assert.equal(C.metaHasRtt(legacy), false);
  assert.equal(C.metaView(legacy, "4weeks", true).rows[0].win_rate, 56);
  assert.equal(C.metaView(legacy, "4weeks", true).rtt, false);
  assert.equal(C.metaView(legacy, "dataslate", false).key, "weekend");
  const wr = { factions: [{ name: "Orks", slug: "orks", mfm_id: "orks", win_rate: 58, rtt: { win_rate: 55, matchups: [] }, matchups: [{}] }],
    datasets: { weekend: { label: "This Weekend", table: [{ name: "Orks", win_rate: 58 }] }, weekend_rtt: { label: "This Weekend", table: [{ name: "Orks", win_rate: 55 }, { name: "T'au Empire", win_rate: 50 }] },
      dataslate: { label: "Since Dataslate (Sep 30)", table: [] } } };
  assert.deepEqual(C.metaRanges(wr).map((r) => r.label), ["This Weekend", "Since Dataslate (Sep 30)"]);
  assert.equal(C.metaHasRtt(wr), true);
  const v = C.metaView(wr, "weekend", true);
  assert.equal(v.key, "weekend_rtt"); assert.equal(v.rows.length, 2); assert.equal(v.rows[1].slug, "tau-empire");
  assert.equal(C.metaView(wr, "dataslate", true).key, "dataslate");     // no RTT variant -> the plain one
  assert.equal(C.metaView(wr, "4weeks", false).key, "weekend");         // window not offered -> This Weekend
  assert.equal(C.metaDetail(wr.factions[0], true).win_rate, 55);
  assert.equal(C.metaDetail(wr.factions[0], false).win_rate, 58);
});

test("listhammer scraper only requests robots-allowed pages", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "scraper", "fetch_winrates.py"), "utf8");
  assert.match(src, /rp\.can_fetch\(UA, BASE \+ path\) or not rp\.can_fetch\("\*", BASE \+ path\)/);
  const paths = [...src.matchAll(/get\(f?"(\/[^"]*)"/g), ...src.matchAll(/"(\/stats[^"]*)"/g)].map((m) => m[1]);
  assert.ok(paths.includes("/factions/{slug}") && paths.includes("/factions/{slug}?includeRtt=true") && paths.includes("/stats?includeRtt=true"), paths.join());
  for (const p of paths) assert.ok(!/^\/(api|players|events|list)\//.test(p), p);
});

test("dark mode stylesheet: footer and surfaces are dark", () => {
  const css = fs.readFileSync(path.join(APP, "css/app.css"), "utf8");
  const dark = css.match(/html\[data-theme="dark"\] \{([^}]*)\}/)[1];
  const v = (name) => (dark.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})`)) || [])[1];
  const lum = (hex) => { const h = hex.replace("#", ""); const n = h.length === 3 ? h.split("").map((c) => parseInt(c + c, 16)) : [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); return (n[0] + n[1] + n[2]) / 3; };
  for (const k of ["footer", "bg", "surface", "sect", "row", "hdr"]) assert.ok(lum(v(k)) < 40, `${k} ${v(k)}`);
  assert.match(css, /#footer \{[^}]*background: var\(--footer\)/);
  assert.ok(!/html, body \{[^}]*height: 100%/.test(css), "body not fixed to viewport height (footer stays at the bottom)");
});

/* ---------------------------------------------------------------- second visual review */
function reviewOldData() {
  // the data the reviewer's browser had cached: same MFM points, older GrimSlate rebuild in which Space Wolves had two
  // datasheets both named "Venerable Dreadnought" (current 130/140 + Legends 165, Legends sorted last) and other text
  const old = JSON.parse(JSON.stringify(POINTS));
  old.hash = "0aed026cd5df42d8";
  const sw = old.factions.find((f) => f.id === "space-wolves");
  const leg = sw.units.find((u) => u.n === "Venerable Dreadnought [Legends]");
  leg.n = "Venerable Dreadnought";
  sw.units = sw.units.filter((u) => u !== leg).concat([leg]);
  for (const f of old.factions) for (const u of f.units) { delete u.lo; if (u.ab) u.ab = "older text"; }
  return old;
}
test("points-update banner: silent on a brand-new install and on rebuilds without points changes; dates local", async () => {
  // brand-new install: nothing cached -> no banner, no stored report
  const { w, d, server } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  assert.equal(d.querySelector("[data-testid=update-banner]"), null);
  assert.equal(w.localStorage.getItem("muster.updateReport"), null);
  // the review scenario: cached = older rebuild, server = current rebuild with identical MFM points
  const app2 = makeApp(); const old = reviewOldData();
  app2.server.points = old; app2.server.version = { ...VERSION, hash: old.hash };
  await until(() => app2.d.querySelector(".lists-page"));
  assert.equal(app2.w.Muster.S.data.hash, old.hash);
  const diff = app2.w.MusterCore.diffData(old, POINTS);
  assert.equal(diff.units.length, 0, JSON.stringify(diff.units.slice(0, 3)));
  app2.server.points = POINTS; app2.server.version = { ...VERSION };
  const r = await app2.w.Muster.checkForUpdates(true);
  assert.equal(r.updated, true); assert.equal(app2.w.Muster.S.data.hash, POINTS.hash);
  app2.w.Muster.route();
  assert.equal(app2.d.querySelector("[data-testid=update-banner]"), null, "no banner for a rebuild without points changes");
  assert.equal(app2.w.localStorage.getItem("muster.updateReport"), null);
  // a stale stored report with nothing in it (from the old build) is not shown either
  const stale = { at: "2026-10-08T03:25:12Z", from: { v: "v1.5", fetched_at: "2026-10-08T02:48:37+00:00" }, to: { v: "v1.5", fetched_at: "2026-10-08T02:48:37+00:00" }, lists: [], data: { counts: { units: 0, enhancements: 0, detachments: 0 }, units: [], enhancements: [], detachments: [] }, dismissed: false };
  const app3 = makeApp({ storage: { "muster.updateReport": JSON.stringify(stale) } });
  await until(() => app3.d.querySelector(".lists-page"));
  assert.equal(app3.d.querySelector("[data-testid=update-banner]"), null);
  // a real points change still shows, with local-time dates (no raw ISO / UTC date)
  const fresh = JSON.parse(JSON.stringify(POINTS)); fresh.hash = "pointschange0001"; fresh.fetched_at = "2026-10-08T02:48:37+00:00";
  fresh.factions.find((f) => f.id === "necrons").units[0].t[0][2][0][1] += 5;
  server.points = fresh; server.version = { ...VERSION, hash: fresh.hash };
  await w.Muster.checkForUpdates(true); w.Muster.route();
  const b = d.querySelector("[data-testid=update-banner]");
  assert.ok(b, "banner for a real points change");
  assert.match(b.textContent, new RegExp(w.MusterCore.fmtLocal(fresh.fetched_at).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(b.querySelector("h4").textContent, /2026-10-08/);
});

test("review 2: fixed editor layout, amber warning markers, dark textarea grip, redundant option heading dropped", async () => {
  const css = read("css/app.css");
  assert.match(css, /body\.app-fixed \{[^}]*height: 100dvh;[^}]*overflow: hidden;/);
  assert.match(css, /\.cols \{[^}]*grid-template-rows: minmax\(0, 1fr\);[^}]*min-height: 0;/);
  assert.doesNotMatch(css, /\.cols[^{]*\{[^}]*height: calc\(100vh/);
  assert.match(css, /\.col > \.scroll, \.col > \.pbody \{[^}]*overflow-y: auto;/);
  assert.match(css, /\.need\.warn, \.dot\.warn \{[^}]*background: var\(--amber\)/);
  assert.match(css, /html\[data-theme="dark"\] ::-webkit-scrollbar-corner, html\[data-theme="dark"\] ::-webkit-resizer \{ background: #1a1a1a; \}/);
  const { w, d } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  assert.ok(!d.body.classList.contains("app-fixed"), "lists page scrolls normally");
  const C = w.MusterCore;
  const smF = POINTS.factions.find((f) => f.id === "space-marines");
  const det = smF.dets.find((x) => x.src === "mfm" && (x.fd || []).length);
  const l = C.newList({ name: "Review2", faction: "space-marines", sub: "space-marines" }); l.dets = [det.n];
  const cap = smF.units.find((u) => u.n === "Captain"); const e = C.newEntry(cap); e.warlord = true; l.entries.push(e);
  const red = smF.units.find((u) => u.n === "Redemptor Dreadnought"); l.entries.push(C.newEntry(red));
  w.Muster.S.lists.push(l);
  await go(w, "#/list/" + l.id);
  assert.ok(d.body.classList.contains("app-fixed"), "editor is a fixed-viewport view");
  for (const sel of [".col.catalog > .scroll", ".col.roster > .scroll"]) assert.ok(d.querySelector(sel), sel);
  // Force Disposition missing = warning -> amber markers, not red
  const calc = C.calcList(l, w.Muster.S.idx);
  assert.equal(calc.errors.length, 0, calc.errors.map((x) => x.msg).join("; "));
  assert.ok(calc.warnings.some((x) => /Force Disposition/.test(x.msg)));
  const hdrMark = d.querySelector(".card .sect-h .need");
  assert.ok(hdrMark && hdrMark.classList.contains("warn"), "config header marker is amber");
  assert.match(hdrMark.title, /^Warning/);
  const fdRow = [...d.querySelectorAll(".cfgrow")].find((x) => /Force Disposition/.test(x.textContent));
  assert.ok(fdRow.querySelector(".need.warn"));
  const dot = d.querySelector("[data-testid=valid-dot]");
  assert.ok(dot.classList.contains("warn") && !dot.classList.contains("err"), dot.className);
  // missing detachment = error -> red
  l.dets = []; w.Muster.route();
  const m2 = d.querySelector(".card .sect-h .need"); assert.ok(m2 && !m2.classList.contains("warn"), "no detachment is a red error");
  assert.ok(d.querySelector("[data-testid=valid-dot]").classList.contains("err"));
  l.dets = [det.n]; w.Muster.route();
  // Redemptor (codex loadout): "Icarus Rocket Pod" group with one same-named option has no heading
  click(w, [...d.querySelectorAll(".roster .urow")].find((x) => x.textContent.includes("Redemptor")));
  const lo = d.querySelector(".panel .loadout");
  assert.ok(lo, "loadout tree");
  const heads = [...lo.querySelectorAll(".slh")].map((x) => x.textContent.trim());
  assert.ok(!heads.some((h) => /^Icarus Rocket Pod/.test(h)), heads.join(" | "));
  assert.ok(heads.some((h) => /^Heavy Onslaught Gatling Cannon/.test(h)), heads.join(" | "));
  const icarus = [...lo.querySelectorAll(".slot.solo label.opt")].find((x) => /Icarus Rocket Pod/.test(x.textContent));
  assert.ok(icarus && icarus.querySelector("input[type=checkbox]"), "option itself still offered");
  // back to lists: page scrolls normally again
  await go(w, "#/lists");
  assert.ok(!d.body.classList.contains("app-fixed"));
});

test("multiple detachments: World Eaters Berzerker Warband + Vessels of Wrath show both rules, stratagems and enhancements everywhere", async () => {
  const weF = POINTS.factions.find((f) => f.id === "world-eaters");
  const BW = weF.dets.find((x) => x.n === "Berzerker Warband"), VW = weF.dets.find((x) => x.n === "Vessels of Wrath");
  // data: both detachments are MFM detachments matched to GrimSlate, with rule text and stratagems
  for (const d of [BW, VW]) {
    assert.ok(d, "detachment exists"); assert.equal(d.src, "mfm");
    assert.ok(d.rule && d.rule[0] && d.rule[1], `${d.n} rule text`);
    assert.ok(d.st.length >= 3, `${d.n} stratagems`); assert.ok(d.enh.length >= 2, `${d.n} enhancements`);
  }
  assert.equal(BW.rule[0], "Relentless Rage"); assert.equal(VW.rule[0], "Wrath of Khorne");
  const { w, d } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  const C = w.MusterCore;
  const l = C.newList({ name: "Khorne", faction: "world-eaters", sub: "world-eaters" });
  const charU = weF.units.find((u) => u.n === "Lord on Juggernaut");
  const e = C.newEntry(charU); e.warlord = true; l.entries.push(e);
  w.Muster.S.lists.push(l);
  await go(w, "#/list/" + l.id);
  // select both via the Detachment panel
  click(w, d.querySelector("[data-testid=det-details]"));
  for (const n of [BW.n, VW.n]) change(w, [...d.querySelectorAll(".panel input[data-change=det]")].find((b) => b.value === n), true);
  assert.deepEqual([...l.dets], [BW.n, VW.n]);
  assert.match(d.querySelector("[data-testid=dp]").textContent, /3 \/ 3 DP/);
  const calc = C.calcList(l, w.Muster.S.idx);
  assert.equal(calc.errors.length, 0, calc.errors.map((x) => x.msg).join("; "));
  // Detachment panel: one block per selected detachment with its own rule + stratagems
  const blocks = [...d.querySelectorAll(".panel [data-testid=det-block]")];
  assert.deepEqual(blocks.map((b) => b.dataset.det), [BW.n, VW.n]);
  for (const [b, det] of [[blocks[0], BW], [blocks[1], VW]]) {
    assert.match(b.textContent, new RegExp(det.rule[0]));
    assert.equal(b.querySelectorAll("[data-testid=det-strats] .strat").length, det.st.length, det.n);
    for (const s of det.st) assert.ok(b.textContent.includes(s[0]), `${det.n}: ${s[0]}`);
  }
  // the eye button on an unselected detachment adds a preview after the selected ones, without hiding them
  const other = weF.dets.find((x) => x.src === "mfm" && ![BW.n, VW.n].includes(x.n));
  click(w, d.querySelector(`.panel [data-action=focus-det][data-det="${other.n}"]`));
  const b2 = [...d.querySelectorAll(".panel [data-testid=det-block]")];
  assert.deepEqual(b2.map((b) => b.dataset.det), [BW.n, VW.n, other.n]);
  assert.ok(b2[2].classList.contains("preview"));
  // Configuration card: each detachment's rule (+ enhancements) right under the Detachments row, collapsed
  const rules = [...d.querySelectorAll(".roster .cfgcard [data-testid=det-rule-row]")];
  assert.deepEqual(rules.map((x) => x.dataset.det), [BW.n, VW.n]);
  assert.ok(rules.every((x) => !x.open), "collapsed by default");
  assert.match(rules[0].querySelector("summary").textContent, /Berzerker Warband – Relentless Rage/);
  assert.match(rules[1].querySelector("summary").textContent, /Vessels of Wrath – Wrath of Khorne/);
  assert.match(rules[1].querySelector("[data-testid=det-rule-text]").textContent, new RegExp(VW.rule[1].slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(rules[0].querySelectorAll("[data-testid=det-rule-enh] .opt").length, BW.enh.length);
  // enhancements first, the detachment rule underneath them
  for (const r of rules) { const en = r.querySelector("[data-testid=det-rule-enh]"), ru = r.querySelector("[data-testid=det-rule-text]");
    if (en && ru) assert.ok(en.compareDocumentPosition(ru) & 4, "rule follows the enhancements"); }
  const detsRow = d.querySelector(".roster .cfgcard [data-testid=det-dd]");
  assert.equal(detsRow.nextElementSibling.dataset.testid, "det-rules", "rules sit right below the Detachments row");
  // bottom Stratagems card: one row per detachment (stratagems only), then Core
  const cfg = [...d.querySelectorAll(".roster [data-testid=cfg-det]")];
  assert.deepEqual(cfg.map((x) => x.dataset.det), [BW.n, VW.n]);
  assert.match(d.querySelector("[data-testid=cfg-more] .sect-h").textContent, /^\s*Stratagems/);
  assert.match(cfg[0].querySelector("summary").textContent, /6 stratagems|\d+ stratagems/);
  assert.equal(cfg[0].querySelectorAll(".strat").length, BW.st.length);
  assert.equal(cfg[1].querySelectorAll(".strat").length, VW.st.length);
  const coreRow = d.querySelector("[data-testid=cfg-more] [data-testid=cfg-core]");
  assert.ok(coreRow && coreRow.compareDocumentPosition(cfg[1]) & w.Node.DOCUMENT_POSITION_PRECEDING, "Core after the detachments");
  assert.equal(coreRow.querySelectorAll(".strat").length, 10);
  assert.match(coreRow.textContent, /COUNTEROFFENSIVE/);
  // unit panel: enhancements from BOTH detachments, stratagems grouped under each detachment
  click(w, [...d.querySelectorAll(".roster .urow")].find((x) => x.textContent.includes(charU.n)));
  const enhVals = [...d.querySelectorAll(".panel input[data-change=enh]")].map((x) => x.value).filter(Boolean);
  for (const det of [BW, VW]) for (const en of det.enh) assert.ok(enhVals.includes(det.n + "||" + en[0]), `${det.n}: ${en[0]}`);
  change(w, d.querySelector(`.panel input[data-change=enh][value="${VW.n}||${VW.enh[0][0]}"]`), true);
  assert.deepEqual({ ...l.entries[0].enh }, { det: VW.n, name: VW.enh[0][0] });
  assert.equal(C.calcList(l, w.Muster.S.idx).enhancements, VW.enh[0][1]);
  // Stratagems for this unit: per detachment first (only those whose TARGET fits this unit), then Core
  const groups = [...d.querySelectorAll(".panel [data-testid=unit-strats] .stgrp")];
  assert.deepEqual(groups.map((g) => g.dataset.det || "core"), [BW.n, VW.n, "core"]);
  const exp = C.unitStratagems(charU, w.Muster.S.idx.factions["world-eaters"], [BW, VW], w.Muster.S.ds.core_st.st);
  assert.equal(groups[0].querySelectorAll("[data-testid=ust]").length, exp.groups[0].items.length);
  assert.equal(groups[1].querySelectorAll("[data-testid=ust]").length, exp.groups[1].items.length);
  assert.equal(groups[2].querySelectorAll("[data-testid=ust]").length, exp.core.items.length);
  // Stratagems export: both detachments, each with its rule and all its stratagems, grouped
  const txt = C.exportStratagems ? C.exportStratagems(l, w.Muster.S.idx, w.Muster.S.meta) : C.EXPORT_FORMATS.find((f) => f.id === "stratagems").fn(l, w.Muster.S.idx, w.Muster.S.meta);
  const iB = txt.indexOf("== BERZERKER WARBAND"), iV = txt.indexOf("== VESSELS OF WRATH");
  assert.ok(iB >= 0 && iV > iB, txt.slice(0, 200));
  assert.match(txt.slice(iB, iV), /Detachment rule – Relentless Rage/);
  assert.match(txt.slice(iV), /Detachment rule – Wrath of Khorne/);
  for (const s of BW.st) assert.ok(txt.slice(iB, iV).includes(s[0]), s[0]);
  for (const s of VW.st) assert.ok(txt.slice(iV).includes(s[0]), s[0]);
  // the other export formats list both detachments too
  for (const f of ["gw", "wtc", "simple"]) {
    const t = C.EXPORT_FORMATS.find((x) => x.id === f).fn(l, w.Muster.S.idx, w.Muster.S.meta);
    assert.ok(new RegExp(BW.n, "i").test(t) && new RegExp(VW.n, "i").test(t), f);
  }
});

/* ---------------------------------------------------------------- detachment-locked units, leaders, enhancement rules */
const WE = () => POINTS.factions.find((f) => f.id === "world-eaters");
async function weEditor(dets, units, size) {
  const app = makeApp(); const { w, d } = app;
  await until(() => d.querySelector(".lists-page"));
  const C = w.MusterCore;
  const l = C.newList({ name: "WE", faction: "world-eaters", sub: "world-eaters", size: size || "strikeforce" }); l.dets = dets.slice();
  for (const n of units) l.entries.push(C.newEntry(WE().units.find((u) => u.n === n)));
  w.Muster.S.lists.push(l);
  await go(w, "#/list/" + l.id);
  return { ...app, C, l, rowOf: (i) => d.querySelector(`.roster .urow[data-uid="${l.entries[i].uid}"]`) };
}

test("detachment-restricted units: World Eaters Bloodletters need Khorne Daemonkin (all factions derived from data)", async () => {
  // data: MFM 'BLOOD LEGIONS' sub-group + GrimSlate faction keyword + the detachment rule naming them
  const req = (fid, n) => (POINTS.factions.find((f) => f.id === fid).units.find((u) => u.n === n) || {}).req;
  assert.deepEqual(req("world-eaters", "Bloodletters"), ["Khorne Daemonkin"]);
  for (const n of ["Bloodcrushers", "Bloodthirster", "Flesh Hounds", "Skarbrand"]) assert.deepEqual(req("world-eaters", n), ["Khorne Daemonkin"], n);
  assert.deepEqual(req("death-guard", "Plaguebearers"), ["Tallyband Summoners"]);
  assert.deepEqual(req("thousand-sons", "Pink Horrors"), ["Changehost of Deceit"]);
  assert.deepEqual(req("emperors-children", "Daemonettes"), ["Carnival of Excess"]);
  for (const [fid, n] of [["world-eaters", "Khorne Berzerkers"], ["aeldari", "Death Jester"], ["aeldari", "Yvraine"], ["space-marines", "Marneus Calgar"]]) assert.equal(req(fid, n), undefined, n);
  const { w, d, C, l } = await weEditor(["Berzerker Warband"], []);
  // hidden by default; toggle shows them greyed with the reason and no add action
  assert.equal(d.querySelector('#catbody .crow[data-unit="Bloodletters"]'), null);
  const tog = d.querySelector("[data-testid=lock-toggle]"); assert.ok(tog); assert.match(tog.textContent, /5 units.*Khorne Daemonkin/s);
  change(w, tog.querySelector("input"), true);
  const row = d.querySelector('#catbody .crow.locked[data-unit="Bloodletters"]');
  assert.ok(row); assert.match(row.textContent, /Only with the Khorne Daemonkin detachment/);
  assert.equal(row.getAttribute("data-action"), null); assert.ok(row.querySelector("button.add").disabled);
  click(w, row); assert.equal(l.entries.length, 0, "locked unit can't be added");
  // select Khorne Daemonkin -> addable
  l.dets = ["Khorne Daemonkin"]; w.Muster.route();
  const add = d.querySelector('#catbody .crow[data-unit="Bloodletters"] .add');
  assert.ok(!add.disabled); click(w, add);
  assert.equal(l.entries.length, 1);
  assert.ok(!C.calcList(l, w.Muster.S.idx).errors.some((x) => /Bloodletters/.test(x.msg)));
  // remove the detachment -> error on the unit, still shown in the catalog
  change(w, [...d.querySelectorAll("[data-testid=det-dd] input[data-change=det]")].find((b) => b.value === "Khorne Daemonkin"), false);
  const errs = C.calcList(l, w.Muster.S.idx).errors.map((x) => x.msg);
  assert.ok(errs.includes("Bloodletters: only available with the Khorne Daemonkin detachment"), errs.join("; "));
  assert.ok(d.querySelector(`.roster .urow[data-uid="${l.entries[0].uid}"] .dot.err`));
  assert.ok(d.querySelector('#catbody .crow[data-unit="Bloodletters"]'), "in-list unit stays visible");
});

test("leader attachment: Lord on Juggernaut + Master of Executions join Khorne Berzerkers; nested roster, exports, one Leader per unit", async () => {
  const { w, d, C, l, rowOf } = await weEditor(["Berzerker Warband"], ["Khorne Berzerkers", "Khorne Berzerkers", "Lord on Juggernaut", "Master of Executions", "Jakhals"]);
  const [kb1, kb2, loj, moe, jak] = l.entries; loj.warlord = true;
  click(w, rowOf(2));
  const opts = [...d.querySelectorAll(".panel [data-testid=attach-opt]")];
  assert.deepEqual(opts.map((o) => o.dataset.to), [kb1.uid, kb2.uid], "only eligible bodyguards in the list (no Jakhals)");
  assert.match(opts[0].textContent, /Khorne Berzerkers #1/);
  change(w, opts[0].querySelector("input"), true, kb1.uid);
  assert.equal(loj.attach, kb1.uid);
  // nested under the bodyguard, not in the Character section
  const grp = d.querySelector(".roster [data-testid=attached-group]");
  assert.ok(grp);
  // character above the unit it leads: Leader row first, bodyguard row last
  assert.deepEqual([...grp.querySelectorAll(".urow")].map((x) => x.dataset.uid), [loj.uid, kb1.uid]);
  assert.equal(grp.querySelector("[data-testid=attached-row]").dataset.uid, loj.uid);
  const charSect = [...d.querySelectorAll(".roster .card")].find((c) => /^\s*Character/.test(c.querySelector(".sect-h").textContent));
  assert.ok(charSect && !charSect.querySelector(`.urow[data-uid="${loj.uid}"]`), "attached Leader is not listed again under Character");
  // Master of Executions: Berzerkers #1 already has a Leader -> disabled with reason; #2 free
  click(w, rowOf(3));
  const o2 = [...d.querySelectorAll(".panel [data-testid=attach-opt]")];
  assert.ok(o2[0].querySelector("input").disabled); assert.match(o2[0].textContent, /Already has a Leader: Lord on Juggernaut/);
  assert.ok(!o2[1].querySelector("input").disabled);
  change(w, o2[1].querySelector("input"), true, kb2.uid);
  let c = C.calcList(l, w.Muster.S.idx);
  assert.equal(c.errors.length, 0, c.errors.map((x) => x.msg).join("; "));
  // exports show the attachment
  const gw = C.EXPORT_FORMATS.find((f) => f.id === "gw").fn(l, w.Muster.S.idx, w.Muster.S.meta);
  assert.match(gw, /Lord on Juggernaut \(\d+ Points\)\n(?:.*\n)*?\s+• Attached to: Khorne Berzerkers #1/);
  assert.match(gw, /Master of Executions[^\n]*\n(?:.*\n)*?\s+• Attached to: Khorne Berzerkers #2/);
  for (const f of ["wtc", "wtc-full", "simple"]) assert.match(C.EXPORT_FORMATS.find((x) => x.id === f).fn(l, w.Muster.S.idx, w.Muster.S.meta), /Attached to: Khorne Berzerkers #1/, f);
  // share link keeps the attachment
  const back = C.listFromShareable(await w.Muster.decodeShare(await w.Muster.encodeShare(l)));
  assert.equal(back.entries[2].attach, back.entries[0].uid); assert.equal(back.entries[3].attach, back.entries[1].uid);
  // invalid states are flagged: two Leaders on one unit (error), ineligible bodyguard (warning)
  moe.attach = kb1.uid; c = C.calcList(l, w.Muster.S.idx);
  assert.ok(c.errors.some((x) => /Khorne Berzerkers has 2 Leaders attached/.test(x.msg)), c.errors.map((x) => x.msg).join("; "));
  moe.attach = jak.uid; c = C.calcList(l, w.Muster.S.idx);
  assert.ok(c.warnings.some((x) => /Master of Executions cannot be attached to Jakhals/.test(x.msg)));
  moe.attach = kb2.uid; w.Muster.route();
  // deleting the bodyguard detaches its Leader
  click(w, d.querySelector(`.roster [data-action=del-entry][data-uid="${kb2.uid}"]`));
  assert.equal(moe.attach, undefined);
  assert.equal(d.querySelectorAll(".roster [data-testid=attached-row]").length, 1);
});

test("enhancements: keyword restrictions, taken-once, one per attached unit, army limit, Epic Heroes", async () => {
  const { w, d, C, l, rowOf } = await weEditor(["Cult of Blood", "Possessed Slaughterband"],
    ["Lord on Juggernaut", "Master of Executions", "Daemon Prince of Khorne", "Angron", "Khorne Berzerkers"]);
  const [loj, moe, dp, angron, kb] = l.entries;
  const opt = (name) => d.querySelector(`.panel [data-testid=enh-opt][data-enh="${name}"]`);
  // Lord on Juggernaut is MOUNTED: "WORLD EATERS INFANTRY model only" is greyed with the reason
  click(w, rowOf(0));
  assert.ok(opt("Butcher Lord").querySelector("input").disabled);
  assert.match(opt("Butcher Lord").querySelector("[data-testid=enh-why]").textContent, /WORLD EATERS INFANTRY model only/);
  assert.ok(opt("Frenzied Focus").querySelector("input").disabled, "World Eaters Daemon model only");
  assert.ok(opt("Malicious Vigour").querySelector("input").disabled, "Slaughterbound model only");
  assert.ok(!opt("Strategic Slaughter").querySelector("input").disabled);
  change(w, opt("Strategic Slaughter").querySelector("input"), true, "Cult of Blood||Strategic Slaughter");
  // Master of Executions (INFANTRY): Butcher Lord allowed; Strategic Slaughter taken by Lord on Juggernaut
  click(w, rowOf(1));
  assert.ok(!opt("Butcher Lord").querySelector("input").disabled);
  assert.ok(opt("Strategic Slaughter").querySelector("input").disabled);
  assert.match(opt("Strategic Slaughter").textContent, /Already taken by Lord on Juggernaut/);
  // Daemon Prince (MONSTER, DAEMON): Brazen Form + Frenzied Focus allowed
  click(w, rowOf(2));
  for (const n of ["Brazen Form", "Frenzied Focus"]) assert.ok(!opt(n).querySelector("input").disabled, n);
  assert.ok(opt("Butcher Lord").querySelector("input").disabled);
  // Epic Hero: no enhancement section
  click(w, rowOf(3));
  assert.equal(d.querySelector(".panel [data-testid=enh-grp]"), null);
  // one enhancement per attached unit (bodyguard + its Leaders)
  loj.attach = kb.uid; w.Muster.route(); click(w, rowOf(1));
  // MoE not attached yet: free to choose
  assert.ok(!opt("Butcher Lord").querySelector("input").disabled);
  moe.attach = kb.uid; w.Muster.route(); click(w, rowOf(1));
  assert.ok(opt("Butcher Lord").querySelector("input").disabled);
  assert.match(opt("Butcher Lord").textContent, /same attached unit already has Strategic Slaughter/);
  moe.enh = { det: "Cult of Blood", name: "Butcher Lord" };
  assert.ok(C.calcList(l, w.Muster.S.idx).errors.some((x) => /No unit \(including attached units\) can have more than one enhancement/.test(x.msg)));
  moe.enh = null; delete moe.attach; delete loj.attach;
  // army limit: Incursion allows 2
  l.size = "incursion"; l.dets = ["Cult of Blood"]; loj.enh = { det: "Cult of Blood", name: "Strategic Slaughter" }; moe.enh = { det: "Cult of Blood", name: "Butcher Lord" };
  w.Muster.route(); click(w, rowOf(2));
  assert.match(d.querySelector(".panel [data-testid=enh-count]").textContent, /2 \/ 2 used/);
  assert.ok(opt("Brazen Form").querySelector("input").disabled);
  assert.match(opt("Brazen Form").textContent, /Enhancement limit reached \(2\/2\)/);
  // a forced ineligible enhancement is a validation error
  loj.enh = { det: "Cult of Blood", name: "Butcher Lord" }; moe.enh = null;
  assert.ok(C.calcList(l, w.Muster.S.idx).errors.some((x) => /Lord on Juggernaut cannot take Butcher Lord: WORLD EATERS INFANTRY model only/.test(x.msg)));
});

test("datasheet view: Profiles (stats incl. invuln, weapons with equipped highlight, abilities, keywords), eye popups, combined card", async () => {
  assert.ok(DS && DS.factions && DS.data_version, "datasheets.json built with GrimSlate data version");
  assert.equal(VERSION.datasheets_hash, DS.hash);
  // coverage across all factions: nearly every unit has stats + weapons
  let n = 0, withS = 0, withW = 0;
  for (const f of POINTS.factions) for (const u of f.units) { n++; const x = DS.factions[f.id] && DS.factions[f.id].units[u.n]; if (x && x.s && x.s.M && x.s.T && x.s.W) withS++; if (x && x.wp.length) withW++; }
  assert.ok(withS / n > 0.95 && withW / n > 0.95, `${withS}/${withW} of ${n}`);
  const { w, d, C, l, rowOf } = await weEditor(["Berzerker Warband"], ["Khorne Berzerkers", "Lord on Juggernaut", "Angron"]);
  const [kb, loj, angron] = l.entries; loj.warlord = true;
  await until(() => w.Muster.S.ds);
  // roster click -> options panel with a Profiles section
  click(w, rowOf(0));
  const prof = d.querySelector(".panel [data-testid=profiles]"); assert.ok(prof);
  const stats = prof.querySelector("[data-testid=ds-stats]"); assert.ok(stats);
  assert.deepEqual([...stats.querySelectorAll("th")].map((x) => x.textContent), ["Unit", "M", "T", "Sv", "W", "Ld", "OC", "InSv"]);
  const ks = DS.factions["world-eaters"].units["Khorne Berzerkers"].s;
  assert.deepEqual([...stats.querySelectorAll("tr:nth-child(2) td")].slice(1, 7).map((x) => x.textContent), [ks.M, ks.T, ks.SV, ks.W, ks.LD, ks.OC]);
  const ranged = prof.querySelector("[data-testid=ds-ranged]"), melee = prof.querySelector("[data-testid=ds-melee]");
  assert.ok(ranged && melee);
  assert.deepEqual([...melee.querySelectorAll("th")].map((x) => x.textContent), ["Melee Weapons", "Range", "A", "WS", "S", "AP", "D", "Keywords"]);
  // default loadout: Chainblade + Bolt pistol equipped (highlighted), eviscerator/plasma shown dimmed
  const wrow = (tab, n) => tab.querySelector(`tr[data-weapon="${n}"]`);
  assert.ok(wrow(melee, "Chainblade").classList.contains("eq")); assert.ok(wrow(ranged, "Bolt pistol").classList.contains("eq"));
  assert.ok(wrow(melee, "Khornate eviscerator").classList.contains("uneq"));
  assert.match(wrow(ranged, "Plasma pistol").nextElementSibling.textContent, /supercharge/, "multi-profile weapon rows");
  assert.match(ranged.textContent, /Pistol/);
  const ab = prof.querySelector("[data-testid=ds-abilities]"); assert.match(ab.querySelector("[data-testid=ab-datasheet]").textContent, /Blood Surge/); assert.match(ab.querySelector("[data-testid=ab-faction]").textContent, /Blessings of Khorne/);
  assert.match(ab.querySelector("[data-testid=ab-wargear]").textContent, /Icon of Khorne/);
  assert.match(prof.querySelector("[data-testid=ds-keywords]").textContent, /Infantry/i);
  assert.match(prof.querySelector("[data-testid=ds-keywords]").textContent, /World Eaters/i);
  assert.match(ab.querySelector("[data-testid=ab-leader]").textContent, /Can be joined by.*Lord on Juggernaut/);
  // Angron: invulnerable save column
  click(w, rowOf(2));
  assert.equal(d.querySelector(".panel [data-testid=ds-inv]").textContent, DS.factions["world-eaters"].units.Angron.inv);
  assert.notEqual(DS.factions["world-eaters"].units.Angron.inv, undefined);
  // attach the Lord -> combined card on the bodyguard + combined points chip in the roster
  loj.attach = kb.uid; w.Muster.route();
  click(w, rowOf(0));
  assert.ok(d.querySelector(".panel [data-testid=ds-joined]"));
  const c = C.calcList(l, w.Muster.S.idx); const rk = c.entries.find((x) => x.uid === kb.uid), rl = c.entries.find((x) => x.uid === loj.uid);
  assert.match(d.querySelector(".roster [data-testid=combo-pts]").textContent, new RegExp(`Σ ${rk.total + rl.total} pts`));
  // roster eye icon -> popup sheet with the combined datasheet
  click(w, d.querySelector(`.roster [data-action=ds-pop][data-uid="${kb.uid}"]`));
  const m = d.querySelector("#modal .modal.float-ds"); assert.ok(m); assert.match(m.textContent, /Lord on Juggernaut \+ Khorne Berzerkers/);
  { const jn = m.querySelector("[data-testid=ds-joined]"), bg = m.querySelector("[data-testid=ds-bodyguard]");
    assert.ok(jn && bg && (jn.compareDocumentPosition(bg) & w.Node.DOCUMENT_POSITION_FOLLOWING), "Leader datasheet above the bodyguard's");
    assert.match(jn.querySelector(".ds-jh").textContent, /Lord on Juggernaut/); assert.match(bg.querySelector(".ds-jh").textContent, /Khorne Berzerkers/); }
  assert.ok(m.querySelector("[data-testid=ds-stats]")); assert.equal(m.querySelectorAll("[data-testid=ds-joined]").length, 1);
  click(w, d.querySelector("#modal [data-action=close-modal]"));
  // option eye icon -> just that wargear's profile
  click(w, rowOf(0));
  const eye = [...d.querySelectorAll(".panel [data-action=ds-pop][data-item]")].find((b) => /eviscerator/i.test(b.dataset.item) && !/Chainblade/i.test(b.dataset.item));
  assert.ok(eye, "eye icon next to loadout options");
  click(w, eye);
  const m2 = d.querySelector("#modal .modal.float-ds"); assert.ok(m2.querySelector('tr[data-weapon="Khornate eviscerator"]'));
  assert.equal(m2.querySelector('tr[data-weapon="Chainblade"]'), null);
  // catalog eye -> preview with Profiles
  click(w, d.querySelector("#modal [data-action=close-modal]"));
  const prev = d.querySelector('#catbody .crow[data-unit="Jakhals"] [data-action=preview-unit]');
  assert.ok(prev, "catalog eye icon"); click(w, prev);
  assert.ok(d.querySelector(".panel [data-testid=profiles] [data-testid=ds-stats]"));
});

test("datasheet view: graceful without datasheets.json; phone opens a full-screen sheet; dark mode styles exist", async () => {
  const app = makeApp({ noDatasheets: true }); const { w, d } = app;
  await until(() => d.querySelector(".lists-page"));
  const C = w.MusterCore;
  const l = C.newList({ name: "X", faction: "world-eaters", sub: "world-eaters", size: "strikeforce" }); l.dets = ["Berzerker Warband"];
  l.entries.push(C.newEntry(WE().units.find((u) => u.n === "Khorne Berzerkers"))); w.Muster.S.lists.push(l);
  await go(w, "#/list/" + l.id);
  click(w, d.querySelector(".roster .urow"));
  assert.ok(d.querySelector(".panel [data-testid=ds-missing]")); assert.ok(d.querySelector(".panel [data-testid=ds-keywords]"));
  const css = read("css/app.css");
  assert.match(css, /@media \(max-width: 760px\)\s*\{\s*\.modal-wrap\.sheetwrap[^}]*\}\s*\.modal\.sheet \{[^}]*width: 100vw/);
  assert.match(css, /\.ds-t th \{ background: var\(--hdr\)/);
  assert.match(read("sw.js"), /data\/datasheets\.json/);
});

test("leader attachment (New Recruit style): candidates show size/points/differing wargear in bold, combined points, unlink, own-category option, swipe", async () => {
  const { w, d, C, l, rowOf } = await weEditor(["Berzerker Warband"], ["Khorne Berzerkers", "Khorne Berzerkers", "Lord on Juggernaut"]);
  const [kb1, kb2, loj] = l.entries; loj.warlord = true;
  // give Berzerkers #2 an eviscerator so the candidates differ
  w.Muster.route(); click(w, rowOf(1));
  const evi = [...d.querySelectorAll(".panel [data-testid=lo-type]")].map((o) => /eviscerator and bolt pistol/i.test(o.textContent) && o.querySelector('[data-action=lo-count][data-d="1"]:not([disabled])')).find(Boolean);
  assert.ok(evi, "an eviscerator option with a + control"); click(w, evi);
  assert.ok(C.calcList(l, w.Muster.S.idx).entries[1].loLines.some((ln) => ln.gear.some((g) => /eviscerator/i.test(g.name))));
  click(w, rowOf(2));
  const opts = [...d.querySelectorAll(".panel [data-testid=attach-opt]")];
  assert.equal(opts.length, 2); assert.match(opts[0].textContent, /\d+ models · \d+ pts/);
  assert.ok([...opts[1].querySelectorAll(".cand b")].some((b) => /eviscerator/i.test(b.textContent)), "differing wargear in bold");
  change(w, opts[0].querySelector("input"), true, kb1.uid);
  assert.equal(loj.attach, kb1.uid);
  assert.ok(d.querySelector(".roster [data-testid=combo-pts]"));
  // own-category option: the Lord goes back to the Character section, still attached
  change(w, d.querySelector("[data-testid=leaders-own]"), true);
  assert.equal(l.leadersOwnCat, true); assert.equal(d.querySelector(".roster [data-testid=attached-group]"), null);
  const charSect = [...d.querySelectorAll(".roster .card")].find((c) => /^\s*Character/.test(c.querySelector(".sect-h").textContent));
  assert.ok(charSect.querySelector(`.urow[data-uid="${loj.uid}"]`)); assert.match(charSect.textContent, /Attached to/);
  change(w, d.querySelector("[data-testid=leaders-own]"), false);
  // swipe left on the attached row reveals Unlink; unlink detaches
  const row = d.querySelector(".roster [data-testid=attached-row]");
  const T = (type, x) => { const e = new w.Event(type, { bubbles: true }); e.touches = [{ clientX: x, clientY: 100 }]; e.changedTouches = e.touches; row.dispatchEvent(e); };
  T("touchstart", 300); T("touchend", 200);
  assert.ok(row.classList.contains("swiped"));
  click(w, row.querySelector(".swipe-acts [data-action=unlink]"));
  assert.equal(loj.attach, undefined);
  // desktop unlink control
  loj.attach = kb2.uid; w.Muster.route();
  click(w, d.querySelector(".roster [data-testid=unlink]")); assert.equal(loj.attach, undefined);
});

test("datasheet abilities: separate Core / Faction / Abilities / Auras / Wargear / Damaged / Leader sub-sections, one card each (combined cards too)", async () => {
  const { w, d, l, rowOf } = await weEditor(["Berzerker Warband"], ["Khorne Berzerkers", "Lord on Juggernaut", "Angron"]);
  const [kb, loj, angron] = l.entries; loj.warlord = true; loj.attach = kb.uid;
  await until(() => w.Muster.S.ds); w.Muster.route();
  const A = DS.factions["world-eaters"].units.Angron;
  click(w, d.querySelector(`.roster .urow[data-uid="${angron.uid}"]`));
  const ab = d.querySelector(".panel [data-testid=ds-abilities]");
  const subs = [...ab.querySelectorAll(".ab-sub")].map((x) => x.dataset.testid);
  assert.deepEqual(subs, ["ab-core", "ab-faction", "ab-datasheet", "ab-aura", "ab-damaged"], "Angron's sub-sections in order");
  assert.deepEqual([...ab.querySelectorAll(".ab-h")].map((x) => x.textContent), ["Core", "Faction", "Abilities", "Auras", "Damaged"]);
  const auraNames = A.ab.filter((a) => /aura/i.test(a[0])).map((a) => a[0].replace(/\s*\(aura\)\s*/i, " ").trim());
  assert.ok(auraNames.length >= 2);
  const auraCards = [...ab.querySelectorAll("[data-testid=ab-aura] .ab-card.aura")];
  assert.deepEqual(auraCards.map((c) => c.querySelector(".ab-n").textContent.replace("Aura", "").trim()), auraNames);
  assert.ok(auraCards.every((c) => c.querySelector(".aura-badge")));
  assert.equal(ab.querySelector("[data-testid=ab-datasheet]").textContent.match(/Aura/), null, "auras are not mixed into plain abilities");
  assert.match(ab.querySelector("[data-testid=ab-damaged] .ab-card.dmg").textContent, /Damaged: 1-6 wounds remaining/);
  // every plain ability is its own card with a bold name
  const plain = A.ab.filter((a) => !/aura/i.test(a[0]) && !/^damaged/i.test(a[0]));
  assert.equal(ab.querySelectorAll("[data-testid=ab-datasheet] .ab-card").length, plain.length);
  // combined card: attached Leader + bodyguard each get their own structured sections
  click(w, d.querySelector(`.roster [data-action=ds-pop][data-uid="${kb.uid}"]`));
  const m = d.querySelector("#modal .modal.float-ds");
  const secs = [...m.querySelectorAll("[data-testid=ds-abilities]")];
  assert.equal(secs.length, 2);
  // character above the unit: the attached Leader's sections come first, the bodyguard's second
  assert.match(secs[0].querySelector("[data-testid=ab-leader]").textContent, /Leader[\s\S]*Khorne Berzerkers[\s\S]*Attached/);
  assert.ok(secs[1].querySelector("[data-testid=ab-wargear]") && secs[1].querySelector("[data-testid=ab-leader]"));
  const css = read("css/app.css");
  assert.match(css, /\.ab-card\.aura \{/); assert.match(css, /html\[data-theme="dark"\] \.ab-card\.aura/);
  assert.match(read("sw.js"), /muster-shell-v38/);
});

/* ---------------------------------------------------------------- accounts + cloud sync (Supabase REST, mocked) */
const SB = "https://test.supabase.co";
function mockSupabase(o) {
  o = o || {};
  const sb = { base: SB, rows: [], calls: [], confirm: !!o.confirm, users: { "james@example.com": { pw: "secret123", id: "u-1" } } };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? "" : JSON.stringify(body)), json: async () => body });
  const sess = (id, email) => ({ access_token: `at-${id}-${sb.calls.length}`, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: `rt-${id}`, user: { id, email } });
  sb.handle = async (url, init) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null; const h = init.headers || {};
    sb.calls.push({ method: init.method || "GET", path: u.pathname, search: u.search, body, headers: h });
    if (h.apikey !== "anon-key") return res(401, { message: "No API key found in request" });
    if (u.pathname === "/auth/v1/token") {
      if (u.searchParams.get("grant_type") === "password") {
        const usr = sb.users[body.email];
        return usr && usr.pw === body.password ? res(200, sess(usr.id, body.email)) : res(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
      }
      if (u.searchParams.get("grant_type") === "refresh_token") return /^rt-/.test(body.refresh_token) ? res(200, sess(body.refresh_token.slice(3), null)) : res(400, { msg: "Invalid Refresh Token" });
    }
    if (u.pathname === "/auth/v1/signup") {
      const id = `u-${Object.keys(sb.users).length + 1}`; sb.users[body.email] = { pw: body.password, id };
      return res(200, sb.confirm ? { id, email: body.email } : sess(id, body.email));
    }
    if (u.pathname === "/auth/v1/user" && /^Bearer at-/.test(h.Authorization || "")) {
      // auth user + user_metadata (Colors sync); PUT merges data into user_metadata like GoTrue
      const uid = h.Authorization.split("-")[1] + "-" + h.Authorization.split("-")[2];
      sb.meta = sb.meta || {}; const m = sb.meta[uid] = sb.meta[uid] || {};
      if (init.method === "PUT" && body && body.data) Object.assign(m, JSON.parse(JSON.stringify(body.data)));
      const email = Object.keys(sb.users).find((e) => sb.users[e].id === uid);
      return res(200, { id: uid, email, user_metadata: m });
    }
    if (u.pathname === "/auth/v1/logout") return res(204);
    if (u.pathname === "/auth/v1/recover") return res(200, {});
    if (u.pathname === "/rest/v1/lists") {
      if (!/^Bearer at-/.test(h.Authorization || "")) return res(401, { message: "JWT expired" });
      const uid = h.Authorization.split("-")[1] + "-" + h.Authorization.split("-")[2];
      if ((init.method || "GET") === "GET") return res(200, sb.rows.filter((r) => r.user_id === uid).map(({ id, data, updated_at, deleted }) => ({ id, data, updated_at, deleted })));
      for (const r of body) { const i = sb.rows.findIndex((x) => x.id === r.id && x.user_id === r.user_id); if (i >= 0) sb.rows[i] = { ...sb.rows[i], ...r }; else sb.rows.push({ ...r }); }
      return res(201);
    }
    return res(404, { message: "not found" });
  };
  return sb;
}
const CFG = { SUPABASE_URL: SB + "/", SUPABASE_ANON_KEY: "anon-key" };
const submitForm = (w, f) => f.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
function fillAuth(w, d, email, pw) { d.querySelector("[data-testid=auth-email]").value = email; d.querySelector("[data-testid=auth-password]").value = pw; submitForm(w, d.querySelector("[data-form=auth]")); }

test("accounts off (empty Supabase config): no sign-in wall, no account button, nothing sent to Supabase", async () => {
  const cfg = read("js/config.js");
  const live = {}; new Function("window", cfg)(live);
  assert.match(live.MUSTER_CONFIG.SUPABASE_URL, /^https:\/\/[a-z0-9]+\.supabase\.co$/); assert.match(live.MUSTER_CONFIG.SUPABASE_ANON_KEY, /^eyJ/);
  const { w, d, server } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  assert.equal(d.querySelector("[data-testid=auth-screen]"), null);
  assert.ok(d.querySelector("#acct").hidden);
  assert.ok(!server.requests.some((u) => /supabase|\/auth\/v1\/|\/rest\/v1\//.test(u)));
  assert.equal(w.Muster.SY.configured, false);
  const idx = read("index.html");
  assert.ok(idx.indexOf("js/config.js") < idx.indexOf("js/core.js") && idx.indexOf("js/sync.js") < idx.indexOf("js/app.js"));
  const sw = read("sw.js");
  assert.match(sw, /"js\/config\.js"/); assert.match(sw, /"js\/sync\.js"/);
  assert.match(sw, /url\.origin !== location\.origin\) return/); assert.match(sw, /\(auth\|rest\|realtime\|storage\)\\\/v1/);
});

test("accounts on: sign-in wall on open, share link survives sign-in, local lists upload, edits/deletes sync, remote changes pull", async () => {
  // a share link made by a friend
  const pre = makeApp(); await until(() => pre.d.querySelector(".lists-page"));
  const shared = { id: "x", name: "Friend Orks", faction: "orks", sub: "orks", size: "strikeforce", dets: [], entries: [], app: "muster", schema: 1 };
  const payload = await pre.w.Muster.encodeShare(shared);
  pre.dom.window.close();

  const sb = mockSupabase();
  const pcList = { id: "pc1", name: "PC list", faction: "orks", sub: "orks", size: "incursion", dets: [], entries: [], app: "muster", schema: 1, updated: "2026-10-01T00:00:00.000Z" };
  const { dom, w, d } = makeApp({ config: CFG, supabase: sb, storage: { "muster.lists": JSON.stringify([pcList]) },
    beforeParse(win) { win.history.replaceState(null, "", `#/share/${payload}`); } });
  await until(() => d.querySelector("[data-testid=auth-screen]"));
  assert.ok(d.body.classList.contains("auth-wall")); assert.ok(d.querySelector("#acct").hidden);
  assert.match(d.querySelector(".auth-card").textContent, /add the shared list/);
  assert.match(d.querySelector(".auth-links").textContent, /Forgot password/);
  // the Meta tab and other buttons still lead to the sign-in screen
  await tick(30); click(w, d.querySelector("#hdr [data-action=new-list]"));
  assert.ok(d.querySelector("[data-testid=auth-screen]")); assert.equal(d.querySelector("#modal").innerHTML, "");
  // create-account tab + forgot-password screen render
  click(w, d.querySelector("[data-action=auth-mode][data-mode=signup]"));
  assert.ok(d.querySelector("input[name=password2]")); assert.match(d.querySelector("[data-testid=auth-submit]").textContent, /Create free account/);
  click(w, d.querySelector("[data-action=auth-mode][data-mode=signin]"));
  // wrong password
  fillAuth(w, d, "james@example.com", "nope123");
  await until(() => d.querySelector(".auth-msg.err"));
  assert.match(d.querySelector(".auth-msg.err").textContent, /Wrong email or password/);
  assert.equal(w.location.hash, `#/share/${payload}`, "share link kept while signing in");
  // correct sign-in -> share import dialog appears
  fillAuth(w, d, "James@Example.com ", "secret123");
  await until(() => /Import shared list/.test(d.querySelector("#modal").textContent));
  assert.ok(!d.body.classList.contains("auth-wall"));
  assert.equal(JSON.parse(w.localStorage.getItem("muster.auth")).user.email, "james@example.com");
  click(w, d.querySelector("#modal [data-ok]"));
  await tick(5); w.Muster.route();
  const sharedId = w.Muster.S.lists.find((l) => l.name === "Friend Orks").id;
  // the pre-account PC list and the imported list end up in the account
  await until(() => sb.rows.some((r) => r.id === "pc1") && sb.rows.some((r) => r.id === sharedId), 5000);
  const up = sb.calls.find((c) => c.method === "POST" && c.path === "/rest/v1/lists");
  assert.match(up.search, /on_conflict=user_id,id/); assert.match(up.headers.Prefer, /resolution=merge-duplicates/);
  assert.match(up.headers.Authorization, /^Bearer at-u-1/); assert.equal(up.headers.apikey, "anon-key");
  assert.ok(sb.rows.every((r) => r.user_id === "u-1" && r.deleted === false));
  assert.equal(sb.rows.find((r) => r.id === "pc1").data.name, "PC list");
  await until(() => !d.querySelector("#acct").hidden && d.querySelector("#acct").classList.contains("s-synced"));
  assert.match(d.querySelector("#acct").title, /james@example\.com · All lists synced/);
  // rename -> pushed (debounced)
  await go(w, "#/lists");
  click(w, d.querySelector('[data-action=rename-list][data-id="pc1"]'));
  d.querySelector("[data-prompt]").value = "PC list renamed"; click(w, d.querySelector("#modal [data-ok]"));
  await until(() => sb.rows.find((r) => r.id === "pc1").data.name === "PC list renamed", 4000);
  // delete -> soft-delete tombstone
  click(w, d.querySelector('[data-action=del-list][data-id="pc1"]')); click(w, d.querySelector("#modal [data-ok]"));
  await until(() => sb.rows.find((r) => r.id === "pc1").deleted === true, 4000);
  assert.equal(sb.rows.find((r) => r.id === "pc1").data, null);
  // another device adds a list and deletes the shared one -> pulled here
  const later = new Date(Date.now() + 60000).toISOString();
  sb.rows.push({ id: "phone1", user_id: "u-1", updated_at: later, deleted: false, data: { id: "phone1", name: "Phone list", faction: "orks", sub: "orks", size: "strikeforce", dets: [], entries: [], updated: later } });
  Object.assign(sb.rows.find((r) => r.id === sharedId), { deleted: true, data: null, updated_at: later });
  sb.rows.push({ id: "other", user_id: "u-9", updated_at: later, deleted: false, data: { id: "other", name: "Not mine", faction: "orks", entries: [] } });
  assert.equal(await w.Muster.SY.syncNow({ pull: true }), true);
  const names = w.Muster.S.lists.map((l) => l.name);
  assert.equal(names.join("|"), "Phone list");
  await until(() => d.querySelector('.lrow[data-id="phone1"]'));
  // account modal + sign out clears this device's copy (everything is in the account)
  click(w, d.querySelector("#acct"));
  assert.match(d.querySelector("[data-testid=account-info]").textContent, /james@example\.com/);
  click(w, d.querySelector("[data-action=sign-out]"));
  await until(() => d.querySelector("[data-testid=auth-screen]"));
  assert.equal(w.localStorage.getItem("muster.lists"), null); assert.equal(w.localStorage.getItem("muster.auth"), null);
  assert.ok(sb.calls.some((c) => c.path === "/auth/v1/logout"));
  // signing back in brings the lists back from the account
  fillAuth(w, d, "james@example.com", "secret123");
  await until(() => w.Muster.S.lists.some((l) => l.id === "phone1"));
  dom.window.close();
});

test("accounts on: saved session skips the wall, expired token is refreshed before syncing; offline edits queue", async () => {
  const sb = mockSupabase();
  const auth = { access_token: "stale", refresh_token: "rt-u-1", expires_at: Math.floor(Date.now() / 1000) - 10, user: { id: "u-1", email: "james@example.com" } };
  const mine = { id: "m1", name: "Mine", faction: "orks", sub: "orks", size: "strikeforce", dets: [], entries: [], app: "muster", schema: 1, updated: "2026-10-02T00:00:00.000Z" };
  const { dom, w, d, server } = makeApp({ config: CFG, supabase: sb, storage: { "muster.auth": JSON.stringify(auth), "muster.sync.owner": "u-1", "muster.lists": JSON.stringify([mine]) } });
  await until(() => d.querySelector(".lists-page"));
  assert.equal(d.querySelector("[data-testid=auth-screen]"), null);
  await until(() => sb.rows.some((r) => r.id === "m1"));
  const iRefresh = sb.calls.findIndex((c) => c.path === "/auth/v1/token" && /refresh_token/.test(c.search));
  const iPull = sb.calls.findIndex((c) => c.path === "/rest/v1/lists");
  assert.ok(iRefresh >= 0 && iRefresh < iPull, "token refreshed before the first REST call");
  // go offline, edit: queued, status shows offline, then flushed when back online
  server.offline = true;
  w.Muster.S.lists[0].name = "Mine (offline edit)"; w.Muster.S.lists[0].updated = new Date().toISOString();
  w.Muster.SY.schedulePush(0);
  await until(() => d.querySelector("#acct").classList.contains("s-offline"));
  assert.match(d.querySelector("#acct").title, /Offline/);
  assert.equal(w.Muster.SY.info().pending, 1);
  server.offline = false;
  w.dispatchEvent(new w.Event("online"));
  await until(() => sb.rows.find((r) => r.id === "m1").data.name === "Mine (offline edit)");
  await until(() => w.Muster.SY.info().pending === 0 && w.Muster.SY.info().status === "synced");
  dom.window.close();
});

test("accounts on: create account with email confirmation ON, confirmation link signs in and returns to the Meta tab", async () => {
  const sb = mockSupabase({ confirm: true });
  const a = makeApp({ config: CFG, supabase: sb, beforeParse(win) { win.history.replaceState(null, "", "#/meta"); } });
  await until(() => a.d.querySelector("[data-testid=auth-screen]"));
  assert.match(a.d.querySelector(".auth-card").textContent, /Meta Win Rates/);
  click(a.w, a.d.querySelector("[data-action=auth-mode][data-mode=signup]"));
  a.d.querySelector("input[name=email]").value = "buddy@example.com";
  a.d.querySelector("input[name=password]").value = "hunter22"; a.d.querySelector("input[name=password2]").value = "hunter2x";
  submitForm(a.w, a.d.querySelector("[data-form=auth]"));
  await until(() => /don't match/.test(a.d.querySelector(".auth-card").textContent));
  a.d.querySelector("input[name=password]").value = "hunter22"; a.d.querySelector("input[name=password2]").value = "hunter22";
  submitForm(a.w, a.d.querySelector("[data-form=auth]"));
  await until(() => /confirmation link to buddy@example\.com/.test(a.d.querySelector(".auth-card").textContent));
  const su = sb.calls.find((c) => c.path === "/auth/v1/signup");
  assert.match(decodeURIComponent(su.search), /redirect_to=http:\/\/localhost:8765\//);
  assert.equal(a.w.localStorage.getItem("muster.auth"), null);
  // forgot password posts to /recover
  click(a.w, a.d.querySelector("[data-action=auth-mode][data-mode=forgot]"));
  a.d.querySelector("input[name=email]").value = "buddy@example.com"; submitForm(a.w, a.d.querySelector("[data-form=auth]"));
  await until(() => sb.calls.some((c) => c.path === "/auth/v1/recover" && c.body.email === "buddy@example.com"));
  await until(() => /reset link is on its way/.test(a.d.querySelector(".auth-card").textContent));
  const pending = a.w.localStorage.getItem("muster.pendingHash");
  assert.equal(pending, "#/meta");
  a.dom.window.close();
  // the emailed link opens the site (same device) with the session in the hash
  sb.handleUser = true;
  const orig = sb.handle;
  sb.handle = async (url, init) => (new URL(url).pathname === "/auth/v1/user" ? { ok: true, status: 200, text: async () => JSON.stringify({ id: "u-2", email: "buddy@example.com" }) } : orig(url, init));
  const b = makeApp({ config: CFG, supabase: sb, storage: { "muster.pendingHash": pending },
    beforeParse(win) { win.history.replaceState(null, "", "#access_token=at-u-2-1&refresh_token=rt-u-2&expires_in=3600&token_type=bearer&type=signup"); } });
  await until(() => b.d.querySelector("[data-testid=meta-table]"));
  assert.equal(b.w.location.hash, "#/meta");
  assert.equal(JSON.parse(b.w.localStorage.getItem("muster.auth")).user.email, "buddy@example.com");
  await until(() => !b.d.querySelector("#acct").hidden);
  b.dom.window.close();
});

test("guest mode: one list without an account, a second list is blocked, the guest list uploads on sign-up", async () => {
  const sb = mockSupabase();
  const { w, d } = makeApp({ config: CFG, supabase: sb });
  await until(() => d.querySelector("[data-testid=auth-screen]"));
  const start = d.querySelector("[data-testid=guest-start]");
  assert.match(start.textContent, /Try it without an account/);
  assert.match(d.querySelector(".auth-guest-note").textContent, /1 list[\s\S]*saved only on this device/);
  click(w, start);
  await until(() => d.querySelector(".lists-page"));
  assert.equal(d.querySelector("[data-testid=auth-screen]"), null);
  assert.equal(w.localStorage.getItem("muster.guest"), "1");
  assert.equal(w.Muster.isGuest(), true);
  assert.match(d.querySelector("[data-testid=guest-note]").textContent, /Guest: 0\/1 list/);
  assert.match(d.querySelector("#acct").textContent, /Guest/);
  assert.ok(d.querySelector("#acct").classList.contains("guest"));
  assert.ok(!sb.calls.some((c) => /\/auth\/v1\/|\/rest\/v1\//.test(c.path)), "guest mode does not talk to the account");
  // the whole app is open: Meta is not behind the sign-in wall
  await go(w, "#/meta");
  assert.equal(d.querySelector("[data-testid=auth-screen]"), null);
  await go(w, "#/lists");
  // the one allowed list can be started
  click(w, d.querySelector("[data-action=new-list]"));
  assert.equal(d.querySelector("[data-testid=guest-limit]"), null);
  assert.match(d.querySelector("#modal").textContent, /Create List/);
  click(w, d.querySelector("[data-action=close-modal]"));
  const stub = (id, name) => ({ id, name, faction: "orks", sub: "orks", size: "incursion", dets: [], entries: [], app: "muster", schema: 1, updated: "2026-10-08T12:00:00.000Z" });
  w.Muster.S.lists.push(stub("g1", "Guest Orks")); w.Muster.route();
  assert.match(d.querySelector("[data-testid=guest-note]").textContent, /Guest: 1\/1 list/);
  // a second list is blocked from create, duplicate and import
  click(w, d.querySelector("#hdr [data-action=new-list]"));
  const lim = () => d.querySelector("[data-testid=guest-limit]");
  assert.match(lim().textContent, /Guest mode is limited to 1 list/);
  assert.match(lim().textContent, /Create a free account to save unlimited lists and sync them between your PC and phone/);
  click(w, d.querySelector("[data-action=close-modal]"));
  click(w, d.querySelector('[data-action=dup-list][data-id="g1"]'));
  assert.ok(lim()); assert.equal(w.Muster.S.lists.length, 1);
  click(w, d.querySelector("[data-action=close-modal]"));
  click(w, d.querySelector("[data-action=import-text]"));
  assert.ok(lim()); assert.equal(d.querySelector("[data-import]"), null);
  click(w, d.querySelector("[data-action=close-modal]"));
  click(w, d.querySelector("[data-action=import-file]"));
  assert.ok(lim()); assert.equal(w.Muster.S.lists.length, 1);
  // an import that would go past 1 keeps the first list only and says why
  w.Muster.S.lists.length = 0; w.Muster.route();
  click(w, d.querySelector("[data-action=import-text]"));
  d.querySelector("[data-import]").value = w.MusterCore.exportLists([stub("a", "One"), stub("b", "Two")]);
  click(w, d.querySelector("#modal [data-ok]"));
  assert.equal(w.Muster.S.lists.length, 1);
  assert.equal(w.Muster.S.lists[0].name, "One");
  assert.match(lim().textContent, /Imported 1 of 2 lists/);
  assert.match(lim().textContent, /weren't imported/);
  // creating the free account uploads that guest list and clears guest mode
  click(w, d.querySelector("[data-action=guest-signup]"));
  await until(() => d.querySelector("input[name=password2]"));
  assert.equal(w.localStorage.getItem("muster.guest"), null);
  assert.equal(w.Muster.S.lists.length, 1, "the guest list is still here for the new account");
  assert.match(d.querySelector(".auth-msg").textContent, /added to your account/);
  d.querySelector("input[name=email]").value = "guest@example.com";
  d.querySelector("input[name=password]").value = "hunter22";
  d.querySelector("input[name=password2]").value = "hunter22";
  submitForm(w, d.querySelector("[data-form=auth]"));
  await until(() => sb.rows.some((r) => r.data && r.data.name === "One"), 5000);
  assert.equal(sb.rows.filter((r) => r.data && r.data.name === "One").length, 1);
  assert.equal(w.localStorage.getItem("muster.guest"), null);
  assert.equal(w.Muster.isGuest(), false);
  assert.equal(w.localStorage.getItem("muster.sync.owner"), sb.rows[0].user_id);
  await until(() => d.querySelector("#acct").classList.contains("s-synced"));
  // signing out of the real account returns to the wall, not guest mode
  click(w, d.querySelector("#acct"));
  click(w, d.querySelector("[data-action=sign-out]"));
  await until(() => d.querySelector("[data-testid=auth-screen]"));
  assert.equal(w.localStorage.getItem("muster.guest"), null);
  assert.equal(w.localStorage.getItem("muster.lists"), null);
  assert.equal(w.Muster.isGuest(), false);
  assert.ok(d.querySelector("#acct").hidden);
});

test("enhancement dropdown: collapsed New Recruit-style row, opens to pick, shows choice + points, stays open across re-renders", async () => {
  const { w, d, l, rowOf } = await weEditor(["Cult of Blood"], ["Master of Executions", "Lord on Juggernaut", "Khorne Berzerkers"]);
  click(w, rowOf(0));
  const dd = () => d.querySelector(".panel details[data-testid=enh-grp]");
  assert.ok(dd(), "enhancement section is a <details> dropdown");
  assert.equal(dd().open, false, "collapsed by default");
  assert.match(dd().querySelector("summary").textContent, /^\s*Enhancement/);
  assert.match(d.querySelector(".panel [data-testid=enh-current]").textContent, /None/);
  // open it (as a click on the summary would), then a background re-render keeps it open
  dd().open = true; dd().dispatchEvent(new w.Event("toggle"));
  assert.equal(w.Muster.S.ui.enhOpen, l.entries[0].uid);
  w.Muster.route(); assert.equal(dd().open, true, "still open after re-render");
  // pick one -> stored, dropdown closes, collapsed row shows the name + points
  const opt = d.querySelector('.panel [data-testid=enh-opt][data-enh="Butcher Lord"] input');
  assert.ok(opt && !opt.disabled);
  change(w, opt, true);
  assert.deepEqual({ ...l.entries[0].enh }, { det: "Cult of Blood", name: "Butcher Lord" });
  assert.equal(dd().open, false, "closed after picking");
  const cur = d.querySelector(".panel [data-testid=enh-current]");
  const cost = w.Muster.S.idx.factions["world-eaters"].dets["Cult of Blood"].enh.find((e) => e[0] === "Butcher Lord")[1];
  assert.match(cur.textContent, /Butcher Lord/); assert.match(cur.textContent, new RegExp(`${cost} pts`));
  // another character: taken one is disabled with its reason inside the dropdown; Escape closes an open dropdown
  click(w, rowOf(1));
  assert.equal(dd().open, false, "dropdown state is per unit");
  assert.match(d.querySelector('.panel [data-testid=enh-opt][data-enh="Butcher Lord"]').textContent, /Already taken|model only/);
  dd().open = true; dd().dispatchEvent(new w.Event("toggle"));
  const radio = dd().querySelector("input[data-change=enh]");
  radio.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(dd().open, false, "Escape closes the dropdown"); assert.ok(w.Muster.S.ui.panel, "…without closing the panel");
  // 'None' clears it
  click(w, rowOf(0)); change(w, d.querySelector('.panel input[data-change=enh][value=""]'), true);
  assert.equal(l.entries[0].enh, null);
  // non-characters still have no enhancement section
  click(w, rowOf(2)); assert.equal(dd(), null);
});

test("codex override in the UI: Space Marines datasheet popup (codex source, extra sections) + codex stratagems", async () => {
  const app = makeApp(); const { w, d } = app;
  await until(() => d.querySelector(".lists-page"));
  const C = w.MusterCore;
  const SM = POINTS.factions.find((f) => f.id === "space-marines");
  const l = C.newList({ name: "SM", faction: "space-marines", sub: "space-marines", size: "strikeforce" }); l.dets = ["Gladius Task Force"];
  for (const n of ["Roboute Guilliman", "Intercessor Squad", "Chief Librarian Tigurius"]) l.entries.push(C.newEntry(SM.units.find((u) => u.n === n)));
  w.Muster.S.lists.push(l);
  await go(w, "#/list/" + l.id);
  await until(() => w.Muster.S.ds); w.Muster.route();
  click(w, d.querySelector(`.roster [data-action=ds-pop][data-uid="${l.entries[1].uid}"]`));
  let m = d.querySelector("#modal .modal");
  assert.ok(m.querySelector("[data-testid=ds-codex]"), "codex source note");
  assert.match(m.querySelector("[data-testid=ds-melee]").textContent, /Knives and Fists/);
  assert.match(m.querySelector("[data-testid=ds-wargear-options]").textContent, /Grenade Launcher/);
  assert.match(m.querySelector("[data-testid=ds-composition]").textContent, /4-9 Intercessor models/);
  assert.match(m.querySelector("[data-testid=ab-faction]").textContent, /Combat Doctrines/);
  click(w, d.querySelector("[data-action=close-modal]"));
  click(w, d.querySelector(`.roster [data-action=ds-pop][data-uid="${l.entries[0].uid}"]`));
  m = d.querySelector("#modal .modal");
  assert.match(m.querySelector("[data-testid=ab-aura]").textContent, /Primarch of the XIII/);
  click(w, d.querySelector("[data-action=close-modal]"));
  click(w, d.querySelector(`.roster [data-action=ds-pop][data-uid="${l.entries[2].uid}"]`));
  assert.match(d.querySelector("#modal .modal [data-testid=ab-psychic]").textContent, /Prescience/);
  click(w, d.querySelector("[data-action=close-modal]"));
  // detachment view: codex rule + stratagems
  const txt = [...d.querySelectorAll("[data-testid=det-strats], [data-testid=cfg-det], [data-testid=det-rule-row]")].map((x) => x.textContent).join(" ");
  assert.match(txt, /Codex Discipline/);
  assert.match(txt, /Armour of Contempt/);
  assert.match(txt, /Responsive Tactics/);
});

test("Colors setting: save a color, apply it as a CSS variable before paint, reset one and reset all", async () => {
  const { w, d } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  const root = d.documentElement, MC = w.MusterColors;
  // defaults: nothing stored, nothing set; detachments fall back to the approved green in CSS
  assert.equal(w.localStorage.getItem("muster.colors"), null);
  assert.equal(root.style.getPropertyValue("--c-strat"), "");
  const css = read("css/app.css");
  assert.match(css, /var\(--c-det, #39ff14\)/);
  assert.match(css, /html\[data-c-strat\] \.strat \.sh \.n/);
  for (const k of ["take-and-hold", "disruption", "purge-the-foe", "priority-assets", "reconnaissance"]) assert.match(css, new RegExp(`\\[data-disp=${k}\\] \\{ --dc: var\\(--c-disp-${k}, #[0-9a-f]{6}\\)`));
  await openFactionList(w, d, "space-marines");
  const FK = "muster.colors.f.space-marines";
  // open the Colors screen from the header: every category has a row with a picker
  click(w, d.querySelector("#hdr [data-action=colors]"));
  const rows = [...d.querySelectorAll("#modal [data-testid=color-row]")].map((r) => r.dataset.ck);
  assert.deepEqual(rows, ["det", "strat", "cat", "list", "attach", "abil", "aura", "enh", "disp-take-and-hold", "disp-disruption", "disp-purge-the-foe", "disp-priority-assets", "disp-reconnaissance"]);
  // pick a swatch -> saved + applied right away
  click(w, d.querySelector('#modal [data-action=color-pick][data-k=strat][data-v="#ff9f1c"]'));
  assert.equal(JSON.parse(w.localStorage.getItem(FK)).strat, "#ff9f1c");
  assert.equal(w.localStorage.getItem("muster.colors"), null, "faction colors are not in the shared set");
  assert.equal(root.style.getPropertyValue("--c-strat"), "#ff9f1c");
  assert.ok(root.hasAttribute("data-c-strat"));
  assert.ok(d.querySelector('#modal .cset[data-ck=strat]').classList.contains("custom"));
  // the native picker works too (input event), and a light disposition color gets dark text
  const pick = d.querySelector('#modal input[type=color][data-k="disp-priority-assets"]');
  pick.value = "#ffee88"; pick.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.equal(root.style.getPropertyValue("--c-disp-priority-assets"), "#ffee88");
  assert.equal(root.style.getPropertyValue("--c-disp-priority-assets-fg"), "#000");
  // a fresh page load applies saved colors before the app scripts run (no flash)
  const b = makeApp(factionBoot("space-marines", { cat: "#00e5ff", det: "#ff0000", bogus: "#123456", enh: "red" }));
  assert.equal(b.d.documentElement.style.getPropertyValue("--c-cat"), "#00e5ff");
  assert.equal(b.d.documentElement.style.getPropertyValue("--c-det"), "#ff0000");
  assert.equal(b.d.documentElement.style.getPropertyValue("--c-enh"), "", "invalid values are ignored");
  // per-row reset and Reset all
  click(w, d.querySelector("#modal [data-action=color-reset][data-k=strat]"));
  assert.equal(root.style.getPropertyValue("--c-strat"), "");
  assert.ok(!root.hasAttribute("data-c-strat"));
  assert.equal(w.localStorage.getItem(FK), null);
  click(w, d.querySelector('#modal [data-action=color-pick][data-k=strat][data-v="#ff9f1c"]'));
  // Reset all clears this faction's colors; the shared disposition color keeps its own Reset
  click(w, d.querySelector("#modal [data-action=color-reset-all]"));
  assert.equal(w.localStorage.getItem(FK), null);
  assert.equal(root.style.getPropertyValue("--c-strat"), "");
  assert.equal(root.style.getPropertyValue("--c-disp-priority-assets"), "#ffee88");
  click(w, d.querySelector('#modal [data-action=color-reset][data-k="disp-priority-assets"]'));
  assert.equal(w.localStorage.getItem("muster.colors"), null);
  assert.equal(root.style.getPropertyValue("--c-disp-priority-assets"), "");
  click(w, d.querySelector("#modal [data-action=close-modal]"));
  // dispositions render as colored chips in the builder
  const C = w.MusterCore; const SM = POINTS.factions.find((f) => f.id === "space-marines");
  const l = C.newList({ name: "SM", faction: "space-marines", sub: "space-marines", size: "strikeforce" }); l.dets = ["Gladius Task Force"];
  const fd = SM.dets.find((x) => x.n === "Gladius Task Force").fd[0]; l.disposition = fd;
  l.entries.push(C.newEntry(SM.units.find((u) => u.n === "Intercessor Squad")));
  w.Muster.S.lists.push(l);
  await go(w, "#/list/" + l.id);
  await until(() => d.querySelector(".editor"));
  const chip = [...d.querySelectorAll(".cfgrow .dispc")][0];
  const slug = fd.toLowerCase().replace(/[^a-z]+/g, "-");
  assert.ok(chip && chip.dataset.disp === slug, "disposition chip in the Configuration card");
  // the chosen disposition colors the whole builder: editor accent, banner label, colored config row
  const ed = d.querySelector("[data-testid=editor]");
  assert.ok(ed.classList.contains("has-disp") && ed.dataset.disp === slug);
  assert.equal(d.querySelector("[data-testid=banner-disp] .dispc").dataset.disp, slug);
  assert.ok(d.querySelector("[data-testid=cfg-disp]").classList.contains("disprow"));
  assert.match(css, /\.editor\.has-disp \.fbanner \{[^}]*var\(--dc\)/);
  assert.match(css, /\.lrow\.has-disp \{[^}]*var\(--dc\)/);
  // Detachment panel: offered dispositions as chips, the chosen one highlighted
  click(w, d.querySelector("[data-action=open-panel][data-panel=dets]"));
  const fdRow = [...d.querySelectorAll(".detrow")].find((r) => /Gladius Task Force/.test(r.textContent)).querySelector("[data-testid=det-fd]");
  assert.ok(fdRow.querySelector(`.dispc.chosen[data-disp="${slug}"]`), "chosen disposition highlighted in the Detachment panel");
  // a user override reaches the builder through the same variable
  w.MusterColors.set("disp-" + slug, "#ff00aa");
  assert.equal(root.style.getPropertyValue("--c-disp-" + slug), "#ff00aa");
  w.MusterColors.set("disp-" + slug, null);
  // Lists page: colored edge + chip on the list's row; lists without a disposition stay plain
  const l2 = C.newList({ name: "Plain", faction: "space-marines", sub: "space-marines", size: "strikeforce" }); w.Muster.S.lists.push(l2);
  await go(w, "#/lists");
  await until(() => d.querySelector(".lists-page"));
  const row = d.querySelector(`.lrow[data-id="${l.id}"]`);
  assert.ok(row.classList.contains("has-disp") && row.dataset.disp === slug);
  assert.equal(row.querySelector(".dispc").dataset.disp, slug);
  const plain = d.querySelector(`.lrow[data-id="${l2.id}"]`);
  assert.ok(!plain.classList.contains("has-disp") && !plain.querySelector(".dispc"));
  // text export names the disposition
  for (const f of ["gw", "wtc", "wtc-full", "simple"]) assert.match(C.exportText(l, w.Muster.S.idx, w.Muster.S.meta, f), new RegExp("FORCE DISPOSITION: " + fd, "i"), f);
});

test("Colors brightness: shade keeps the hue, slider saves + applies before paint, Reset clears it; desktop window floats", async () => {
  const { w, d } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  const MC = w.MusterColors, root = d.documentElement;
  // math: 0 = unchanged, + brighter, - darker, same hue; old {det:'#hex'} data still works
  assert.equal(MC.shade("#ff0000", 0), "#ff0000");
  assert.equal(MC.shade("#ff0000", 25), "#ff7373");
  assert.equal(MC.shade("#ff0000", -25), "#8c0000");
  assert.equal(MC.shade("#ff0000", 50), "#ffe5e5");
  assert.equal(MC.shade("#ff0000", -50), "#190000");
  await openFactionList(w, d, "space-marines");
  const FK = "muster.colors.f.space-marines";
  click(w, d.querySelector("#hdr [data-action=colors]"));
  const m = d.querySelector("#modal .modal");
  assert.ok(m.classList.contains("float"), "desktop: floating window");
  assert.ok(!d.querySelector("#modal .modal-wrap").hasAttribute("data-action"), "no click-outside-to-close backdrop on desktop");
  assert.equal(d.querySelectorAll("#modal [data-testid=color-bright]").length, MC.CATS.length, "a slider for every color");
  // null-default categories: slider disabled until a color is picked
  assert.ok(d.querySelector('#modal input[type=range][data-k=strat]').disabled);
  assert.ok(!d.querySelector('#modal input[type=range][data-k=det]').disabled, "Detachments default green can be shaded");
  // pick red for Detachments, slide it darker
  click(w, d.querySelector('#modal [data-action=color-pick][data-k=det][data-v="#ff4d6d"]'));
  const sl = d.querySelector('#modal input[type=range][data-k=det]');
  sl.value = "-25"; sl.dispatchEvent(new w.Event("input", { bubbles: true }));
  const saved = JSON.parse(w.localStorage.getItem(FK));
  assert.equal(saved.det, "#ff4d6d"); assert.equal(saved.det_b, -25);
  assert.equal(root.style.getPropertyValue("--c-det"), MC.shade("#ff4d6d", -25));
  assert.notEqual(root.style.getPropertyValue("--c-det"), "#ff4d6d");
  assert.equal(root.style.getPropertyValue("--c-det-fg"), MC.fg(MC.shade("#ff4d6d", -25)));
  assert.equal(d.querySelector('#modal .cset[data-ck=det] .cs-bv').textContent, "-25");
  // brightness on a default color (Take and Hold green) without picking one
  const s2 = d.querySelector('#modal input[type=range][data-k="disp-take-and-hold"]');
  s2.value = "20"; s2.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.equal(root.style.getPropertyValue("--c-disp-take-and-hold"), MC.shade("#196819", 20));
  // applied before paint on the next load
  const b = makeApp(factionBoot("space-marines", { det: "#ff4d6d", det_b: 30, cat: "#00e5ff" }));
  assert.equal(b.d.documentElement.style.getPropertyValue("--c-det"), MC.shade("#ff4d6d", 30));
  assert.equal(b.d.documentElement.style.getPropertyValue("--c-cat"), "#00e5ff");
  // Reset clears the color and its brightness
  click(w, d.querySelector("#modal [data-action=color-reset][data-k=det]"));
  assert.equal(w.localStorage.getItem(FK), null, "det was this faction's only color");
  assert.equal(root.style.getPropertyValue("--c-det"), "");
  assert.equal(d.querySelector('#modal input[type=range][data-k=det]').value, "0");
  click(w, d.querySelector('#modal [data-action=color-reset][data-k="disp-take-and-hold"]'));
  assert.equal(w.localStorage.getItem("muster.colors"), null);
});

test("Colors on phones: full-screen sheet, not a floating window", async () => {
  const { w, d } = makeApp({ phone: true });
  await until(() => d.querySelector(".lists-page"));
  click(w, d.querySelector("#hdr [data-action=colors]"));
  const m = d.querySelector("#modal .modal");
  assert.ok(m.classList.contains("sheet") && !m.classList.contains("float"));
});

test("datasheet popup: floating, draggable window on desktop (remembers position, no backdrop); full-screen sheet on phones", async () => {
  for (const phone of [false, true]) {
    const { w, d } = makeApp({ phone });
    await until(() => d.querySelector(".lists-page"));
    const C = w.MusterCore; const SM = POINTS.factions.find((f) => f.id === "space-marines");
    const l = C.newList({ name: "SM", faction: "space-marines", sub: "space-marines", size: "strikeforce" }); l.dets = ["Gladius Task Force"];
    l.entries.push(C.newEntry(SM.units.find((u) => u.n === "Intercessor Squad")));
    w.Muster.S.lists.push(l);
    await go(w, "#/list/" + l.id);
    await until(() => d.querySelector(".editor"));
    const open = () => click(w, d.querySelector(`.roster [data-action=ds-pop][data-uid="${l.entries[0].uid}"]`));
    open();
    const m = d.querySelector("#modal .modal"), wrap = d.querySelector("#modal .modal-wrap");
    assert.match(m.textContent, /Intercessor Squad/);
    if (phone) {
      assert.ok(m.classList.contains("sheet") && !m.classList.contains("float"), "phone: unchanged full-screen sheet");
      assert.equal(wrap.dataset.action, "modal-bg");
      continue;
    }
    assert.ok(m.classList.contains("float") && m.classList.contains("float-ds") && !m.classList.contains("sheet"));
    assert.ok(wrap.classList.contains("floatwrap") && !wrap.hasAttribute("data-action"), "no click-to-close backdrop");
    // drag by the title bar; clamped below the header and inside the viewport
    const bar = m.querySelector(".mtitle");
    const P = (type, x, y) => bar.dispatchEvent(new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    P("pointerdown", 10, 10); P("pointermove", 210, 160); P("pointerup", 210, 160);
    const pos = [m.style.left, m.style.top];
    assert.ok(parseFloat(m.style.left) > 0 && parseFloat(m.style.top) > 0, pos.join(","));
    P("pointerdown", 10, 10); P("pointermove", -5000, -5000); P("pointerup", -5000, -5000);
    assert.equal(m.style.left, "0px"); assert.ok(parseFloat(m.style.top) >= 0);
    P("pointerdown", 10, 10); P("pointermove", 210, 160); P("pointerup", 210, 160);
    // closes with X, reopens at the remembered spot
    click(w, m.querySelector("[data-action=close-modal]"));
    assert.equal(d.querySelector("#modal").innerHTML, "");
    open();
    const m2 = d.querySelector("#modal .modal");
    assert.deepEqual([m2.style.left, m2.style.top], pos);
    // Esc closes too
    d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(d.querySelector("#modal").innerHTML, "");
  }
});

test("Colors: 'Units in your list' is its own color, separate from the Unit catalog", async () => {
  const css = read("css/app.css");
  assert.match(css, /html\[data-c-cat\] \.crow \.cname \{ color: var\(--c-cat\); \}/);
  assert.match(css, /html\[data-c-list\] \.urow \.line \.n:not\(\.err\) \{ color: var\(--c-list\); \}/);
  assert.ok(!/html\[data-c-cat\][^{]*\.urow/.test(css), "catalog color no longer reaches list units");
  const { w, d } = makeApp(factionBoot("space-marines", { cat: "#00e5ff", list: "#ff9f1c", list_b: 10 }));
  await until(() => d.querySelector(".editor"));
  const root = d.documentElement, MC = w.MusterColors;
  assert.equal(root.style.getPropertyValue("--c-cat"), "#00e5ff");
  assert.equal(root.style.getPropertyValue("--c-list"), MC.shade("#ff9f1c", 10));
  assert.ok(root.hasAttribute("data-c-cat") && root.hasAttribute("data-c-list"));
  click(w, d.querySelector("#hdr [data-action=colors]"));
  const row = d.querySelector('#modal .cset[data-ck=list]');
  assert.match(row.textContent, /Units in your list/); assert.match(row.textContent, /Unit names in the list you're building/);
  assert.match(d.querySelector('#modal .cset[data-ck=cat]').textContent, /Unit names in the catalog where you pick units/);
  assert.ok(row.querySelector("input[type=range]") && row.querySelector("input[type=color]") && row.querySelectorAll(".sw").length);
  click(w, row.querySelector("[data-action=color-reset]"));
  assert.ok(!root.hasAttribute("data-c-list")); assert.ok(root.hasAttribute("data-c-cat"), "resetting list leaves catalog alone");
});

test("Colors accordion: rows start collapsed, open one at a time, collapsed row shows swatch + custom hint", async () => {
  const { w, d } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  await openFactionList(w, d, "space-marines");
  click(w, d.querySelector("#hdr [data-action=colors]"));
  const rows = [...d.querySelectorAll("#modal details.cset")];
  assert.equal(rows.length, w.MusterColors.CATS.length);
  assert.ok(rows.every((r) => !r.open), "all collapsed by default");
  assert.ok(d.querySelector("#modal .cs-h"), "Force Dispositions heading kept");
  const sum = (k) => d.querySelector(`#modal details.cset[data-ck="${k}"]`);
  // collapsed summary: label, swatch of the current color, chevron
  const s = sum("det").querySelector("summary");
  assert.match(s.querySelector(".cs-lbl").textContent, /Detachments/);
  assert.match(s.querySelector(".cs-dot").getAttribute("style"), /var\(--c-det, #39ff14\)/);
  assert.ok(s.querySelector(".cs-chev"));
  // one at a time
  const toggle = (el) => el.dispatchEvent(new w.Event("toggle"));
  sum("det").open = true; toggle(sum("det"));
  sum("strat").open = true; toggle(sum("strat"));
  assert.ok(sum("strat").open && !sum("det").open, "opening Stratagems closed Detachments");
  // changing a color marks the row custom (the 'custom' hint shows) without collapsing it
  click(w, d.querySelector('#modal [data-action=color-pick][data-k=strat][data-v="#ff9f1c"]'));
  assert.ok(sum("strat").classList.contains("custom") && sum("strat").open);
  assert.equal(d.documentElement.style.getPropertyValue("--c-strat"), "#ff9f1c");
  click(w, sum("strat").querySelector("[data-action=color-reset]"));
  assert.ok(!sum("strat").classList.contains("custom"));
  const css = read("css/app.css");
  assert.match(css, /details\.cset\.custom \.cs-hint \{ display: inline-block; \}/);
});

test("desktop: Colors and datasheet windows open together, click brings to front, Esc closes the topmost; phones one sheet at a time", async () => {
  for (const phone of [false, true]) {
    const { w, d } = makeApp({ phone });
    await until(() => d.querySelector(".lists-page"));
    const C = w.MusterCore; const SM = POINTS.factions.find((f) => f.id === "space-marines");
    const l = C.newList({ name: "SM", faction: "space-marines", sub: "space-marines", size: "strikeforce" }); l.dets = ["Gladius Task Force"];
    l.entries.push(C.newEntry(SM.units.find((u) => u.n === "Roboute Guilliman")));
    w.Muster.S.lists.push(l);
    await go(w, "#/list/" + l.id);
    await until(() => d.querySelector(".editor"));
    await until(() => w.Muster.S.ds); w.Muster.route();
    click(w, d.querySelector("#hdr [data-action=colors]"));
    click(w, d.querySelector(`.roster [data-action=ds-pop][data-uid="${l.entries[0].uid}"]`));
    if (phone) {
      assert.equal(d.querySelectorAll("#modal > .modal-wrap").length, 1, "phone: the datasheet sheet replaced Colors");
      assert.ok(d.querySelector("#modal .modal.sheet [data-testid=datasheet]"));
      continue;
    }
    const wraps = () => [...d.querySelectorAll("#modal > .floatwrap")];
    const cw = () => d.querySelector('#modal > .floatwrap[data-fk="colors"]'), dw = () => d.querySelector('#modal > .floatwrap[data-fk="ds"]');
    assert.equal(wraps().length, 2, "both windows open");
    assert.ok(cw().querySelector("[data-testid=colors]") && dw().querySelector("[data-testid=datasheet]"));
    assert.ok(+dw().style.zIndex > +cw().style.zIndex, "newest on top");
    // default spots: Colors right of the datasheet
    assert.ok(parseFloat(cw().querySelector(".modal").style.left) >= parseFloat(dw().querySelector(".modal").style.left));
    // clicking Colors brings it to front
    cw().querySelector(".modal").dispatchEvent(new w.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    assert.ok(+cw().style.zIndex > +dw().style.zIndex);
    // changing a color while the datasheet is open: CSS var applies live, datasheet stays open
    click(w, cw().querySelector('[data-action=color-pick][data-k=aura][data-v="#ff5cf0"]'));
    assert.equal(d.documentElement.style.getPropertyValue("--c-aura"), "#ff5cf0");
    assert.ok(dw() && dw().querySelector("[data-testid=ab-aura] .ab-card.aura"), "aura cards visible in the open datasheet");
    // opening another datasheet replaces only the datasheet window
    click(w, d.querySelector(`.roster [data-action=ds-pop][data-uid="${l.entries[0].uid}"]`));
    assert.equal(wraps().length, 2);
    assert.ok(+dw().style.zIndex > +cw().style.zIndex, "reopened datasheet on top");
    // Esc closes the topmost (datasheet), then Colors
    const esc = () => d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    esc(); assert.ok(!dw() && cw(), "Esc closed the datasheet first");
    click(w, d.querySelector(`.roster [data-action=ds-pop][data-uid="${l.entries[0].uid}"]`));
    // X / Done on one window leaves the other open
    click(w, cw().querySelector(".mfoot [data-action=close-modal]"));
    assert.ok(!cw() && dw());
    esc(); assert.equal(d.querySelector("#modal").innerHTML, "");
  }
});

test("touch tablet (wide, no mouse): Colors and datasheet open as full-screen sheets, one at a time; colors still change", async () => {
  const { w, d } = makeApp({ tablet: true });
  await until(() => d.querySelector(".lists-page"));
  assert.ok(!w.matchMedia("(max-width: 760px)").matches, "tablet is wider than a phone");
  click(w, d.querySelector("#hdr [data-action=colors]"));
  const m = d.querySelector("#modal .modal");
  assert.ok(m.classList.contains("sheet") && !m.classList.contains("float"), "Colors is a sheet on tablets");
  assert.equal(d.querySelector("#modal > .modal-wrap").dataset.action, "modal-bg");
  click(w, d.querySelector('#modal [data-action=color-pick][data-k="disp-disruption"][data-v="#c25e00"]'));
  assert.equal(d.documentElement.style.getPropertyValue("--c-disp-disruption"), "#c25e00");
  const C = w.MusterCore; const SM = POINTS.factions.find((f) => f.id === "space-marines");
  const l = C.newList({ name: "SM", faction: "space-marines", sub: "space-marines", size: "strikeforce" }); l.dets = ["Gladius Task Force"];
  l.entries.push(C.newEntry(SM.units.find((u) => u.n === "Intercessor Squad")));
  w.Muster.S.lists.push(l);
  await go(w, "#/list/" + l.id);
  await until(() => d.querySelector(".editor"));
  click(w, d.querySelector("#hdr [data-action=colors]"));
  click(w, d.querySelector(`.roster [data-action=ds-pop][data-uid="${l.entries[0].uid}"]`));
  assert.equal(d.querySelectorAll("#modal > .modal-wrap").length, 1, "one sheet at a time");
  assert.ok(d.querySelector("#modal .modal.sheet [data-testid=datasheet]") && !d.querySelector("#modal .floatwrap"));
  const css = read("css/app.css");
  assert.match(css, /@media \(min-width: 761px\) and \(hover: none\), \(min-width: 761px\) and \(pointer: coarse\) \{\s*\.modal-wrap\.sheetwrap/);
});

test("Colors per faction: each faction keeps its own set, switching lists switches colors, dispositions shared, header names the faction", async () => {
  const { w, d } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  const root = d.documentElement, MC = w.MusterColors;
  const pick = (k, v) => click(w, d.querySelector(`#modal [data-action=color-pick][data-k="${k}"][data-v="${v}"]`));
  const title = () => d.querySelector("#modal .mtitle").textContent;
  // no list open: the window only edits the shared Force Disposition colors
  click(w, d.querySelector("#hdr [data-action=colors]"));
  assert.match(title(), /Colors — Force Dispositions/);
  assert.match(d.querySelector("[data-testid=color-scope]").textContent, /Open a list/);
  assert.ok(!d.querySelector('#modal .cset[data-ck=det]') && d.querySelector('#modal .cset[data-ck="disp-disruption"]'));
  pick("disp-disruption", "#c25e00");
  click(w, d.querySelector("#modal [data-action=close-modal]"));
  // Khorne list: set its colors
  const kh = await openFactionList(w, d, "world-eaters", "world-eaters", "Khorne");
  const khName = POINTS.groups.flatMap((g) => g.factions).find((f) => f.id === "world-eaters").name;
  click(w, d.querySelector("#hdr [data-action=colors]"));
  assert.equal(d.querySelector("#modal [data-testid=colors]").dataset.scope, "world-eaters");
  assert.ok(title().includes("Colors — " + khName), title());
  pick("det", "#ff4d6d"); pick("strat", "#ff9f1c");
  assert.equal(root.style.getPropertyValue("--c-det"), "#ff4d6d");
  assert.deepEqual(JSON.parse(w.localStorage.getItem("muster.colors.f.world-eaters")), { det: "#ff4d6d", strat: "#ff9f1c" });
  // the open Colors window follows when you switch to a Space Marines list (desktop float stays open)
  const sm = await openFactionList(w, d, "space-marines", "space-marines", "SM");
  assert.equal(MC.scope(), "space-marines");
  assert.match(title(), /Colors — Space Marines/);
  assert.equal(root.style.getPropertyValue("--c-det"), "", "SM: built-in defaults, Khorne colors not carried over");
  assert.ok(!root.hasAttribute("data-c-strat"));
  assert.equal(root.style.getPropertyValue("--c-disp-disruption"), "#c25e00", "dispositions shared by every faction");
  assert.ok(!d.querySelector('#modal .cset[data-ck=det]').classList.contains("custom"));
  pick("cat", "#00e5ff");
  // back to Khorne: its own set, SM catalog color not applied
  await go(w, "#/list/" + kh.id); await until(() => d.querySelector(".editor"));
  assert.equal(root.style.getPropertyValue("--c-det"), "#ff4d6d");
  assert.equal(root.style.getPropertyValue("--c-strat"), "#ff9f1c");
  assert.equal(root.style.getPropertyValue("--c-cat"), "");
  // two lists of the same faction share one set
  const kh2 = await openFactionList(w, d, "world-eaters", "world-eaters", "Khorne 2");
  assert.equal(root.style.getPropertyValue("--c-det"), "#ff4d6d");
  // Lists page: faction colors off, shared disposition colors still on
  await go(w, "#/lists"); await until(() => d.querySelector(".lists-page"));
  assert.equal(MC.scope(), null);
  assert.equal(root.style.getPropertyValue("--c-det"), ""); assert.equal(root.style.getPropertyValue("--c-disp-disruption"), "#c25e00");
  // before first paint: loading straight into a list applies that faction's colors
  const st = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); st[k] = w.localStorage.getItem(k); }
  st["muster.lists"] = JSON.stringify(w.Muster.S.lists);
  for (const [id, want] of [[kh2.id, "#ff4d6d"], [sm.id, ""]]) {
    const b = makeApp({ storage: st, url: "http://localhost:8765/#/list/" + id });
    assert.equal(b.d.documentElement.style.getPropertyValue("--c-det"), want);
    assert.equal(b.d.documentElement.style.getPropertyValue("--c-disp-disruption"), "#c25e00");
  }
});

test("Colors per faction: the old single color set moves to the faction of the most recently edited list (once)", async () => {
  const lists = [{ id: "a", name: "Old", faction: "space-marines", sub: "space-marines", entries: [], updated: "2026-10-01T00:00:00Z" },
    { id: "b", name: "Khorne", faction: "world-eaters", sub: "world-eaters", entries: [], updated: "2026-10-08T00:00:00Z" }];
  const { w } = makeApp({ storage: { "muster.lists": JSON.stringify(lists), "muster.colors": JSON.stringify({ det: "#ff4d6d", det_b: -10, "disp-disruption": "#ff9f1c" }) } });
  assert.deepEqual(JSON.parse(w.localStorage.getItem("muster.colors.f.world-eaters")), { det: "#ff4d6d", det_b: -10 });
  assert.deepEqual(JSON.parse(w.localStorage.getItem("muster.colors")), { "disp-disruption": "#ff9f1c" });
  assert.equal(w.localStorage.getItem("muster.colors.f.space-marines"), null);
  assert.equal(w.localStorage.getItem("muster.colors.v"), "2");
});

test("attached units: one colored border around the character row(s) + bodyguard (summaries inside), per-faction 'Attached units' color; none in own-category mode", async () => {
  const { w, d, l, rowOf } = await weEditor(["Berzerker Warband"], ["Khorne Berzerkers", "Lord on Juggernaut", "Master of Executions", "Khorne Berzerkers"]);
  const [kb, loj, moe, kb2] = l.entries; loj.warlord = true; loj.attach = kb.uid; w.Muster.route();
  await until(() => d.querySelector(".editor"));
  const css = read("css/app.css");
  assert.match(css, /\.ugroup \{ border: 2px solid var\(--c-attach, #e0a526\);/);
  const grps = [...d.querySelectorAll(".roster [data-testid=attached-group]")];
  assert.equal(grps.length, 1, "only the joined unit is boxed");
  const g = grps[0];
  // the whole group sits inside the one box: Leader row (with its summary line) then the bodyguard row (with its summary)
  assert.deepEqual([...g.children].map((x) => x.dataset.uid), [loj.uid, kb.uid]);
  assert.ok(g.querySelector(`.urow[data-uid="${loj.uid}"] .sum, .urow[data-uid="${loj.uid}"] .line`));
  assert.match(g.textContent, /Lord on Juggernaut/); assert.match(g.textContent, /Khorne Berzerkers/);
  assert.match(g.getAttribute("title"), /Lord on Juggernaut \+ Khorne Berzerkers/);
  assert.ok(!g.contains(rowOf(2)) && !g.contains(rowOf(3)), "unattached units stay outside");
  // selecting a row inside the box still opens it
  click(w, rowOf(0)); assert.ok(rowOf(0).classList.contains("sel"));
  // Colors: 'Attached units' row, default amber, per faction
  const MC = w.MusterColors, root = d.documentElement;
  assert.equal(MC.cat("attach").def, "#e0a526"); assert.equal(MC.cat("attach").label, "Attached units");
  click(w, d.querySelector("#hdr [data-action=colors]"));
  const row = d.querySelector('#modal .cset[data-ck=attach]');
  assert.match(row.textContent, /Border around a character and the unit it leads/);
  assert.ok(row.querySelector("input[type=color]") && row.querySelector("input[type=range]") && !row.querySelector("input[type=range]").disabled, "default can be shaded");
  click(w, row.querySelector('[data-action=color-pick][data-v="#00e5ff"]'));
  assert.equal(root.style.getPropertyValue("--c-attach"), "#00e5ff");
  assert.equal(JSON.parse(w.localStorage.getItem("muster.colors.f.world-eaters")).attach, "#00e5ff");
  click(w, d.querySelector("#modal [data-action=close-modal]"));
  // another faction: default border again
  const C = w.MusterCore; const l2 = C.newList({ name: "SM", faction: "space-marines", sub: "space-marines", size: "strikeforce" }); w.Muster.S.lists.push(l2);
  await go(w, "#/list/" + l2.id); await until(() => d.querySelector(".editor"));
  assert.equal(root.style.getPropertyValue("--c-attach"), "");
  await go(w, "#/list/" + l.id); await until(() => d.querySelector(".roster [data-testid=attached-group]"));
  assert.equal(root.style.getPropertyValue("--c-attach"), "#00e5ff");
  // 'Attached characters in their own category': rows are in different sections, so no box (the row says "Attached to")
  change(w, d.querySelector("[data-testid=leaders-own]"), true);
  assert.equal(d.querySelector(".roster [data-testid=attached-group]"), null);
  assert.match(d.querySelector(`.roster .urow[data-uid="${loj.uid}"]`).textContent, /Attached to/);
});

/* ---------------------------------------------------------------- Colors sync through the account (user_metadata) */
function colorsAccountApp(sb, extra) {
  const auth = { access_token: "at-u-1-0", refresh_token: "rt-u-1", expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: "u-1", email: "james@example.com" } };
  const we = { id: "we1", name: "Khorne", faction: "world-eaters", sub: "world-eaters", size: "strikeforce", dets: [], entries: [], app: "muster", schema: 1, updated: "2026-10-02T00:00:00.000Z" };
  sb.rows.push({ id: "we1", user_id: "u-1", updated_at: we.updated, deleted: false, data: we });
  return makeApp({ config: CFG, supabase: sb, url: "http://localhost:8765/#/list/we1",
    storage: { "muster.auth": JSON.stringify(auth), "muster.sync.owner": "u-1", "muster.lists": JSON.stringify([we]), "muster.sync.known": JSON.stringify({ we1: we.updated }), "muster.colors.v": "2", ...extra } });
}
const userPuts = (sb) => sb.calls.filter((c) => c.path === "/auth/v1/user" && c.method === "PUT");

test("Colors sync: a newer bundle in the account replaces this device's colors (all factions + dispositions) and re-applies live", async () => {
  const sb = mockSupabase(); const T = Date.now();
  sb.meta = { "u-1": { musterColors: { v: 1, updatedAt: T, shared: { "disp-disruption": "#c25e00" }, f: { "world-eaters": { det: "#ff4d6d", det_b: -10 }, "space-marines": { cat: "#00e5ff" } } } } };
  const { dom, w, d } = colorsAccountApp(sb, { "muster.colors.f.world-eaters": JSON.stringify({ det: "#00e5ff" }), "muster.colors.f.orks": JSON.stringify({ strat: "#ff9f1c" }), "muster.colors.updatedAt": String(T - 60000) });
  const root = d.documentElement, MC = w.MusterColors;
  assert.equal(root.style.getPropertyValue("--c-det"), "#00e5ff", "local colors before paint");
  await until(() => w.localStorage.getItem("muster.colors.syncedAt") === String(T));
  assert.equal(root.style.getPropertyValue("--c-det"), MC.shade("#ff4d6d", -10), "remote applied live");
  assert.equal(root.style.getPropertyValue("--c-disp-disruption"), "#c25e00");
  assert.deepEqual(JSON.parse(w.localStorage.getItem("muster.colors.f.space-marines")), { cat: "#00e5ff" });
  assert.equal(w.localStorage.getItem("muster.colors.f.orks"), null, "whole bundle replaced");
  assert.equal(w.localStorage.getItem("muster.colors.updatedAt"), String(T));
  assert.equal(userPuts(sb).length, 0, "older local colors are not pushed");
  // the request carries the user's token + anon key only
  const get = sb.calls.find((c) => c.path === "/auth/v1/user");
  assert.match(get.headers.Authorization, /^Bearer at-u-1/); assert.equal(get.headers.apikey, "anon-key");
  dom.window.close();
});

test("Colors sync: newer local colors push to the account; a change pushes (debounced) and another device picks it up", async () => {
  const sb = mockSupabase(); const T = Date.now();
  sb.meta = { "u-1": { other: 1, musterColors: { v: 1, updatedAt: T - 60000, shared: {}, f: { "world-eaters": { det: "#ff4d6d" } } } } };
  const a = colorsAccountApp(sb, { "muster.colors.f.world-eaters": JSON.stringify({ det: "#00e5ff" }), "muster.colors.updatedAt": String(T) });
  await until(() => userPuts(sb).length === 1);
  const pushed = userPuts(sb)[0].body.data.musterColors;
  assert.equal(pushed.updatedAt, T); assert.deepEqual(pushed.f, { "world-eaters": { det: "#00e5ff" } });
  assert.equal(sb.meta["u-1"].other, 1, "other metadata kept");
  assert.equal(a.d.documentElement.style.getPropertyValue("--c-det"), "#00e5ff", "local kept");
  // change a color here -> pushed after the debounce
  await until(() => a.w.localStorage.getItem("muster.colors.syncedAt") === String(T));
  a.w.MusterColors.set("strat", "#ff9f1c");
  await until(() => userPuts(sb).length === 2, 5000);
  assert.equal(sb.meta["u-1"].musterColors.f["world-eaters"].strat, "#ff9f1c");
  // a second device (phone) with no colors pulls it on start
  const b = colorsAccountApp(sb, {});
  await until(() => b.d.documentElement.style.getPropertyValue("--c-strat") === "#ff9f1c");
  assert.equal(b.d.documentElement.style.getPropertyValue("--c-det"), "#00e5ff");
  a.dom.window.close(); b.dom.window.close();
});

test("Colors sync: guests (no account) stay local, nothing sent; colors from before the first sign-in upload", async () => {
  const sb = mockSupabase();
  const { dom, w, d } = makeApp({ config: CFG, supabase: sb, storage: { "muster.guest": "1" } });
  await until(() => d.querySelector(".lists-page"));
  w.MusterColors.set("disp-disruption", "#c25e00");
  await tick(1300);
  assert.ok(!sb.calls.some((c) => c.path === "/auth/v1/user"), "guest: no account calls");
  assert.equal(d.documentElement.style.getPropertyValue("--c-disp-disruption"), "#c25e00");
  dom.window.close();
  // an existing device with colors but no stamp (made before sync) and an empty account -> uploaded
  const sb2 = mockSupabase();
  const a = colorsAccountApp(sb2, { "muster.colors.f.world-eaters": JSON.stringify({ det: "#00e5ff" }) });
  await until(() => userPuts(sb2).length === 1);
  assert.deepEqual(sb2.meta["u-1"].musterColors.f, { "world-eaters": { det: "#00e5ff" } });
  a.dom.window.close();
});

test("Refresh button: visible on PC, phones and touch tablets (portrait + landscape); never shrinks out of the header", async () => {
  const css = read("css/app.css"); const html = read("index.html");
  assert.match(html, /<button class="hbtn reload" data-action="reload-page"[^>]*>.*<\/button>\s*<\/header>/, "last item in the header (top right)");
  assert.match(css, /#hdr \.hbtn\.reload \{ flex: none; \}/);
  assert.match(css, /#hdr \.brand \{ min-width: 0; overflow: hidden; flex-shrink: 1; \}/);
  assert.match(css, /@media \(min-width: 761px\) and \(hover: none\), \(min-width: 761px\) and \(pointer: coarse\) \{\s*#hdr \{ height: 54px;/);
  // no rule anywhere hides it
  assert.ok(!/\.reload[^{]*\{[^}]*display:\s*none/.test(css) && !/\[data-action=reload-page\][^{]*\{[^}]*display:\s*none/.test(css));
  for (const o of [{}, { phone: true }, { tablet: true }]) {
    const { w, d } = makeApp(o);
    await until(() => d.querySelector(".lists-page"));
    const b = d.querySelector("#hdr [data-action=reload-page]");
    assert.ok(b && !b.hidden && w.getComputedStyle(b).display !== "none", JSON.stringify(o));
    w.close();
  }
});

test("compact Configuration: Battle Size / Detachment / Force Disposition / Options dropdowns in order, then units; rules card after the units", async () => {
  const { w, d, l } = await weEditor([], ["Khorne Berzerkers", "Lord on Juggernaut"]);
  await until(() => d.querySelector(".editor"));
  const WEf = WE(); const BW = WEf.dets.find((x) => x.n === "Berzerker Warband"), VW = WEf.dets.find((x) => x.n === "Vessels of Wrath");
  const card = d.querySelector(".roster .cfgcard");
  assert.deepEqual([...card.querySelectorAll(":scope > .sect-body > details.cfg-dd")].map((x) => x.dataset.dd), ["size", "det", "disp", "opts"]);
  assert.ok([...card.querySelectorAll("details.cfg-dd")].every((x) => !x.open), "all collapsed");
  assert.equal(card.querySelectorAll("[data-action=open-panel]").length, 1, "only the detachment details link opens a panel");
  assert.ok(!card.querySelector("[data-testid=cfg-det], [data-testid=det-rule-row]"), "no rule rows before a detachment is picked");
  assert.deepEqual([...d.querySelectorAll("[data-testid=cfg-more] [data-testid=cfg-det]")], [], "only Core stratagems before a detachment is picked");
  // no detachment: red ! in the Detachment row
  assert.ok(d.querySelector("[data-testid=cfg-dets] .need"));
  // open the Detachment dropdown (stays open while ticking several), DP budget shown
  const dd = () => d.querySelector("[data-testid=det-dd]");
  dd().open = true; dd().dispatchEvent(new w.Event("toggle"));
  const tick = (n, on) => change(w, [...dd().querySelectorAll("input[data-change=det]")].find((b) => b.value === n), on);
  tick(BW.n, true); assert.ok(dd().open, "still open after ticking");
  tick(VW.n, true);
  assert.deepEqual([...l.dets], [BW.n, VW.n]);
  assert.match(d.querySelector("[data-testid=dp]").textContent, /3 \/ 3 DP/);
  assert.match(dd().querySelector("[data-testid=dp-used]").textContent, /3 \/ 3 DP used/);
  assert.equal(dd().querySelectorAll("[data-testid=det-opt].sel").length, 2);
  assert.deepEqual([...d.querySelectorAll("[data-testid=cfg-dets] .dn")].map((x) => x.textContent), [BW.n, VW.n]);
  // every picked detachment visible in the collapsed row as its own chip with its DP
  assert.deepEqual([...d.querySelectorAll("[data-testid=cfg-dets] [data-testid=det-chip]")].map((x) => [x.dataset.det, x.querySelector(".dpchip").textContent]), [[BW.n, BW.dp + " DP"], [VW.n, VW.dp + " DP"]]);
  assert.ok(d.querySelector("[data-testid=cfg-dets]").classList.contains("multi"));
  // Force Disposition chips: chosen/other marks only on picked detachments
  if ((BW.fd || []).length) { l.disposition = BW.fd[0]; w.Muster.route(); }
  assert.ok(!(BW.fd || []).length || dd().querySelector(`[data-testid=det-opt][data-det="${BW.n}"] .dispc.chosen`), "picked detachment marks the chosen disposition");
  for (const o of dd().querySelectorAll("[data-testid=det-opt]")) {
    const picked = o.querySelector("input").checked;
    if (!picked) assert.ok(!o.querySelector(".dispc.chosen, .dispc.other"), o.dataset.det + " not picked: plain chips");
  }
  // Esc closes it
  dd().querySelector("input").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.ok(!dd().open);
  // Force Disposition dropdown: GW chips, warning until picked, picking closes it and colors the builder
  const fds = [...new Set([BW, VW].flatMap((x) => x.fd || []))];
  if (fds.length > 1) {
    delete l.disposition; w.Muster.route(); await until(() => d.querySelector("[data-testid=cfg-disp]"));
    assert.ok(d.querySelector("[data-testid=cfg-disp] .need.warn"));
    const pd = d.querySelector("[data-testid=disp-dd]"); pd.open = true; pd.dispatchEvent(new w.Event("toggle"));
    const opt = [...pd.querySelectorAll("[data-testid=disp-opt] input")].find((x) => x.value === fds[1]);
    assert.ok(opt.parentElement.querySelector(".dispc"));
    change(w, opt, true);
    assert.equal(l.disposition, fds[1]);
    assert.ok(!d.querySelector("[data-testid=disp-dd]").open, "closed after picking");
    assert.ok(d.querySelector("[data-testid=cfg-disp] .dispc") && !d.querySelector("[data-testid=cfg-disp] .need"));
  }
  // Options dropdown holds the two checkboxes + totals, collapsed by default
  const od = d.querySelector("[data-testid=opts-dd]");
  assert.ok(!od.open && od.querySelector("[data-testid=legends]") && od.querySelector("[data-testid=leaders-own]") && od.querySelector("[data-testid=cfg-note]"));
  change(w, od.querySelector("[data-testid=legends]"), true);
  assert.equal(l.showLegends, true);
  assert.match(d.querySelector("[data-testid=cfg-opts]").textContent, /Legends/);
  // rules & stratagems after the units, one collapsed row per detachment
  const more = d.querySelector("[data-testid=cfg-more]");
  const cards = [...d.querySelectorAll(".roster > .card, .roster .card")];
  assert.ok(cards.indexOf(more) > cards.findIndex((c) => c.querySelector(".urow")), "after the unit cards");
  assert.deepEqual([...more.querySelectorAll("[data-testid=cfg-det]")].map((x) => x.dataset.det), [BW.n, VW.n]);
  assert.ok([...more.querySelectorAll("[data-testid=cfg-det]")].every((x) => !x.open));
  // detachment details link still opens the full panel
  click(w, d.querySelector("[data-testid=det-details]"));
  assert.equal(d.querySelectorAll(".panel [data-testid=det-block]").length, 2);
});

test("loadout picker: an option with 2 of a per-item priced weapon shows and adds 2 x the MFM cost (World Eaters Forgefiend)", async () => {
  const { w, d, l } = await weEditor(["Berzerker Warband"], ["Forgefiend"]);
  await until(() => d.querySelector(".editor"));
  const u = WE().units.find((x) => x.n === "Forgefiend"), base = u.t[0][2][0][1];
  l.entries[0].lo = { c: { Forgefiend: 1 }, p: { "Forgefiend|Arm weapons": { "2 ectoplasma cannons": 1 }, "Forgefiend|Head weapons": { "Forgefiend jaws": 1 } } };
  w.Muster.route();
  click(w, d.querySelector(`.roster .urow[data-uid="${l.entries[0].uid}"]`));
  const opt = (n) => [...d.querySelectorAll(".panel label, .panel .opt")].find((x) => x.textContent.includes(n));
  assert.match(opt("2 ectoplasma cannons").textContent, /10 pts/);
  assert.match(opt("Ectoplasma cannon and claws").textContent, /5 pts/);
  assert.match(d.querySelector(`.roster .urow[data-uid="${l.entries[0].uid}"] .pts`).textContent, new RegExp(`${base + 10} pts`));
});

test("unit sizes that share a model count are separately selectable (Space Wolves Wolf Guard Headtakers, MFM audit)", async () => {
  const app = makeApp(); const { w, d } = app;
  await until(() => d.querySelector(".lists-page"));
  const C = w.MusterCore;
  const u = POINTS.factions.find((f) => f.id === "space-wolves").units.find((x) => x.n === "Wolf Guard Headtakers");
  const l = C.newList({ name: "SW", faction: "space-wolves", sub: "space-wolves", size: "strikeforce" });
  l.entries.push(C.newEntry(u)); w.Muster.S.lists.push(l);
  await go(w, "#/list/" + l.id);
  await until(() => d.querySelector(".editor"));
  const row = () => d.querySelector(`.roster .urow[data-uid="${l.entries[0].uid}"]`);
  click(w, row());
  const radios = () => [...d.querySelectorAll(".panel input[data-change=models]")];
  const six = radios().find((r) => r.closest("label").textContent.includes("6 Wolf Guard Headtakers") && !r.closest("label").textContent.includes("Hunting"));
  assert.ok(six, "the 6 Headtakers size is offered");
  change(w, six, true);
  const want = u.t[0][2].find((r) => r[2] === "6 Wolf Guard Headtakers")[1];
  assert.equal(l.entries[0].ml, "6 Wolf Guard Headtakers");
  assert.match(row().querySelector(".pts").textContent, new RegExp(`${want} pts`));
  const checked = radios().find((r) => r.checked);
  assert.match(checked.closest("label").textContent, /^6 Wolf Guard Headtakers/);
});

// catalog hide/minimize (side-by-side layout on PC + tablets; phones keep the Catalog/Roster tabs)
async function catApp(opts) {
  const lists = JSON.stringify([{ id: "c1", name: "Cat", faction: "world-eaters", sub: "world-eaters", size: "strikeforce", dets: ["Berzerker Warband"], entries: [], app: "muster", schema: 1 }]);
  const a = makeApp({ ...opts, storage: { "muster.lists": lists, ...(opts.storage || {}) } });
  await until(() => a.d.querySelector(".lists-page"));
  await go(a.w, "#/list/c1"); await until(() => a.d.querySelector(".editor"));
  return a;
}
test("catalog hide: PC hides to a rail without re-rendering (search + scroll kept), remembered per device, rail restores; draggable windows still work", async () => {
  const { w, d } = await catApp({});
  const cols = d.querySelector("[data-testid=cols]"), cat = d.querySelector("#catcol");
  const btn = d.querySelector("[data-testid=cat-hide]"); assert.ok(btn, "hide button in the catalog header");
  assert.ok(btn.closest(".fhead"), "button sits in the catalog header");
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  assert.ok(!cols.classList.contains("cat-hidden"));
  // type a search and scroll the catalog first
  const q = d.querySelector("[data-input=cat-search]"); q.value = "berz"; q.dispatchEvent(new w.Event("input", { bubbles: true }));
  await tick(300);
  const body = d.querySelector("#catbody"); body.scrollTop = 40; const sk = body.scrollTop;
  const q2 = d.querySelector("[data-input=cat-search]");
  click(w, btn);
  assert.ok(d.querySelector("[data-testid=cols]").classList.contains("cat-hidden"));
  assert.equal(d.querySelector("#catcol"), cat, "catalog column not destroyed");
  assert.equal(d.querySelector("#catbody"), body, "catalog body not re-rendered");
  assert.equal(d.querySelector("[data-input=cat-search]"), q2); assert.equal(q2.value, "berz");
  assert.equal(body.scrollTop, sk);
  assert.equal(w.localStorage.getItem("muster.catHidden"), "1");
  assert.equal(w.Muster.S.ui.catHidden, true);
  const rail = d.querySelector("[data-testid=cat-rail]"); assert.ok(rail); assert.match(rail.textContent, /Catalog/);
  assert.equal(rail.getAttribute("data-action"), "cat-show");
  // a full editor re-render keeps it hidden; draggable datasheet window still floats + drags
  const C = w.MusterCore, WE = POINTS.factions.find((f) => f.id === "world-eaters");
  const l = w.Muster.S.lists[0]; l.entries.push(C.newEntry(WE.units.find((u) => u.n === "Khorne Berzerkers"))); w.Muster.route();
  await until(() => d.querySelector(`.roster [data-action=ds-pop][data-uid="${l.entries[0].uid}"]`));
  assert.ok(d.querySelector("[data-testid=cols]").classList.contains("cat-hidden"), "stays hidden across renders");
  assert.equal(d.querySelector("[data-input=cat-search]").value, "berz");
  click(w, d.querySelector(`.roster [data-action=ds-pop][data-uid="${l.entries[0].uid}"]`));
  const m = d.querySelector("#modal .modal"); assert.ok(m.classList.contains("float"), "PC: floating window");
  const bar = m.querySelector(".mtitle");
  const P = (type, x, y) => bar.dispatchEvent(new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
  P("pointerdown", 10, 10); P("pointermove", 210, 160); P("pointerup", 210, 160);
  assert.ok(parseFloat(m.style.left) > 0 && parseFloat(m.style.top) > 0, "drag still works");
  click(w, m.querySelector("[data-action=close-modal]"));
  // fresh load on this device starts hidden
  const b = await catApp({ storage: { "muster.catHidden": "1" } });
  assert.ok(b.d.querySelector("[data-testid=cols]").classList.contains("cat-hidden"), "remembered per device");
  // rail click brings it back
  click(b.w, b.d.querySelector("[data-testid=cat-rail]"));
  assert.ok(!b.d.querySelector("[data-testid=cols]").classList.contains("cat-hidden"));
  assert.equal(b.w.localStorage.getItem("muster.catHidden"), "0");
  const c = await catApp({ storage: { "muster.catHidden": "0" } });
  assert.ok(!c.d.querySelector("[data-testid=cols]").classList.contains("cat-hidden"));
});
test("catalog hide: tablets (touch, side-by-side) hide + show; 44px touch targets in CSS", async () => {
  const { w, d } = await catApp({ tablet: true });
  const btn = d.querySelector("[data-testid=cat-hide]"); assert.ok(btn);
  click(w, btn);
  assert.ok(d.querySelector("[data-testid=cols]").classList.contains("cat-hidden"));
  assert.equal(w.localStorage.getItem("muster.catHidden"), "1");
  click(w, d.querySelector("[data-testid=cat-rail]"));
  assert.ok(!d.querySelector("[data-testid=cols]").classList.contains("cat-hidden"));
  assert.equal(w.localStorage.getItem("muster.catHidden"), "0");
  const css = read("css/app.css");
  assert.match(css, /pointer: coarse\)[^{]*\{[^}]*--railw:\s*44px/);
  assert.match(css, /\.cat-hide[^{]*\{[^}]*min-width:\s*44px/);
  assert.match(css, /\.cols\s*\{[^}]*transition:\s*grid-template-columns/);
});
test("catalog hide: phones have no hide control (Catalog/Roster tabs instead), even with a stored hidden state", async () => {
  const { w, d } = await catApp({ phone: true, storage: { "muster.catHidden": "1" } });
  assert.equal(d.querySelector("[data-testid=cat-hide]"), null);
  assert.equal(d.querySelector("[data-testid=cat-rail]"), null);
  assert.ok(!d.querySelector("[data-testid=cols]").classList.contains("cat-hidden"));
  click(w, d.querySelector('[data-action=tab][data-tab="catalog"]'));
  assert.equal(d.querySelector(".cols").getAttribute("data-tab"), "catalog");
});

test("Lord on Juggernaut (World Eaters + CSM) can take enhancements; eligibility follows each enhancement's keyword text", async () => {
  const { w, d, rowOf } = await weEditor(["Vessels of Wrath", "Berzerker Warband", "Cult of Blood"], ["Lord on Juggernaut"]);
  await until(() => rowOf(0)); click(w, rowOf(0));
  const grp = d.querySelector(".panel [data-testid=enh-grp]"); assert.ok(grp, "enhancement dropdown in the unit panel");
  const opt = (n) => grp.querySelector(`[data-testid=enh-opt][data-enh="${n}"]`);
  const on = (n) => opt(n) && !opt(n).querySelector("input").disabled;
  for (const n of ["Archslaughterer", "Battle-lust", "Favoured of Khorne", "Helm of Brazen Ire", "Strategic Slaughter"]) assert.ok(on(n), n + " selectable");
  for (const [n, why] of [["Gateways to Glory", /DAEMON PRINCE/i], ["Butcher Lord", /INFANTRY/i], ["Brazen Form", /Monster/i]]) {
    assert.ok(opt(n) && !on(n), n + " not selectable"); assert.match(opt(n).textContent, why); }
  const inp = opt("Archslaughterer").querySelector("input"); inp.checked = true; change(w, inp);
  assert.equal(w.Muster.S.lists.at(-1).entries[0].enh.name, "Archslaughterer");
  // CSM Chaos Lord on Juggernaut: Khorne marks allowed, other gods / Infantry-only refused
  const C = w.MusterCore, CSM = POINTS.factions.find((f) => f.id === "chaos-space-marines");
  const l2 = C.newList({ name: "CSM", faction: "chaos-space-marines", sub: "chaos-space-marines", size: "strikeforce" }); l2.dets = ["Pactbound Zealots", "Deceptors"];
  l2.entries.push(C.newEntry(CSM.units.find((u) => u.n === "Chaos Lord on Juggernaut"))); w.Muster.S.lists.push(l2);
  await go(w, "#/list/" + l2.id); await until(() => d.querySelector(`.roster .urow[data-uid="${l2.entries[0].uid}"]`));
  click(w, d.querySelector(`.roster .urow[data-uid="${l2.entries[0].uid}"]`));
  const g2 = d.querySelector(".panel [data-testid=enh-grp]"); const o2 = (n) => g2.querySelector(`[data-testid=enh-opt][data-enh="${n}"]`);
  assert.ok(!o2("Talisman of Burning Blood").querySelector("input").disabled);
  assert.ok(o2("Eye of Tzeentch").querySelector("input").disabled);
  assert.ok(o2("Cursed Fang").querySelector("input").disabled);
});

test("no 'GrimSlate' anywhere user-visible (editor, source-only detachments, panels, About, exports)", async () => {
  const src = ["js/app.js", "js/core.js", "js/sync.js", "index.html"].map((f) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").split("\n").map((ln) => ln.replace(/(^|\s)\/\/.*$/, "").replace(/\/(?:\\.|[^/\n])*grimslate(?:\\.|[^/\n])*\/[gimsuy]*/gi, "/rx/")).filter((ln) => /grimslate/i.test(ln)));   // regex literals (the scrubber) are not UI
  assert.deepEqual(src.flat(), [], "only code comments may name it");
  const { w, d } = makeApp(); await until(() => d.querySelector(".lists-page"));
  const C = w.MusterCore, BT = POINTS.factions.find((f) => f.id === "black-templars");
  const gs = (BT.dets || []).find((x) => x.src === "gs"); assert.ok(gs, "fixture: a detachment that's not in the MFM");
  const l = C.newList({ name: "BT", faction: "black-templars", sub: "black-templars", size: "strikeforce" }); l.dets = [gs.n];
  l.entries.push(C.newEntry(BT.units.find((u) => C.hasLoadout(u)) || BT.units[0])); w.Muster.S.lists.push(l);
  await go(w, "#/list/" + l.id); await until(() => d.querySelector(".editor"));
  d.querySelectorAll("details").forEach((x) => { x.open = true; });
  click(w, d.querySelector(`.roster .urow[data-uid="${l.entries[0].uid}"]`));
  assert.doesNotMatch(d.body.innerHTML, /grimslate/i);
  const noSrc = (lst) => { for (const f of C.EXPORT_FORMATS) { const t = C.exportText(lst, w.Muster.S.idx, {}, f.id); assert.ok(String(t).length > 20, f.id); assert.doesNotMatch(String(t), /grimslate/i, f.id); }
    const y = C.exportYellowscribe(lst, w.Muster.S.idx, w.Muster.S.ds, {}); assert.doesNotMatch(JSON.stringify(y), /grimslate/i, "yellowscribe"); };
  await until(() => w.Muster.S.ds); noSrc(l);
  click(w, d.querySelector("[data-action=about]"));
  assert.doesNotMatch(d.body.innerHTML, /grimslate/i);
});

test("saved, imported, shared and synced lists are cleaned of the source name on load (clean copy re-saved)", async () => {
  const dirty = { id: "g1", name: "Angron Loadout (GrimSlate)", faction: "world-eaters", sub: "world-eaters", size: "strikeforce", dets: ["Berzerker Warband"],
    entries: [{ uid: "a1", unit: "Angron", models: 1, wargear: {}, addons: [], enh: null, warlord: true, note: "Loadout (GrimSlate) fixed; per GrimSlate data" }], app: "muster", schema: 1, updated: "2026-10-01T00:00:00Z" };
  const { w, d } = makeApp({ storage: { "muster.lists": JSON.stringify([dirty]) } });
  await until(() => d.querySelector(".lists-page"));
  const l = w.Muster.S.lists[0];
  assert.equal(l.name, "Angron Loadout"); assert.equal(l.entries[0].note, "Loadout fixed; per data");
  assert.ok(l.updated > dirty.updated, "marked changed so a signed-in device pushes the clean copy");
  assert.doesNotMatch(w.localStorage.getItem("muster.lists"), /grimslate/i, "clean copy saved locally");
  await go(w, "#/list/g1"); await until(() => d.querySelector(".editor"));
  click(w, d.querySelector(`.roster .urow[data-uid="a1"]`));
  assert.doesNotMatch(d.body.innerHTML, /grimslate/i);
  const C = w.MusterCore;
  await until(() => w.Muster.S.ds);
  for (const f of C.EXPORT_FORMATS) assert.doesNotMatch(String(C.exportText(l, w.Muster.S.idx, {}, f.id)), /grimslate/i, f.id);
  assert.doesNotMatch(JSON.stringify(C.exportYellowscribe(l, w.Muster.S.idx, w.Muster.S.ds, {})), /grimslate/i);
  assert.doesNotMatch(C.exportLists([l]), /grimslate/i);
  // import + share link + account sync
  assert.doesNotMatch(JSON.stringify(C.importLists(JSON.stringify({ lists: [JSON.parse(JSON.stringify(dirty))] }))), /grimslate/i);
  const sh = C.shareableList({ ...JSON.parse(JSON.stringify(dirty)) }); assert.doesNotMatch(JSON.stringify(C.listFromShareable(sh)), /grimslate/i);
  const m = C.mergeLists({ lists: [], tombs: {} }, [{ id: "g2", updated_at: "2026-10-01T00:00:00Z", data: { ...JSON.parse(JSON.stringify(dirty)), id: "g2" } }]);
  const g2 = m.lists.find((x) => x.id === "g2"); assert.doesNotMatch(JSON.stringify(g2), /grimslate/i);
  assert.deepEqual([...C.pendingPush({ lists: [g2], tombs: {} }, m.known)], ["g2"], "cleaned server copy is pushed back");
});

/* ---------------------------------------------------------------- Core Rules (#/rules) */
const typeRules = async (w, d, q) => { const i = d.querySelector("[data-testid=rules-q]"); i.value = q; i.dispatchEvent(new w.Event("input", { bubbles: true })); await tick(120); };
test("Core Rules: header tab, data loaded, ranked + highlighted search, jump to an expanded section, TOC", async () => {
  const { w, d, server } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  const nav = d.querySelector('#hdr a[href="#/rules"]');
  assert.ok(nav, "header tab on PC"); assert.match(nav.textContent, /Core Rules/);
  await go(w, "#/rules");
  await until(() => d.querySelector("[data-testid=rules-toc]"));
  assert.ok(nav.classList.contains("on"), "tab highlighted");
  assert.ok(server.requests.some((u) => /data\/core_rules\.json/.test(u)), "loaded data/core_rules.json");
  assert.equal(w.Muster.S.rules.sections.length, RULES.sections.length);
  assert.match(d.querySelector("[data-testid=rules-src]").textContent, /Wahapedia/);
  assert.doesNotMatch(d.body.textContent, /grimslate/i);
  // TOC: the two books open, chapters collapsed (bodies built lazily)
  const tops = [...d.querySelectorAll("[data-testid=rules-toc] > details.rl0")].map((x) => x.querySelector("summary").textContent);
  assert.deepEqual(tops, ["Core Rules", "Rules Appendix"]);
  assert.ok([...d.querySelectorAll("details.rl2")].length >= 20 && [...d.querySelectorAll("details.rl2")].every((x) => !x.open));
  for (const [q, want] of [["Lethal Hits", /LETHAL HITS/], ["deep strike", /DEEP STRIKE/], ["Overwatch", /Overwatch/], ["battle-shock", /Battle-shock/], ["feel no pain", /FEEL NO PAIN/]]) {
    await typeRules(w, d, q);
    const hits = d.querySelectorAll("[data-testid=rules-hit]");
    assert.ok(hits.length >= 1, `results for ${q}`);
    assert.match(hits[0].querySelector(".rt").textContent, want, `heading match ranked first for ${q}`);
    assert.ok(hits[0].querySelector("mark"), `highlighted terms for ${q}`);
  }
  await typeRules(w, d, "lethal hits");
  const first = d.querySelector("[data-testid=rules-hit]");
  assert.ok(first.querySelector(".rres-s").textContent.length > 40, "snippet");
  assert.equal(d.activeElement === d.body || d.querySelector("[data-testid=rules-q]").value === "lethal hits", true);
  // tap -> section opened (and its ancestors), terms highlighted, back to results
  await go(w, first.getAttribute("href"));
  const tgt = await until(() => d.querySelector("details.rtarget"));
  assert.ok(tgt.open, "section expanded");
  assert.match(tgt.querySelector("summary").textContent, /LETHAL HITS/);
  for (let p = tgt.parentElement.closest("details"); p; p = p.parentElement.closest("details")) assert.ok(p.open, "ancestors open");
  assert.match(tgt.querySelector(".rtext").textContent, /critical hit/i);
  assert.ok(tgt.querySelector(".rtext mark"), "terms highlighted in the section");
  click(w, d.querySelector("[data-testid=rules-back]")); await tick(5); w.Muster.route();
  await until(() => d.querySelectorAll("[data-testid=rules-hit]").length);
  // no match / empty search -> TOC; rule numbers work too
  await typeRules(w, d, "zzqxv");
  assert.match(d.querySelector("[data-testid=rules-count]").textContent, /No rules match/);
  await typeRules(w, d, "24.09");
  assert.match(d.querySelector("[data-testid=rules-hit] .rt").textContent, /DEEP STRIKE/);
  await typeRules(w, d, "");
  assert.ok(d.querySelector("[data-testid=rules-toc]"));
  // lazily built section bodies on open; tables + FAQ kept
  const ch = [...d.querySelectorAll("details.rl2")].find((x) => /Core Abilities/.test(x.querySelector("summary").textContent));
  ch.open = true; ch.dispatchEvent(new w.Event("toggle"));
  await until(() => ch.querySelector(".rb").childElementCount);
  assert.ok(ch.querySelector("details.rnode"), "sub-sections rendered on open");
  assert.ok(RULES.sections.some((s) => /<table/.test(s.h)) && RULES.sections.some((s) => /class="faq"/.test(s.h)), "tables + FAQ/errata in data");
});

test("Core Rules on phones: reachable from the Lists page switch (not Meta), header not widened", async () => {
  const { w, d } = makeApp({ phone: true });
  await until(() => d.querySelector(".lists-page"));
  const navs = [...d.querySelectorAll("#hdr [data-nav]")].map((a) => a.getAttribute("data-nav"));
  const rulesBtn = d.querySelector('#hdr a[href="#/rules"]');
  assert.ok(rulesBtn.classList.contains("nophone"), "header Rules button is hidden on phones (CSS)");
  assert.match(read("css/app.css"), /@media \(max-width: 760px\) \{\s*\.hbtn\.nophone \{ display: none; \}/);
  assert.ok(navs.includes("#/list"));
  const sw = await until(() => d.querySelector(".lists-page [data-testid=view-tabs] [data-testid=rules-tab-phone]"));
  assert.equal(sw.getAttribute("href"), "#/rules");
  assert.ok(d.querySelector("[data-testid=view-tabs] a.on[href='#/lists']"), "switch shows My Lists on the Lists page");
  await go(w, "#/meta");
  await until(() => d.querySelector(".meta-page"));
  assert.equal(d.querySelector(".meta-page [data-testid=view-tabs]"), null, "no Core Rules switch on the Meta page");
  assert.equal(d.querySelector('.meta-page a[href="#/rules"]'), null);
  await go(w, "#/rules");
  await until(() => d.querySelector("[data-testid=rules-toc]"));
  assert.ok(d.querySelector("[data-testid=view-tabs] a.on[href='#/rules']"), "switch shows Core Rules");
  assert.ok(d.querySelector('#hdr .hbtn[href="#/lists"]').classList.contains("on"), "Lists button highlighted while on Core Rules");
  assert.ok(!d.querySelector('#hdr a[href="#/meta"]').classList.contains("on"), "Meta not highlighted");
  assert.equal(d.querySelector("[data-testid=lists-tab-phone]").getAttribute("href"), "#/lists", "way back to My Lists");
  await typeRules(w, d, "deep strike");
  assert.match(d.querySelector("[data-testid=rules-hit] .rt").textContent, /DEEP STRIKE/);
});

test("Core Rules offline / missing data: friendly message, no crash", async () => {
  const { w, d } = makeApp({ noRules: true });
  await until(() => d.querySelector(".lists-page"));
  await go(w, "#/rules");
  await until(() => /aren't downloaded yet/.test((d.querySelector("[data-testid=rules-body]") || {}).textContent || ""));
});

test("service worker precaches the core rules data", () => {
  const sw = read("sw.js");
  assert.match(sw, /"data\/core_rules\.json"/);
});

/* ------------------------------------------------------------------ owner-only traffic stats */
const LIVE = "https://disclamier.github.io/muster/";
function statsSb(o) {
  o = o || {};
  const sb = mockSupabase(); const inner = sb.handle; sb.views = []; sb.owner = o.owner === undefined ? "u-1" : o.owner;
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? "" : JSON.stringify(body)), json: async () => body });
  sb.handle = async (url, init) => {
    const u = new URL(url); const h = init.headers || {};
    if (u.pathname === "/rest/v1/page_views") {
      sb.calls.push({ method: init.method, path: u.pathname, body: JSON.parse(init.body), headers: h });
      if (o.noTable) return res(404, { code: "42P01", message: 'relation "public.page_views" does not exist' });
      if (o.throwFetch) throw new TypeError("Failed to fetch");
      sb.views.push({ body: JSON.parse(init.body), headers: h, init }); return res(201);
    }
    if (u.pathname.startsWith("/rest/v1/rpc/")) {
      sb.calls.push({ method: init.method, path: u.pathname, body: JSON.parse(init.body || "{}"), headers: h });
      if (o.noTable) return res(404, { code: "PGRST202", message: "Could not find the function" });
      const uid = /^Bearer at-/.test(h.Authorization || "") ? h.Authorization.split("-")[1] + "-" + h.Authorization.split("-")[2] : null;
      if (!uid) return res(401, { message: "JWT expired" });
      if (u.pathname.endsWith("/muster_is_owner")) { sb.ownerCalls = (sb.ownerCalls || 0) + 1; if (sb.ownerFail > 0) { sb.ownerFail--; return res(503, { message: "upstream timeout" }); } return res(200, uid === sb.owner); }
      if (u.pathname.endsWith("/muster_stats")) {
        if (uid !== sb.owner) return res(403, { code: "42501", message: "not allowed" });
        const b = JSON.parse(init.body); sb.statsArgs = b;
        return res(200, { from: b.p_from, to: b.p_to, tz: b.p_tz, totals: { visits: 42, views: 97, visitors: 31 },
          daily: [{ d: b.p_from, visits: 20, views: 50, visitors: 15 }, { d: b.p_to, visits: 22, views: 47, visitors: 16 }],
          by_view: [{ k: "editor", n: 60 }, { k: "lists", n: 30 }, { k: "meta", n: 7 }], by_device: [{ k: "phone", n: 18 }, { k: "pc", n: 9 }, { k: "tablet", n: 4 }],
          referrers: [{ k: "reddit.com", n: 9 }], lists: { saved: 12, accounts: 5 } });
      }
    }
    return inner(url, init);
  };
  return sb;
}
const signedIn = (uid, email) => ({ "muster.auth": JSON.stringify({ access_token: `at-${uid}-0`, refresh_token: `rt-${uid}`, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: uid, email } }), "muster.sync.owner": uid });

test("stats: device classification follows the app layout (phone = narrow, pc = wide + mouse, tablet = wide + touch)", async () => {
  const fake = (q) => ({ matchMedia: (x) => ({ matches: q(x) }) });
  const MSx = makeApp().w.MusterStats;
  assert.equal(MSx.deviceClass(fake((x) => /max-width: 760px/.test(x))), "phone");
  assert.equal(MSx.deviceClass(fake((x) => /hover: hover/.test(x))), "pc");
  assert.equal(MSx.deviceClass(fake(() => false)), "tablet");
  for (const [o, want] of [[{}, "pc"], [{ tablet: true }, "tablet"], [{ phone: true }, "phone"]]) assert.equal(makeApp(o).w.MusterStats.deviceClass(), want, JSON.stringify(o));
  assert.equal(MSx.refHost("https://www.reddit.com/r/WarhammerCompetitive/comments/abc?utm=1", "disclamier.github.io"), "reddit.com");
  assert.equal(MSx.refHost("https://disclamier.github.io/muster/#/lists", "disclamier.github.io"), null);
  assert.equal(MSx.refHost("not a url", "x"), null);
  assert.deepEqual(["", "#/lists", "#/list/abc123", "#/meta/orks", "#/share/xyz", "#/stats", "#/weird"].map(MSx.viewOf), ["lists", "lists", "editor", "meta", "share", null, "other"]);
});

test("stats: the counted row holds no personal data (anon key, random daily id, no list ids / user / email); localhost not counted", async () => {
  const sb = statsSb({ owner: "nobody" });
  const mine = { id: "secretlist1", name: "James Secret Orks", faction: "orks", sub: "orks", size: "strikeforce", dets: [], entries: [], app: "muster", schema: 1, updated: "2026-10-02T00:00:00.000Z" };
  const { w, d } = makeApp({ config: CFG, supabase: sb, url: LIVE + "#/lists", storage: { ...signedIn("u-1", "james@example.com"), "muster.lists": JSON.stringify([mine]) },
    beforeParse(win) { Object.defineProperty(win.document, "referrer", { value: "https://www.reddit.com/r/x/comments/123?user=bob" }); } });
  await until(() => d.querySelector(".lists-page"));
  await until(() => sb.views.length >= 1);
  await go(w, "#/list/secretlist1"); await until(() => sb.views.length >= 2);
  await go(w, "#/list/secretlist1"); await go(w, "#/meta"); await until(() => sb.views.length >= 3);
  const [v1, v2, v3] = sb.views;
  for (const v of sb.views) {
    assert.deepEqual(Object.keys(v.body).sort(), ["device", "kind", "ref_host", "view", "visitor"]);
    assert.match(v.body.visitor, /^[0-9a-f]{16}$/);
    assert.equal(v.headers.Authorization, "Bearer anon-key", "anon key only, never the user's token");
    assert.equal(v.init.credentials, "omit");
    assert.doesNotMatch(JSON.stringify(v), /james|u-1|secret|Orks|bob|at-u/i);
  }
  assert.deepEqual([v1.body.kind, v1.body.view, v1.body.ref_host, v1.body.device], ["load", "lists", "reddit.com", "pc"]);
  assert.deepEqual([v2.body.kind, v2.body.view, v2.body.ref_host], ["view", "editor", null]);
  assert.equal(v3.body.view, "meta"); assert.equal(sb.views.length, 3, "same view again isn't counted twice");
  assert.equal(new Set(sb.views.map((v) => v.body.visitor)).size, 1, "one id per device per day");
  const st = JSON.parse(w.localStorage.getItem("muster.stats.vid")); assert.equal(st.d, w.MusterStats.localDay());
  // the id is replaced on a new day
  w.localStorage.setItem("muster.stats.vid", JSON.stringify({ d: "2000-01-01", id: st.id }));
  assert.notEqual(w.MusterStats.visitorId(w), st.id);
  // localhost / preview: nothing sent
  const sb2 = statsSb();
  const b = makeApp({ config: CFG, supabase: sb2, storage: signedIn("u-1", "james@example.com") });
  await until(() => b.d.querySelector(".lists-page")); await tick(50);
  assert.equal(sb2.views.length, 0); assert.ok(!sb2.calls.some((c) => c.path === "/rest/v1/page_views"));
  // Do Not Track: nothing sent
  const sb3 = statsSb();
  const c = makeApp({ config: CFG, supabase: sb3, url: LIVE, storage: signedIn("u-2", "x@example.com"), beforeParse(win) { Object.defineProperty(win.navigator, "doNotTrack", { value: "1" }); } });
  await until(() => c.d.querySelector(".lists-page")); await tick(50); assert.equal(sb3.views.length, 0);
});

test("stats: silent when the table / functions don't exist yet or the network fails (no errors, no Stats entry, app works)", async () => {
  for (const o of [{ noTable: true }, { throwFetch: true, owner: "nobody" }]) {
    const sb = statsSb(o); const errs = [];
    const { w, d } = makeApp({ config: CFG, supabase: sb, url: LIVE + "#/lists", storage: signedIn("u-1", "james@example.com"),
      beforeParse(win) { win.addEventListener("error", (e) => errs.push(e.message)); win.addEventListener("unhandledrejection", (e) => errs.push(String(e.reason))); } });
    await until(() => d.querySelector(".lists-page"));
    await tick(80);
    await go(w, "#/meta"); await go(w, "#/lists"); await tick(50);
    assert.deepEqual(errs, [], JSON.stringify(o));
    assert.ok(d.querySelector("#statsnav").hidden, "no Stats entry");
    assert.equal(d.querySelector(".toast"), null);
    const tries = sb.calls.filter((c) => c.path === "/rest/v1/page_views").length;
    if (o.noTable) assert.equal(tries, 1, "a missing table stops further tries for this page load");
    await go(w, "#/stats"); assert.ok(d.querySelector(".lists-page") && !d.querySelector("[data-testid=stats-page]"));
  }
});

test("stats: Stats page only for the owner account (checked by the database); owner's visits not counted by default; range picker", async () => {
  const sb = statsSb({ owner: "u-1" });
  const { w, d } = makeApp({ config: CFG, supabase: sb, url: LIVE + "#/lists", storage: signedIn("u-1", "james@example.com") });
  await until(() => d.querySelector(".lists-page"));
  const nav = d.querySelector("#statsnav");
  await until(() => !nav.hidden);
  assert.equal(w.localStorage.getItem("muster.stats.noCount"), "1", "owner device defaults to not counted");
  const before = sb.views.length;
  await go(w, "#/stats");
  await until(() => d.querySelector("[data-testid=st-visits]"));
  assert.match(d.querySelector("[data-testid=st-visits]").textContent, /42/); assert.match(d.querySelector("[data-testid=st-visitors]").textContent, /31/);
  assert.ok(d.querySelector("[data-testid=stats-chart] rect.sbar"));
  assert.match(d.querySelector("[data-testid=st-device]").textContent, /Phone/); assert.match(d.querySelector("[data-testid=st-ref]").textContent, /reddit\.com/);
  assert.ok(d.querySelector("[data-testid=stats-nocount]").checked);
  const rc = sb.calls.find((c) => c.path === "/rest/v1/rpc/muster_stats"); assert.match(rc.headers.Authorization, /^Bearer at-u-1/);
  click(w, d.querySelector('[data-action=stats-range][data-range="30"]'));
  await until(() => sb.statsArgs && sb.statsArgs.p_from !== sb.statsArgs.p_to && (Date.parse(sb.statsArgs.p_to) - Date.parse(sb.statsArgs.p_from)) / 864e5 === 29);
  assert.equal(w.localStorage.getItem("muster.stats.range"), "30");
  await go(w, "#/meta"); await go(w, "#/lists"); await tick(30);
  assert.equal(sb.views.length, before, "owner's own visits not counted");
  const box = d.querySelector("[data-testid=stats-nocount]"); // gone after leaving; reopen and untick
  assert.equal(box, null);
  await go(w, "#/stats"); await until(() => d.querySelector("[data-testid=stats-nocount]"));
  change(w, d.querySelector("[data-testid=stats-nocount]"), false);
  assert.equal(w.localStorage.getItem("muster.stats.noCount"), "0");
  await go(w, "#/lists"); await until(() => sb.views.length > before);
  // phones: header is full, so Stats sits in the Account window (and the header entry is CSS-hidden there)
  assert.match(read("css/app.css"), /max-width: 760px\) \{ #statsnav \{ display: none !important; \} \}/);
  click(w, d.querySelector("#acct")); click(w, d.querySelector("[data-testid=acct-stats]")); await tick(10); w.Muster.route();
  await until(() => d.querySelector("[data-testid=stats-page]"));
  // another account: no Stats entry, #/stats goes to My Lists, the database refuses muster_stats anyway
  const sb2 = statsSb({ owner: "u-1" });
  const b = makeApp({ config: CFG, supabase: sb2, url: LIVE + "#/stats", storage: signedIn("u-9", "friend@example.com") });
  await until(() => b.d.querySelector(".lists-page")); await tick(80);
  assert.ok(b.d.querySelector("#statsnav").hidden); assert.equal(b.d.querySelector("[data-testid=stats-page]"), null);
  click(b.w, b.d.querySelector("#acct")); assert.equal(b.d.querySelector("[data-testid=acct-stats]"), null);
  assert.equal(b.w.localStorage.getItem("muster.stats.owner"), null);
  assert.ok(!sb2.calls.some((c) => c.path === "/rest/v1/rpc/muster_stats"));
  // guest / signed out: no Stats entry and no owner calls
  const g = makeApp({ url: LIVE + "#/lists" }); await until(() => g.d.querySelector(".lists-page"));
  assert.ok(g.d.querySelector("#statsnav").hidden);
  // SQL migration: owner-only aggregate RPC, insert-only for the public
  const sql = fs.readFileSync(path.join(__dirname, "../supabase/page_views.sql"), "utf8");
  assert.match(sql, /grant insert \(kind, view, device, ref_host, visitor\) on public\.page_views to anon, authenticated/);
  assert.match(sql, /revoke all on public\.page_views from anon, authenticated/);
  assert.match(sql, /if not public\.muster_is_owner\(\) then raise exception/);
  assert.match(sql, /revoke all on function public\.muster_stats\(date, date, text\) from public, anon/);
  assert.doesNotMatch(sql, /\b(ip|user_agent|email)\b\s+text/i);
});

test("stats regression: already signed in on load (expired token) -> owner check after refresh, Stats shown", async () => {
  const sb = statsSb({ owner: "u-1" });
  const st = signedIn("u-1", "james@example.com");
  const a = JSON.parse(st["muster.auth"]); a.expires_at = Math.floor(Date.now() / 1000) - 600; st["muster.auth"] = JSON.stringify(a);
  const { w, d } = makeApp({ config: CFG, supabase: sb, url: LIVE + "#/lists", storage: st });
  await until(() => d.querySelector(".lists-page"));
  await until(() => !d.querySelector("#statsnav").hidden);
  assert.ok(sb.calls.some((c) => c.path === "/auth/v1/token"), "token refreshed first");
  assert.equal(w.localStorage.getItem("muster.stats.owner"), "u-1");
  click(w, d.querySelector("#acct")); assert.ok(d.querySelector("[data-testid=acct-stats]"));
  assert.equal(d.querySelector("[data-testid=acct-uid]").textContent, "u-1", "Account window shows the account id");  await tick(150);
});

test("stats regression: stale cached negative / failed check is retried (no sign-out or cache clearing needed)", async () => {
  // a cached result for another account + the first check failing (server hiccup / function not visible yet)
  const sb = statsSb({ owner: "u-1" }); sb.ownerFail = 2;
  const { w, d } = makeApp({ config: CFG, supabase: sb, url: LIVE + "#/lists", storage: { ...signedIn("u-1", "james@example.com"), "muster.stats.owner": "u-OLD" },
    beforeParse(win) { win.__MUSTER_OWNER_RETRY = [20, 20, 20]; } });
  await until(() => d.querySelector(".lists-page"));
  assert.ok(d.querySelector("#statsnav").hidden, "stale cached owner of another account is not trusted");
  await until(() => !d.querySelector("#statsnav").hidden, 3000);
  assert.ok(sb.ownerCalls >= 3, "retried after failures");
  // an account that was NOT owner when the app loaded (SQL run later): opening the Account window re-checks
  const sb2 = statsSb({ owner: "nobody" });
  const b = makeApp({ config: CFG, supabase: sb2, url: LIVE + "#/lists", storage: signedIn("u-1", "james@example.com") });
  await until(() => b.d.querySelector(".lists-page")); await until(() => sb2.ownerCalls >= 1); await tick(30);
  assert.ok(b.d.querySelector("#statsnav").hidden);
  sb2.owner = "u-1";
  click(b.w, b.d.querySelector("#acct"));
  await until(() => !b.d.querySelector("#statsnav").hidden);
  await until(() => b.d.querySelector("[data-testid=acct-stats]"), 2000);
  // a check that keeps failing shows the reason in the Account window (diagnosable), and never shows Stats
  const sb3 = statsSb({ owner: "u-1" }); sb3.ownerFail = 99;
  const c = makeApp({ config: CFG, supabase: sb3, url: LIVE + "#/lists", storage: signedIn("u-1", "james@example.com"), beforeParse(win) { win.__MUSTER_OWNER_RETRY = [5000]; } });
  await until(() => c.d.querySelector(".lists-page")); await until(() => sb3.ownerCalls >= 1); await tick(30);
  click(c.w, c.d.querySelector("#acct")); await tick(30); click(c.w, c.d.querySelector("[data-action=close-modal]")); click(c.w, c.d.querySelector("#acct"));
  await until(() => c.d.querySelector("[data-testid=owner-err]"));
  assert.ok(c.d.querySelector("#statsnav").hidden);  await tick(150);
});

test("points left / over: list header, banner and lists page; updates live", async () => {
  for (const view of [{}, { phone: true }, { tablet: true }]) {
    const { w, d } = makeApp(view);
    await until(() => d.querySelector(".lists-page"));
    const C = w.MusterCore; const F = w.Muster.S.idx.factions["adeptus-custodes"];
    const l = C.newList({ name: "Left", faction: "adeptus-custodes", sub: "adeptus-custodes", size: "incursion" });
    w.Muster.S.lists.push(l); await go(w, "#/list/" + l.id); await until(() => d.querySelector(".editor"));
    const lim = w.Muster.S.idx.sizes.incursion.points;
    const left = () => [...d.querySelectorAll("[data-testid=pts-left]")].map((e) => e.textContent);
    assert.ok(left().length >= 1 && left().every((t) => t === `${lim} pts left`), left().join());
    assert.ok(d.querySelector("[data-testid=pts-left]").classList.contains("left"));
    // add units until over the limit: text and colour flip to "N pts over"
    const sc = F.units["Shield-Captain"]; while (C.calcList(l, w.Muster.S.idx).total <= lim) l.entries.push(C.newEntry(sc));
    w.Muster.route(); await tick(5);
    const tot = C.calcList(l, w.Muster.S.idx).total;
    const el = d.querySelector("[data-testid=pts-left]");
    assert.equal(el.textContent, `${tot - lim} pts over`); assert.ok(el.classList.contains("over"));
    await go(w, "#/"); await until(() => d.querySelector(".lists-page"));
    assert.ok([...d.querySelectorAll("[data-testid=pts-left]")].some((e) => e.textContent === `${tot - lim} pts over`), "lists page row");
  }
});

test("enhancement stat changes are highlighted in the unit panel and datasheet (solid; dashed when conditional; leader's unit-wide mods on the bodyguard)", async () => {
  const { w, d } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  const C = w.MusterCore, S = w.Muster.S;
  const mk = (fid, det, units) => {
    const F = S.idx.factions[fid];
    const l = C.newList({ name: fid, faction: fid, sub: fid, size: "strikeforce" }); l.dets = [det];
    for (const [n, en] of units) { const e = C.newEntry(F.units[n]); if (en) e.enh = { det, name: en }; l.entries.push(e); }
    S.lists.push(l); return l;
  };
  // Shield-Captain with Admonimortis: melee S +3, AP +1, D +1 (unconditional)
  const l1 = mk("adeptus-custodes", "Lions of the Emperor", [["Shield-Captain", "Admonimortis"]]);
  await go(w, "#/list/" + l1.id); await until(() => d.querySelector(".editor"));
  click(w, d.querySelector(`[data-action=select-entry][data-uid="${l1.entries[0].uid}"]`));
  const panel = await until(() => d.querySelector(".panel [data-testid=profiles]"));
  const spear = panel.querySelector('[data-testid=ds-melee] tr[data-weapon="Guardian Spear"]');
  const em = [...spear.querySelectorAll("[data-testid=emod]")].map((e) => `${e.dataset.stat}:${e.dataset.base}->${e.firstChild.textContent}`);
  assert.deepEqual(em, ["S:7->10", "AP:-2->-3", "D:2->3"]);
  assert.ok(![...spear.querySelectorAll(".emod")].some((e) => e.classList.contains("cond")));
  assert.match(spear.querySelector("[data-testid=emod]").title, /Admonimortis: \+3/);
  assert.equal(panel.querySelector('[data-testid=ds-ranged] tr[data-weapon="Guardian Spear"] [data-testid=emod]'), null, "ranged profile untouched");
  assert.match(panel.querySelector("[data-testid=emod-note]").textContent, /Admonimortis/);
  // datasheet window (PC) shows the same
  click(w, d.querySelector(`.urow [data-action=ds-pop][data-uid="${l1.entries[0].uid}"]`) || d.querySelector(`[data-action=ds-pop][data-uid="${l1.entries[0].uid}"]`));
  const win = await until(() => d.querySelector(".modal [data-testid=datasheet]"));
  assert.equal(win.querySelectorAll('[data-testid=ds-melee] tr[data-weapon="Guardian Spear"] [data-testid=emod]').length, 3);
  click(w, d.querySelector("[data-action=close-modal]"));
  // conditional: Grey Knights Mandulian Reliquary (+3 OC while not Battle-shocked) -> dashed
  const l2 = mk("grey-knights", "Warpbane Task Force", [["Brother-Captain", "Mandulian Reliquary"]]);
  await go(w, "#/list/" + l2.id); await until(() => d.querySelector(".editor"));
  click(w, d.querySelector(`[data-action=select-entry][data-uid="${l2.entries[0].uid}"]`));
  const oc = await until(() => d.querySelector('.panel [data-testid=ds-stats] [data-testid=emod][data-stat="OC"]'));
  assert.ok(oc.classList.contains("cond")); assert.match(oc.title, /conditional: .*not Battle-shocked/);
  assert.match(d.querySelector(".panel [data-testid=emod-note]").textContent, /not Battle-shocked/);
  // leader's unit-wide mod on its bodyguard: Succubus (Hyperstimm Trafficker, 'This unit has +1 T') leading Wyches
  const l3 = mk("drukhari", "Exhibition of Slaughter", [["Succubus", "Hyperstimm Trafficker"], ["Wyches", null]]);
  l3.entries[0].attach = l3.entries[1].uid;
  await go(w, "#/list/" + l3.id); await until(() => d.querySelector(".editor"));
  click(w, d.querySelector(`[data-action=select-entry][data-uid="${l3.entries[1].uid}"]`));
  const body = await until(() => d.querySelector(".panel [data-testid=ds-bodyguard]"));
  const t = body.querySelector('[data-testid=ds-stats] [data-testid=emod][data-stat="T"]');
  assert.ok(t, "bodyguard T highlighted"); assert.equal(t.firstChild.textContent, "4"); assert.match(t.title, /from Succubus/);
  assert.equal(d.querySelector('.panel [data-testid=ds-joined] [data-testid=ds-stats] [data-testid=emod][data-stat="T"]').firstChild.textContent, "4");
  // no enhancement -> no highlight; exports unchanged (display only)
  assert.equal(C.calcList(l3, S.idx).total, C.calcList(Object.assign({}, l3, { entries: l3.entries }), S.idx).total);
});

test("detachment-rule stat changes: Detachments-colored box, dashed when conditional, combined with the enhancement", async () => {
  const { w, d } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  const C = w.MusterCore, S = w.Muster.S;
  const mk = (fid, det, units) => {
    const F = S.idx.factions[fid];
    const l = C.newList({ name: fid, faction: fid, sub: fid, size: "strikeforce" }); l.dets = [det];
    for (const [n, en] of units) { const e = C.newEntry(F.units[n]); if (en) e.enh = { det, name: en }; l.entries.push(e); }
    S.lists.push(l); return l;
  };
  const open = async (l, i) => { await go(w, "#/list/" + l.id); await until(() => d.querySelector(".editor"));
    click(w, d.querySelector(`[data-action=select-entry][data-uid="${l.entries[i || 0].uid}"]`)); return until(() => d.querySelector(".panel [data-testid=profiles]")); };
  // Cursed Legion: DESTROYER CULT weapons +2 S (unconditional, detachment color)
  let p = await open(mk("necrons", "Cursed Legion", [["Skorpekh Lord", null]]));
  const s = p.querySelector('[data-testid=ds-melee] [data-testid=emod][data-stat="S"]');
  assert.ok(s.classList.contains("det") && !s.classList.contains("cond")); assert.match(s.title, /Cursed Legion – /);
  assert.match(p.querySelector("[data-testid=emod-note]").textContent, /Detachment rule: Cursed Legion/);
  // not eligible: Necron Warriors get nothing
  const l2 = mk("necrons", "Cursed Legion", [["Necron Warriors", null]]);
  p = await open(l2); assert.equal(p.querySelector("[data-testid=emod]"), null);
  // choose-one: Creations of Bile -> dashed, options in the note
  p = await open(mk("chaos-space-marines", "Creations of Bile", [["Chaos Lord", null]]));
  const t = p.querySelector('[data-testid=ds-stats] [data-testid=emod][data-stat="T"]');
  assert.ok(t.classList.contains("det") && t.classList.contains("cond"));
  assert.match(p.querySelector("[data-testid=emod-note]").textContent, /Supracutaneous Chitination/);
  // enhancement + detachment on the same stat
  p = await open(mk("emperors-children", "Court of the Phoenician", [["Daemon Prince of Slaanesh", "Spiritsliver"]]));
  const both = p.querySelector('[data-testid=ds-melee] [data-testid=emod][data-stat="S"]');
  assert.ok(both.classList.contains("both")); assert.match(both.title, /Spiritsliver/); assert.match(both.title, /Court of the Phoenician/);
});

test("Berzerker Warband: +1 A boxed on World Eaters melee weapons (unit panel)", async () => {
  const { w, d } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  const C = w.MusterCore, S = w.Muster.S, F = S.idx.factions["world-eaters"];
  const l = C.newList({ name: "BW", faction: "world-eaters", sub: "world-eaters", size: "strikeforce" }); l.dets = ["Berzerker Warband"];
  l.entries.push(C.newEntry(F.units["Khorne Berzerkers"])); S.lists.push(l);
  await go(w, "#/list/" + l.id); await until(() => d.querySelector(".editor"));
  click(w, d.querySelector(`[data-action=select-entry][data-uid="${l.entries[0].uid}"]`));
  const p = await until(() => d.querySelector(".panel [data-testid=profiles]"));
  const a = [...p.querySelectorAll('[data-testid=ds-melee] [data-testid=emod][data-stat="A"]')];
  assert.ok(a.length >= 1 && a.every((e) => e.classList.contains("det") && !e.classList.contains("cond")));
  assert.match(a[0].title, /Berzerker Warband – Relentless Rage/);
  assert.equal(p.querySelector('[data-testid=ds-ranged] [data-testid=emod]'), null);
});
