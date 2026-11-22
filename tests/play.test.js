/* Play mode (James, Nov 16): Play button on a list -> read-only game view; tapping a unit shows its datasheet instead of
   editing; detachment rule + stratagems reachable; CP / round / destroyed trackers kept per list on this device; boxed back
   arrow (bottom right) returns to the editor. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { TextEncoder, TextDecoder } = require("node:util");
const APP = path.join(__dirname, "..", "app");
const read = (p) => fs.readFileSync(path.join(APP, p), "utf8");
const HTML = read("index.html").replace(/<script src="[^"]+"><\/script>/g, "");
const J = (p) => JSON.parse(read(p));
const DATA = { "version.json": J("data/version.json"), "points.json": J("data/points.json"), "datasheets.json": J("data/datasheets.json"), "core_rules.json": J("data/core_rules.json") };
function makeApp(opts) {
  opts = opts || {};
  const dom = new JSDOM(HTML, { url: "http://localhost:8765/" + (opts.hash || ""), runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      for (const [k, v] of Object.entries(opts.storage || {})) w.localStorage.setItem(k, v);
      // device can be switched mid-test (w.__setDevice) to emulate crossing the PC breakpoint; "change" listeners fire
      const dev = { phone: !!opts.phone, touch: !!(opts.phone || opts.tablet) }, ls = [];
      const mq = (q) => /max-width/.test(q) ? dev.phone : /hover: hover/.test(q) ? !dev.touch : /hover: none|pointer: coarse/.test(q) ? dev.touch : false;
      w.matchMedia = (q) => ({ get matches() { return mq(q); }, media: q, addEventListener(t, f) { ls.push(f); }, removeEventListener() {} });
      w.__setDevice = (o) => { Object.assign(dev, o); ls.forEach((f) => f({})); };
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder; w.scrollTo = () => {};
      w.fetch = async (url) => { const k = Object.keys(DATA).find((x) => String(url).split("?")[0].endsWith(x)); return k ? { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(DATA[k])) } : { ok: false, status: 404, json: async () => ({}) }; };
    } });
  const w = dom.window;
  w.eval(read("js/config.js")); w.MUSTER_CONFIG = { SUPABASE_URL: "", SUPABASE_ANON_KEY: "" };
  for (const f of ["core", "sync", "stats", "app"]) w.eval(read(`js/${f}.js`));
  return { w, d: w.document };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 4000)) { const v = fn(); if (v) return v; await tick(10); } throw new Error("timeout"); }
const click = (w, el) => { assert.ok(el, "element exists"); el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true })); };
const go = async (w, hash) => { w.location.hash = hash; await tick(5); w.Muster.route(); };

function necronList(w) {
  const C = w.MusterCore, S = w.Muster.S, F = S.idx.factions.necrons;
  const ch = F.f.units.find((u) => u.r === "Character" && !u.lg && u.ldr && u.ldr.length && F.units[u.ldr[0]] ? true : false) || F.f.units.find((u) => u.r === "Character" && !u.lg);
  const bl = F.f.units.find((u) => u.r === "Battleline" && !u.lg);
  const l = C.newList({ name: "Play Crons", faction: "necrons", sub: "necrons", size: "strikeforce" });
  const det = F.f.dets.find((x) => x.src === "mfm" && x.st.length && x.rule);
  l.dets = [det.n];
  const e1 = C.newEntry(F.units[ch.n]); e1.warlord = true; const e2 = C.newEntry(F.units[bl.n]);
  l.entries.push(e1, e2); S.lists.push(l);
  return { l, ch, bl, det, e1, e2 };
}

test("tablet: Play button opens a read-only game view; tapping a unit shows its datasheet, not the editor", async () => {
  const { w, d } = makeApp({ tablet: true });
  await until(() => d.querySelector(".lists-page"));
  const { l, ch, bl, det, e1, e2 } = necronList(w);
  await go(w, "#/list/" + l.id);
  await until(() => d.querySelector(".editor"));
  click(w, d.querySelector("[data-testid=play-btn]"));
  await tick(5); w.Muster.route();
  await until(() => d.querySelector("[data-testid=play]"));
  assert.match(w.location.hash, /\/play$/);
  assert.ok(!d.body.classList.contains("app-fixed"), "play view scrolls like a page");
  const rows = [...d.querySelectorAll("[data-testid=play-row]")];
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.textContent.includes(ch.n) && /Warlord/.test(r.textContent)));
  assert.ok(d.querySelectorAll("[data-testid=play-stats]").length >= 1, "statline on rows");
  // no editing controls in play
  assert.equal(d.querySelectorAll("[data-action=del-entry], [data-action=add-unit], .catalog").length, 0);
  // detachment rule + stratagems + core stratagems reachable
  const dets = d.querySelector("[data-testid=play-dets]");
  assert.match(dets.textContent, new RegExp(det.rule[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(dets.textContent, /Stratagems \(\d+\)/);
  assert.ok(d.querySelector("[data-testid=play-core]"));
  // tap a unit -> datasheet window with its stratagems, no list-building sections
  click(w, rows.find((r) => r.textContent.includes(bl.n)));
  const ds = await until(() => d.querySelector("#modal [data-testid=play-ds]"));
  assert.ok(ds.querySelector("[data-testid=datasheet]"));
  assert.ok(ds.querySelector("[data-testid=ds-stats]"));
  assert.equal(ds.querySelector("[data-testid=ds-wargear-options]"), null);
  assert.ok(!/Points \(MFM\)/.test(ds.textContent));
  assert.equal(w.Muster.S.lists.find((x) => x.id === l.id).entries.length, 2, "tapping never adds/edits");
  // trackers persist per list
  click(w, d.querySelector("[data-action=play-cp][data-d='1']"));
  click(w, d.querySelector("[data-action=play-cp][data-d='1']"));
  click(w, d.querySelector("[data-action=play-round][data-d='1']"));
  click(w, d.querySelector(`[data-action=play-dead][data-uid="${e2.uid}"]`));
  assert.equal(d.querySelector("[data-testid=play-cp-v]").textContent, "2");
  assert.equal(d.querySelector("[data-testid=play-round-v]").textContent, "2");
  assert.ok(d.querySelector(`[data-testid=play-row][data-uid="${e2.uid}"]`).classList.contains("dead"));
  const st = JSON.parse(w.localStorage.getItem("muster.play"))[l.id];
  assert.deepEqual(st, { cp: 2, round: 2, dead: [e2.uid] });
  assert.ok(!JSON.stringify(w.Muster.S.lists).includes('"cp"'), "game state is not stored in the list");
  // boxed back arrow bottom right -> editor
  const back = d.querySelector(".play > .backfab[data-action=play-exit]");
  assert.ok(back && back.querySelector("use").getAttribute("href") === "#i-back");
  click(w, back); await tick(5); w.Muster.route();
  await until(() => d.querySelector(".editor"));
  assert.equal(w.location.hash, "#/list/" + l.id);
  void e1;
});

test("Play on phone: Units / Rules tabs, list-row Play button, Escape returns to the editor", async () => {
  const { w, d } = makeApp({ phone: true });
  await until(() => d.querySelector(".lists-page"));
  const { l } = necronList(w);
  w.Muster.route();
  click(w, d.querySelector(`[data-testid=list-play][data-id="${l.id}"]`));
  await tick(5); w.Muster.route();
  await until(() => d.querySelector("[data-testid=play]"));
  assert.equal(d.querySelector(".pcols").dataset.tab, "units");
  click(w, d.querySelector("[data-testid=play-tab-rules]"));
  assert.equal(d.querySelector(".pcols").dataset.tab, "rules");
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick(5); w.Muster.route();
  await until(() => d.querySelector(".editor"));
});

test("Play assets: icon, styles, service worker bump", () => {
  assert.match(read("index.html"), /<symbol id="i-play"/);
  const css = read("css/app.css");
  assert.match(css, /\.backfab\.playback \{ position: fixed; right: max\(14px/);
  assert.match(css, /html\[data-c-list\] \.prow \.pl1 \.n \{ color: var\(--c-list\); \}/);
  assert.match(read("sw.js"), /muster-shell-v73/);
});

test("PC (wide + mouse) looks like v70: no Play button, no list-row Play, #/list/<id>/play opens the editor", async () => {
  const { w, d } = makeApp();
  await until(() => d.querySelector(".lists-page"));
  const { l } = necronList(w);
  w.Muster.route();
  assert.equal(d.querySelector("[data-testid=list-play]"), null);
  await go(w, "#/list/" + l.id);
  await until(() => d.querySelector(".editor"));
  assert.equal(d.querySelector("[data-testid=play-btn]"), null);
  assert.equal(d.querySelectorAll(".editor .titlebar .act").length, 2, "Export + Options only, as in v70");
  await go(w, "#/list/" + l.id + "/play");
  assert.ok(d.querySelector(".editor"));
  assert.equal(d.querySelector("[data-testid=play]"), null);
  assert.equal(w.location.hash, "#/list/" + l.id);
  assert.ok(d.body.classList.contains("app-fixed"));
});

test("crossing the PC breakpoint: Play view exits to the editor on PC, Play button comes back on tablet", async () => {
  const { w, d } = makeApp({ tablet: true });
  await until(() => d.querySelector(".lists-page"));
  const { l, e2 } = necronList(w);
  await go(w, "#/list/" + l.id + "/play");
  await until(() => d.querySelector("[data-testid=play]"));
  click(w, d.querySelector(`[data-testid=play-row][data-uid="${e2.uid}"]`));
  await until(() => d.querySelector("#modal [data-testid=play-ds]"));
  w.__setDevice({ touch: false });            // window becomes a PC
  await until(() => d.querySelector(".editor"));
  assert.equal(w.location.hash, "#/list/" + l.id);
  assert.equal(d.querySelector("[data-testid=play-btn]"), null);
  assert.equal(d.querySelector("#modal [data-testid=play-ds]"), null, "Play datasheet closed");
  w.__setDevice({ touch: true });             // back to tablet
  await until(() => d.querySelector("[data-testid=play-btn]"));
});

test("tapping the check tag shows why without opening the stratagem", async () => {
  const { w, d } = makeApp({ phone: true });
  await until(() => d.querySelector(".lists-page"));
  const C = w.MusterCore, S = w.Muster.S, F = S.idx.factions.necrons;
  const ch = F.units["Overlord"] ? F.f.units.find((u) => u.n === "Overlord") : F.f.units.find((u) => u.r === "Character" && !u.lg);
  const bl = F.f.units.find((u) => u.r === "Battleline" && !u.lg);
  const det = F.f.dets.find((x) => x.n === "Hypercrypt Legion");
  const l = C.newList({ name: "Check tag", faction: "necrons", sub: "necrons", size: "strikeforce" });
  l.dets = [det.n];
  const e1 = C.newEntry(F.units[ch.n]); e1.warlord = true;
  l.entries.push(e1, C.newEntry(F.units[bl.n])); S.lists.push(l);
  await go(w, "#/list/" + l.id + "/play");
  await until(() => d.querySelector("[data-testid=play]"));
  click(w, d.querySelector(`[data-testid=play-row][data-uid="${e1.uid}"]`));
  const ds = await until(() => d.querySelector("#modal [data-testid=play-ds]"));
  const row = [...ds.querySelectorAll("[data-testid=ust]")].find((x) => x.dataset.st === "Reanimation Crypts");
  assert.ok(row, "Reanimation Crypts is listed for the Overlord");
  const tag = row.querySelector("[data-testid=ust-check]");
  const tip = row.querySelector("[data-testid=ust-tip]");
  assert.ok(tag && tip, "check tag and reason are present");
  assert.match(tag.textContent, /check/);
  assert.ok(tag.classList.contains("tip"));
  assert.equal(tip.hidden, true);
  assert.equal(row.open, false);
  click(w, tag);
  assert.equal(row.open, false, "tag tap does not open the stratagem");
  assert.equal(tip.hidden, false);
  assert.match(tip.textContent, /Needs the WARLORD keyword\. Check your Warlord can use this/);
  assert.equal(tag.getAttribute("aria-expanded"), "true");
  click(w, tag);
  assert.equal(tip.hidden, true, "tapping again closes the reason");
  assert.equal(row.open, false);
  click(w, tag);
  assert.equal(tip.hidden, false);
  click(w, ds.querySelector("[data-testid=datasheet]") || ds);
  assert.equal(tip.hidden, true, "tapping elsewhere closes the reason");
  click(w, row.querySelector("summary .n"));
  assert.equal(row.open, true, "tapping the name still opens the stratagem");
  assert.equal(tip.hidden, true);
});
