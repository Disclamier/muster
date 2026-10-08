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
const WR = fs.existsSync(path.join(APP, "data/winrates.json")) ? JSON.parse(read("data/winrates.json")) : null;

function makeApp(opts) {
  opts = opts || {};
  const server = { version: { ...VERSION }, points: POINTS, winrates: WR, datasheets: opts.noDatasheets ? null : DS, offline: false, requests: [] };
  const dom = new JSDOM(HTML, {
    url: "http://localhost:8765/", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      if (opts.storage) for (const [k, v] of Object.entries(opts.storage)) w.localStorage.setItem(k, v);
      w.matchMedia = (q) => ({ matches: !!(opts.phone && /max-width/.test(q)), media: q, addEventListener() {}, removeEventListener() {} });
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      w.scrollTo = () => {};
      w.navigator.clipboard = { writeText: async (t) => { server.clipboard = t; } };
      w.URL.createObjectURL = () => "blob:x"; w.URL.revokeObjectURL = () => {};
      w.fetch = async (url) => {
        server.requests.push(String(url));
        if (server.offline) throw new TypeError("Failed to fetch");
        const p = String(url).split("?")[0];
        const body = p.endsWith("version.json") ? server.version : p.endsWith("points.json") ? server.points : p.endsWith("winrates.json") ? server.winrates : p.endsWith("datasheets.json") ? server.datasheets : null;
        if (!body) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
      };
    },
  });
  const w = dom.window;
  w.eval(read("js/core.js"));
  w.eval(read("js/app.js"));
  return { dom, w, d: w.document, server };
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
  // detachment panel
  click(w, d.querySelector("[data-testid=cfg-dets]"));
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
  assert.equal(rows.length, WR.factions.length);
  const firstWR = parseFloat(rows[0].children[1].textContent); const lastWR = parseFloat(rows[rows.length - 1].children[1].textContent);
  assert.ok(firstWR >= lastWR, "sorted by win rate desc");
  click(w, [...d.querySelectorAll("[data-testid=meta-table] th")].find((t) => /Games/.test(t.textContent)));
  const g = [...d.querySelectorAll("[data-testid=meta-table] tr.click")].map((r) => +r.children[3].textContent);
  assert.deepEqual(g, [...g].sort((a, b) => b - a));
  click(w, d.querySelector('[data-action=meta-range][data-range="4weeks"]'));
  assert.match(d.querySelector(".meta-page").textContent, /Last 4 Weeks/);
  const f = WR.factions.find((x) => x.matchups.length > 5 && x.detachments.length > 2);
  await go(w, `#/meta/${f.slug}`);
  assert.match(d.querySelector("[data-testid=meta-tiles]").textContent, /Win Rate/);
  assert.equal(d.querySelectorAll("[data-testid=det-table] tr").length - 1, f.detachments.length);
  assert.equal(d.querySelectorAll("[data-testid=matchup-table] tr").length - 1, f.matchups.length);
  click(w, d.querySelector('[data-action=det-mode][data-mode="single"]'));
  assert.equal(d.querySelectorAll("[data-testid=det-table] tr").length - 1, f.detachments_single.length);
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
  click(w, detRow);
  change(w, [...d.querySelectorAll(".panel input[data-change=det]")].find((b) => b.value === det.n), true);
  assert.ok(!d.querySelector("[data-testid=cfg-dets] .need"));
  const list = w.Muster.S.lists[0];
  if (!list.disposition) assert.ok([...d.querySelectorAll(".cfgrow")].find((r) => /Force Disposition/.test(r.textContent)).querySelector(".need"));
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
  assert.match(urow().querySelector(".sum").textContent, /1x Intercessor Sergeant: Bolt pistol, Bolt Rifle, Close combat weapon/);
  assert.ok(!/• 5 models/.test(urow().textContent));
  assert.ok(d.querySelectorAll(".panel [data-testid=lo-type]").length >= 2, "model types in the options tree");
  // sergeant weapon radio -> Plasma pistol
  const radio = [...d.querySelectorAll(".panel input[data-change=lo-pick]")].find((i) => i.dataset.key === "Intercessor Sergeant|Weapon 1" && i.dataset.opt === "Plasma pistol");
  change(w, radio, true);
  assert.match(urow().querySelector(".sum").textContent, /1x Intercessor Sergeant: Bolt pistol, Close combat weapon, Plasma pistol|Plasma pistol/);
  // upgrade model counter: grenade launcher trooper
  const inc = d.querySelector('.panel [data-action=lo-count][data-type="Intercessor w/ Grenade Launcher"][data-d="1"]');
  if (inc) { click(w, inc); const e = w.Muster.S.lists[0].entries[0]; assert.equal(e.lo.c["Intercessor w/ Grenade Launcher"], 1); assert.equal(e.lo.c.Intercessor, 3); }
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
  assert.match(gw, /  • 1x Intercessor Sergeant\n    ◦ 1x Bolt pistol/);
  assert.match(gw, /Redemptor Dreadnought \(\d+ Points\)\n  • 1x Redemptor Fist\n  • 1x Macro Plasma Incinerator/);
  change(w, d.querySelector('input[data-change=fmt][value="wtc"]'), true);
  assert.match(d.querySelector("[data-testid=export-text]").value, /x Intercessor Squad \(\d+ pts\): 1x Intercessor Sergeant: /);
  assert.ok(!/fetched 20\d\d-\d\d-\d\d/.test(d.querySelector("[data-testid=export-text]").value), "export date not raw UTC");
  // reset to default
  click(w, d.querySelector("[data-action=close-modal]"));
  click(w, d.querySelector("[data-action=lo-reset]"));
  assert.equal(C.calcList(w.Muster.S.lists[0], w.Muster.S.idx).total, before);
});

test("meta matchups: '—' rows sort last in both directions; percents always one decimal", { skip: !WR }, async () => {
  const { w, d } = makeApp();
  await until(() => d.querySelector(".lists-page")); await until(() => w.Muster.S.wr);
  const f = WR.factions.find((x) => x.matchups.some((m) => m.games < 10) && x.matchups.some((m) => m.games >= 10));
  await go(w, `#/meta/${f.slug}`);
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
  // Redemptor: "Icarus Rocket Pod" group with one same-named option has no heading
  click(w, [...d.querySelectorAll(".roster .urow")].find((x) => x.textContent.includes("Redemptor")));
  const lo = d.querySelector(".panel .loadout");
  assert.ok(lo, "loadout tree");
  const heads = [...lo.querySelectorAll(".slh")].map((x) => x.textContent.trim());
  assert.ok(!heads.some((h) => /^Icarus Rocket Pod/.test(h)), heads.join(" | "));
  assert.ok(heads.some((h) => /^Weapon Option 1/.test(h)));
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
  click(w, d.querySelector("[data-testid=cfg-dets]"));
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
  // Configuration card: one entry per detachment with rule + its stratagems
  const cfg = [...d.querySelectorAll(".roster [data-testid=cfg-det]")];
  assert.deepEqual(cfg.map((x) => x.dataset.det), [BW.n, VW.n]);
  assert.match(cfg[0].querySelector("summary").textContent, /Relentless Rage/);
  assert.match(cfg[1].querySelector("summary").textContent, /Wrath of Khorne/);
  assert.equal(cfg[0].querySelectorAll(".strat").length, BW.st.length);
  assert.equal(cfg[1].querySelectorAll(".strat").length, VW.st.length);
  // unit panel: enhancements from BOTH detachments, stratagems grouped under each detachment
  click(w, [...d.querySelectorAll(".roster .urow")].find((x) => x.textContent.includes(charU.n)));
  const enhVals = [...d.querySelectorAll(".panel input[data-change=enh]")].map((x) => x.value).filter(Boolean);
  for (const det of [BW, VW]) for (const en of det.enh) assert.ok(enhVals.includes(det.n + "||" + en[0]), `${det.n}: ${en[0]}`);
  change(w, d.querySelector(`.panel input[data-change=enh][value="${VW.n}||${VW.enh[0][0]}"]`), true);
  assert.deepEqual({ ...l.entries[0].enh }, { det: VW.n, name: VW.enh[0][0] });
  assert.equal(C.calcList(l, w.Muster.S.idx).enhancements, VW.enh[0][1]);
  const groups = [...d.querySelectorAll(".panel [data-testid=unit-strats] .stgrp")];
  assert.deepEqual(groups.map((g) => g.dataset.det), [BW.n, VW.n]);
  assert.equal(groups[0].querySelectorAll(".strat").length, BW.st.length);
  assert.equal(groups[1].querySelectorAll(".strat").length, VW.st.length);
  assert.match(groups[1].textContent, /Wrath of Khorne/);
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
  click(w, d.querySelector("[data-testid=cfg-dets]"));
  change(w, [...d.querySelectorAll(".panel input[data-change=det]")].find((b) => b.value === "Khorne Daemonkin"), false);
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
  assert.ok(grp); assert.equal(grp.querySelector(".urow").dataset.uid, kb1.uid);
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
  const m = d.querySelector("#modal .modal.sheet"); assert.ok(m); assert.match(m.textContent, /Khorne Berzerkers \+ Lord on Juggernaut/);
  assert.ok(m.querySelector("[data-testid=ds-stats]")); assert.equal(m.querySelectorAll("[data-testid=ds-joined]").length, 1);
  click(w, d.querySelector("#modal [data-action=close-modal]"));
  // option eye icon -> just that wargear's profile
  click(w, rowOf(0));
  const eye = [...d.querySelectorAll(".panel [data-action=ds-pop][data-item]")].find((b) => /eviscerator/i.test(b.dataset.item) && !/Chainblade/i.test(b.dataset.item));
  assert.ok(eye, "eye icon next to loadout options");
  click(w, eye);
  const m2 = d.querySelector("#modal .modal.sheet"); assert.ok(m2.querySelector('tr[data-weapon="Khornate eviscerator"]'));
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
  // combined card: bodyguard + attached Leader each get their own structured sections
  click(w, d.querySelector(`.roster [data-action=ds-pop][data-uid="${kb.uid}"]`));
  const m = d.querySelector("#modal .modal.sheet");
  const secs = [...m.querySelectorAll("[data-testid=ds-abilities]")];
  assert.equal(secs.length, 2);
  assert.ok(secs[0].querySelector("[data-testid=ab-wargear]") && secs[0].querySelector("[data-testid=ab-leader]"));
  assert.match(secs[1].querySelector("[data-testid=ab-leader]").textContent, /Leader[\s\S]*Khorne Berzerkers[\s\S]*Attached/);
  const css = read("css/app.css");
  assert.match(css, /\.ab-card\.aura \{/); assert.match(css, /html\[data-theme="dark"\] \.ab-card\.aura/);
  assert.match(read("sw.js"), /muster-shell-v8/);
});
