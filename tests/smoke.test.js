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
const WR = fs.existsSync(path.join(APP, "data/winrates.json")) ? JSON.parse(read("data/winrates.json")) : null;

function makeApp(opts) {
  opts = opts || {};
  const server = { version: { ...VERSION }, points: POINTS, winrates: WR, offline: false, requests: [] };
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
        const body = p.endsWith("version.json") ? server.version : p.endsWith("points.json") ? server.points : p.endsWith("winrates.json") ? server.winrates : null;
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
  const charU = weF.units.find((u) => C.isCharacter(u) && !C.isEpicHero(u) && !u.lg);
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
