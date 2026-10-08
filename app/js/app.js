/* Muster app shell: routing, rendering, storage, data updates. Classic script; depends on window.MusterCore. */
(function () {
  "use strict";
  const C = window.MusterCore;
  const LS_LISTS = "muster.lists", LS_THEME = "muster.theme", LS_FMT = "muster.exportFormat", LS_REPORT = "muster.updateReport",
    LS_COLL = "muster.collapsed", LS_WRRANGE = "muster.metaRange";
  const ROLE_ICON = "unit";

  /* ------------------------------------------------------------------ state */
  const S = {
    data: null, idx: null, meta: null, wr: null, lists: [], report: null,
    ui: { panel: null, q: "", tab: "roster", focusDet: null, collapsed: {}, listQ: "", metaSort: { key: "win_rate", dir: "desc" },
      detSort: { key: "games", dir: "desc" }, muSort: { key: "win_rate", dir: "desc" }, detMode: "combos", metaRange: "weekend", showSmall: false },
  };
  try { S.ui.collapsed = JSON.parse(localStorage.getItem(LS_COLL) || "{}"); } catch (e) { S.ui.collapsed = {}; }
  try { S.ui.metaRange = localStorage.getItem(LS_WRRANGE) || "weekend"; } catch (e) { /* ignore */ }

  /* ------------------------------------------------------------------ helpers */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (id, cls) => `<svg class="i${cls ? " " + cls : ""}"><use href="#i-${id}"/></svg>`;
  const pts = (n, cls) => `<span class="pts${cls ? " " + cls : ""}">${esc(Number(n || 0).toLocaleString("en-US"))} pts</span>`;
  const title = (s) => String(s || "").toLowerCase().replace(/(^|[\s(-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  const clean = (s) => String(s || "").replace(/\*\*|\^\^/g, "");
  const now = () => new Date().toISOString();
  function ago(iso) {
    if (!iso) return "";
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return "just now";
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
  }
  const localTime = (iso) => C.fmtLocal(iso);
  function toast(msg, ms) {
    const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), ms || 2200);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); return true; } catch (e) { /* fallback */ }
    const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove(); toast(ok ? "Copied to clipboard" : "Copy failed – select the text and copy manually"); return ok;
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || "text/plain;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const fileSafe = (s) => String(s || "list").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "list";

  /* ------------------------------------------------------------------ storage: lists in localStorage, data in IndexedDB */
  function loadLists() { try { S.lists = JSON.parse(localStorage.getItem(LS_LISTS) || "[]"); } catch (e) { S.lists = []; } }
  function saveLists() { try { localStorage.setItem(LS_LISTS, JSON.stringify(S.lists)); } catch (e) { toast("Could not save – storage full?"); } }
  const mem = {};
  const idb = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      if (typeof indexedDB === "undefined") return Promise.resolve(null);
      return new Promise((res) => {
        try {
          const r = indexedDB.open("muster", 1);
          r.onupgradeneeded = () => r.result.createObjectStore("kv");
          r.onsuccess = () => { this.db = r.result; res(this.db); };
          r.onerror = () => res(null);
        } catch (e) { res(null); }
      });
    },
    async get(k) {
      const db = await this.open(); if (!db) return mem[k];
      return new Promise((res) => { try { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(mem[k]); } catch (e) { res(mem[k]); } });
    },
    async set(k, v) {
      mem[k] = v; const db = await this.open(); if (!db) return;
      return new Promise((res) => { try { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(); t.onerror = () => res(); } catch (e) { res(); } });
    },
  };

  /* ------------------------------------------------------------------ data loading + points update flow */
  async function fetchJSON(url, opts) {
    const r = await fetch(url, opts || {}); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json();
  }
  function setData(d) {
    S.data = d; S.idx = C.indexData(d);
    S.meta = { mfm_version: d.mfm_version, fetched_at: d.fetched_at, hash: d.hash, gs_fetched_at: d.gs_fetched_at, built_at: d.built_at };
  }
  function trimDiff(dd) {
    const cap = (a) => a.slice(0, 600);
    return { counts: { units: dd.units.length, enhancements: dd.enhancements.length, detachments: dd.detachments.length },
      units: cap(dd.units), enhancements: cap(dd.enhancements), detachments: cap(dd.detachments) };
  }
  function reportMatters(R) {
    if (!R) return false;
    const c = (R.data && R.data.counts) || {};
    return (R.lists || []).length > 0 || (c.units || 0) + (c.enhancements || 0) + (c.detachments || 0) > 0;
  }
  function applyNewData(old, fresh) {
    if (old && old.hash !== fresh.hash) {
      const oldIdx = C.indexData(old), newIdx = C.indexData(fresh);
      const report = { at: now(), from: { v: old.mfm_version, fetched_at: old.fetched_at, hash: old.hash },
        to: { v: fresh.mfm_version, fetched_at: fresh.fetched_at, hash: fresh.hash },
        lists: C.diffLists(S.lists, oldIdx, newIdx), data: trimDiff(C.diffData(old, fresh)), dismissed: false };
      // only surface it when a saved list is affected or points really changed (pure rebuilds / text changes stay silent)
      if (reportMatters(report)) {
        S.report = report;
        try { localStorage.setItem(LS_REPORT, JSON.stringify(report)); } catch (e) { /* too big: keep in memory */ }
      }
    }
    setData(fresh);
    for (const l of S.lists) { try { l.total = C.calcList(l, S.idx).total; } catch (e) { /* ignore */ } }
    saveLists();
    return idb.set("points", fresh);
  }
  /* returns {updated, offline, error} */
  async function checkForUpdates(manual) {
    let ver = null;
    try { ver = await fetchJSON(`data/version.json?ts=${Date.now()}`, { cache: "no-store" }); } catch (e) { /* offline */ }
    const out = { updated: false, offline: !ver, wrUpdated: false };
    if (ver && (!S.data || ver.hash !== S.data.hash)) {
      try {
        const fresh = await fetchJSON(`data/points.json?v=${encodeURIComponent(ver.hash)}`, { cache: "no-store" });
        if (fresh && fresh.factions && fresh.factions.length) { const had = !!S.data; await applyNewData(S.data, fresh); out.updated = had; out.first = !had; }
      } catch (e) { out.error = String(e.message || e); }
    } else if (!S.data) {
      try { const fresh = await fetchJSON("data/points.json"); await applyNewData(null, fresh); out.first = true; } catch (e) { out.error = String(e.message || e); }
    }
    if (ver ? (ver.winrates_hash && (!S.wr || S.wr._hash !== ver.winrates_hash)) : !S.wr) {
      try {
        const w = await fetchJSON(`data/winrates.json?v=${encodeURIComponent((ver && ver.winrates_hash) || "")}`, { cache: ver ? "no-store" : "default" });
        w._hash = (ver && ver.winrates_hash) || w.fetched_at; S.wr = w; out.wrUpdated = true; await idb.set("winrates", w);
      } catch (e) { /* win rates are optional */ }
    }
    if (ver ? (ver.datasheets_hash && (!S.ds || S.ds.hash !== ver.datasheets_hash)) : !S.ds) {
      try {
        const ds = await fetchJSON(`data/datasheets.json?v=${encodeURIComponent((ver && ver.datasheets_hash) || "")}`, { cache: ver ? "no-store" : "default" });
        if (ds && ds.factions) { S.ds = ds; out.dsUpdated = true; await idb.set("datasheets", ds); }
      } catch (e) { /* datasheets are optional: the unit view says so when missing */ }
    }
    if (manual) {
      if (out.updated) toast("New points loaded – see the banner for changes", 3500);
      else if (out.offline) toast("Offline – using saved points data", 3000);
      else if (out.error) toast("Update failed – keeping current data", 3000);
      else toast(`Points are up to date (MFM ${S.meta ? S.meta.mfm_version : ""})`, 2500);
    }
    return out;
  }
  async function boot() {
    loadLists();
    try { S.report = JSON.parse(localStorage.getItem(LS_REPORT) || "null"); } catch (e) { S.report = null; }
    const cached = await idb.get("points");
    if (cached && cached.factions) setData(cached);
    S.wr = (await idb.get("winrates")) || null;
    S.ds = (await idb.get("datasheets")) || null;
    if (S.data) route();
    const r = await checkForUpdates(false);
    if (!S.data) { $("#main").innerHTML = `<div class="empty">No points data available${r.offline ? " offline" : ""}. Connect once to download the Munitorum Field Manual data.</div>`; return; }
    route();
    if ("serviceWorker" in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  /* ------------------------------------------------------------------ chrome: banner, footer */
  function renderBanner() {
    const el = $("#banner"); if (!el) return;
    const R = S.report;
    if (!R || R.dismissed || !reportMatters(R)) { el.innerHTML = ""; return; }
    const fname = (id) => { const f = S.idx && S.idx.factions[id]; return f ? f.f.name : id; };
    const arrow = (o, n, u) => `<span class="old">${o === null || o === undefined ? "—" : esc(o) + (u || "")}</span> → <b>${n === null || n === undefined ? "removed" : esc(n) + (u || "")}</b>`;
    const listsHtml = R.lists.length ? `<ul>${R.lists.map((l) => `<li><a href="#/list/${esc(l.id)}">${esc(l.name)}</a>: ${arrow(l.oldTotal, l.newTotal, " pts")}
        ${l.items.length ? `<ul>${l.items.map((i) => `<li>${esc(title(i.kind))} ${esc(i.name)}: ${arrow(i.old, i.new, i.unit ? " " + i.unit : " pts")}${i.note ? ` <span class="muted">(${esc(i.note)})</span>` : ""}</li>`).join("")}</ul>` : ""}</li>`).join("")}</ul>`
      : `<div class="muted">None of your saved lists changed.</div>`;
    const D = R.data || { counts: {}, units: [], enhancements: [], detachments: [] };
    const uRows = D.units.map((u) => `<li>${esc(fname(u.faction))} – ${esc(u.name)}: ${u.added ? "<b>new</b> " + esc(u.new) : u.removed ? "<b>removed</b>" :
      (u.oldMin !== undefined && u.oldMin !== u.newMin ? arrow(u.oldMin, u.newMin, " pts") : `<span class="old">${esc(u.old)}</span> → <b>${esc(u.new)}</b>`)}</li>`).join("");
    const eRows = D.enhancements.map((e) => `<li>${esc(fname(e.faction))} – ${esc(e.detachment)}: ${esc(e.name)} ${arrow(e.old, e.new, " pts")}</li>`).join("");
    const dRows = D.detachments.map((d) => `<li>${esc(fname(d.faction))} – ${esc(d.name)}: ${d.added ? "<b>new</b>, " + esc(d.new) + " DP" : arrow(d.old, d.new, " DP")}</li>`).join("");
    el.innerHTML = `<div class="banner" data-testid="update-banner"><button class="x ibtn" data-action="dismiss-report" title="Dismiss">${icon("x")}</button>
      <h4>Points updated: MFM ${esc(R.from.v || "")} (${esc(C.fmtLocal(R.from.fetched_at))}) → ${esc(R.to.v || "")} (${esc(C.fmtLocal(R.to.fetched_at))})</h4>
      <div><b>${R.lists.length}</b> saved list${R.lists.length === 1 ? "" : "s"} changed:</div>${listsHtml}
      <details><summary>All changes: ${D.counts.units || 0} units, ${D.counts.enhancements || 0} enhancements, ${D.counts.detachments || 0} detachments</summary>
        ${uRows ? `<b>Units</b><ul>${uRows}</ul>` : ""}${eRows ? `<b>Enhancements</b><ul>${eRows}</ul>` : ""}${dRows ? `<b>Detachments</b><ul>${dRows}</ul>` : ""}
        ${(D.counts.units || 0) > D.units.length ? `<div class="muted">Showing first ${D.units.length} unit changes.</div>` : ""}</details></div>`;
  }
  function renderFooter() {
    const m = S.meta || {};
    $("#footer").innerHTML = `Muster is an <b>unofficial</b> fan tool, not affiliated with or endorsed by Games Workshop. Points: Munitorum Field Manual ${esc(m.mfm_version || "?")}
      (fetched ${esc(m.fetched_at ? localTime(m.fetched_at) : "?")}) · rules, stratagems &amp; profiles: GrimSlate${S.ds && S.ds.data_version ? ` (data ${esc(S.ds.data_version)})` : ""}${S.wr ? " · win rates: listhammer.info" : ""} · faction artwork © Games Workshop, personal use.
      <button data-action="about">About</button>`;
  }
  function setActiveNav() {
    const h = location.hash || "#/lists";
    $$("#hdr [data-nav]").forEach((a) => a.classList.toggle("on", h.startsWith(a.getAttribute("data-nav"))));
  }

  /* ------------------------------------------------------------------ router */
  function route() {
    if (!S.data) return;
    const h = location.hash || "#/lists";
    const parts = h.replace(/^#\/?/, "").split("/");
    closeMenus();
    // the editor is a fixed-height app view (header/title row stay put, each column scrolls on its own)
    document.body.classList.toggle("app-fixed", parts[0] === "list" && !!parts[1]);
    if (parts[0] === "list" && parts[1]) renderEditor(decodeURIComponent(parts[1]));
    else if (parts[0] === "meta") renderMeta(parts[1] ? decodeURIComponent(parts[1]) : null);
    else if (parts[0] === "share" && parts[1]) openShared(parts.slice(1).join("/"));
    else renderLists();
    renderBanner(); renderFooter(); setActiveNav();
  }
  window.addEventListener("hashchange", () => { S.ui.panel = null; route(); });

  /* ------------------------------------------------------------------ My Lists */
  const subOf = (l) => (S.idx && (S.idx.subs[l.sub] || S.idx.subs[l.faction])) || null;
  function factionImg(l, banner) {
    const F = S.idx && S.idx.factions[l.faction]; const sub = subOf(l);
    if (banner) return F && F.f.banner;
    return (sub && sub.img) || (F && F.f.img) || "";
  }
  function renderLists() {
    const q = S.ui.listQ.trim().toLowerCase();
    const lists = S.lists.filter((l) => !q || `${l.name} ${(subOf(l) || {}).name || l.faction}`.toLowerCase().includes(q));
    const groups = {};
    for (const l of lists) { const k = (subOf(l) || {}).name || l.faction; (groups[k] = groups[k] || []).push(l); }
    const names = Object.keys(groups).sort();
    $("#main").innerHTML = `<div class="lists-page">
      <div class="toolbar">
        <button class="tbtn create" data-action="new-list">${icon("plus")}Create List</button>
        <button class="tbtn" data-action="import-file">${icon("import")}Import file</button>
        <button class="tbtn" data-action="import-text">${icon("text")}Text Import</button>
        <button class="tbtn" data-action="export-all" ${S.lists.length ? "" : "disabled"}>${icon("export")}Export all</button>
      </div>
      <input class="search" type="search" placeholder="Search lists…" value="${esc(S.ui.listQ)}" data-input="list-search">
      ${!S.lists.length ? `<div class="empty">No lists yet. Use <b>Create List</b> to start, or import a Muster JSON file.</div>` : ""}
      ${names.map((n) => {
        const ls = groups[n].sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
        return `<div class="lgroup"><h3>${factionImg(ls[0]) ? `<img class="fthumb" src="${esc(factionImg(ls[0]))}" alt="">` : ""}${esc(n)}</h3>
          ${ls.map((l) => {
            let c = null; try { c = C.calcList(l, S.idx); } catch (e) { c = null; }
            const size = c && c.size;
            return `<div class="lrow" data-action="open-list" data-id="${esc(l.id)}">
              ${factionImg(l) ? `<img class="lthumb" src="${esc(factionImg(l))}" alt="">` : icon(ROLE_ICON)}
              <span class="name">${esc(l.name)}</span>
              ${c ? `<span class="pts${size && c.total > size.points ? " over" : ""}">${c.total} / ${size ? size.points : "?"}</span>
                <span class="dot ${c.errors.length ? "err" : "ok"}" title="${c.errors.length ? esc(c.errors.length + " issue(s)") : "Valid"}">${c.errors.length ? "!" : "✓"}</span>` : ""}
              <span class="time">${esc(ago(l.updated))}</span>
              <button class="ibtn" data-action="rename-list" data-id="${esc(l.id)}" title="Rename">${icon("pencil")}</button>
              <button class="ibtn" data-action="dup-list" data-id="${esc(l.id)}" title="Duplicate">${icon("copy")}</button>
              <button class="ibtn danger" data-action="del-list" data-id="${esc(l.id)}" title="Delete">${icon("trash")}</button>
            </div>`;
          }).join("")}</div>`;
      }).join("")}
    </div>`;
  }

  /* ------------------------------------------------------------------ modals */
  function modal(titleText, body, opts) {
    const m = $("#modal");
    m.innerHTML = `<div class="modal-wrap${opts && opts.sheet ? " sheetwrap" : ""}" data-action="modal-bg"><div class="modal${opts && opts.wide ? " wide" : ""}${opts && opts.sheet ? " sheet" : ""}" role="dialog" aria-label="${esc(titleText)}">
      <div class="mtitle"><span>${esc(titleText)}</span><button class="ibtn" data-action="close-modal" title="Close">${icon("x")}</button></div>
      <div class="mbody">${body}</div></div></div>`;
    const f = $(".modal input[autofocus], .modal textarea[autofocus]", m); if (f) setTimeout(() => f.focus(), 0);
    return $(".modal", m);
  }
  function closeModal() { $("#modal").innerHTML = ""; }
  function confirmModal(text, okLabel, onOk) {
    const m = modal("Please confirm", `<p>${text}</p><div class="mfoot"><button class="btn secondary" data-action="close-modal">Cancel</button>
      <button class="btn danger" data-ok>${esc(okLabel || "OK")}</button></div>`);
    $("[data-ok]", m).onclick = () => { closeModal(); onOk(); };
  }
  function promptModal(titleText, label, value, onOk) {
    const m = modal(titleText, `<label class="l">${esc(label)}</label><input type="text" class="wide" value="${esc(value)}" autofocus data-prompt>
      <div class="mfoot"><button class="btn secondary" data-action="close-modal">Cancel</button><button class="btn" data-ok>Save</button></div>`);
    const inp = $("[data-prompt]", m);
    const go = () => { const v = inp.value.trim(); if (!v) return; closeModal(); onOk(v); };
    $("[data-ok]", m).onclick = go; inp.onkeydown = (e) => { if (e.key === "Enter") go(); };
  }

  /* Create List: name -> faction group -> sub-faction -> battle size */
  const NEW = { name: "", group: null, sub: null, size: "strikeforce" };
  function openCreate() { NEW.name = ""; NEW.group = null; NEW.sub = null; NEW.size = "strikeforce"; renderCreate(); }
  function renderCreate() {
    const groups = S.data.groups || [];
    let body = `<label class="l">List Name</label><input type="text" class="req" placeholder="List name" value="${esc(NEW.name)}" data-input="new-name" autofocus>
      <label class="l">Faction</label>`;
    if (!NEW.group) {
      body += `<div class="picklist">${groups.map((g, i) => `<div class="pick" data-action="pick-group" data-i="${i}"><span class="t">${esc(g.name)}<small>${g.factions.length} factions</small></span>${icon("chev", "chev")}</div>`).join("")}</div>`;
    } else if (!NEW.sub) {
      const g = groups.find((x) => x.name === NEW.group);
      body += `<div class="backrow"><button data-action="pick-back" title="Back">${icon("back")}</button>${esc(NEW.group)}</div>
        <div class="picklist">${g.factions.map((f) => `<div class="pick withimg" data-action="pick-sub" data-id="${esc(f.id)}">
          ${f.img ? `<img class="pthumb" src="${esc(f.img)}" alt="">` : ""}<span class="t">${esc(f.name)}${f.data !== f.id ? `<small>uses ${esc((S.idx.factions[f.data] || { f: { name: f.data } }).f.name)} points</small>` : ""}</span>${icon("chev", "chev")}</div>`).join("")}</div>`;
    } else {
      const sub = S.idx.subs[NEW.sub];
      body += `<div class="chosen">${sub.img ? `<img class="pthumb" src="${esc(sub.img)}" alt="">` : ""}<span class="t">${esc(sub.name)}</span><button data-action="pick-back">Change</button></div>
        <label class="l">Battle Size</label><div class="picklist">${(S.data.battle_sizes || []).map((b) => `<label class="pick sizepick"><input type="radio" name="newsize" value="${esc(b.id)}" ${NEW.size === b.id ? "checked" : ""} data-change="new-size">
          <span class="t">${esc(b.name)} <span class="pts">${b.points} pts</span><small>${b.dp != null ? `${b.dp} Detachment Points · ${b.enh} enhancements · ${b.unit_limit} of each unit` : "No MFM limits defined – points only"}</small></span></label>`).join("")}</div>
        <div class="mfoot"><button class="btn secondary" data-action="close-modal">Cancel</button><button class="btn" data-action="create-list">Create List</button></div>`;
    }
    modal("Create List", body);
  }
  function createList() {
    const sub = S.idx.subs[NEW.sub]; if (!sub) return;
    const l = C.newList({ name: NEW.name.trim() || `${sub.name} ${(S.idx.sizes[NEW.size] || {}).points || ""}`.trim(), faction: sub.data, sub: sub.id, size: NEW.size });
    S.lists.push(l); saveLists(); closeModal(); location.hash = `#/list/${l.id}`;
  }

  /* ------------------------------------------------------------------ editor */
  let CUR = null; // current list
  const findList = (id) => S.lists.find((l) => l.id === id);
  function mutate(fn) {
    if (!CUR) return;
    fn(CUR); CUR.updated = now();
    try { CUR.total = C.calcList(CUR, S.idx).total; } catch (e) { /* ignore */ }
    saveLists(); renderEditor(CUR.id);
  }
  const isPhone = () => typeof matchMedia === "function" && matchMedia("(max-width: 760px)").matches;
  function keepScroll(fn) {
    const pos = {}; $$("[data-sk]").forEach((e) => { pos[e.getAttribute("data-sk")] = e.scrollTop; });
    fn();
    $$("[data-sk]").forEach((e) => { const k = e.getAttribute("data-sk"); if (pos[k] !== undefined) e.scrollTop = pos[k]; });
  }
  const collKey = (k) => S.ui.collapsed[k] ? " collapsed" : "";
  const dispName = (d) => title(d);

  function renderEditor(id) {
    const l = findList(id);
    if (!l) { $("#main").innerHTML = `<div class="empty">List not found. <a href="#/lists">Back to My Lists</a></div>`; return; }
    CUR = l;
    const F = C.getFaction(S.idx, l);
    const c = C.calcList(l, S.idx);
    const sub = subOf(l);
    const panel = S.ui.panel;
    keepScroll(() => {
      $("#main").innerHTML = `<div class="editor">
        <div class="titlebar">
          ${factionImg(l) ? `<img class="lthumb" src="${esc(factionImg(l))}" alt="">` : icon(ROLE_ICON)}
          <span class="lname" data-action="rename-cur" title="Rename">${esc(l.name)}</span>
          <button class="ibtn" data-action="rename-cur" title="Rename">${icon("pencil")}</button>
          <span class="grow"></span>
          <span class="pts big${c.size && c.total > c.size.points ? " over" : ""}" data-testid="total">${c.total} / ${c.size ? c.size.points : "?"} pts</span>
          <span class="dotwrap"><button class="dot ${c.errors.length ? "err" : c.warnings.length ? "warn" : "ok"}" data-action="toggle-vpop" aria-label="${c.errors.length ? c.errors.length + " validation error(s)" : c.warnings.length ? c.warnings.length + " warning(s)" : "Valid list"}" data-testid="valid-dot">${c.errors.length || c.warnings.length ? "!" : "✓"}</button>
            <div class="vpop" data-testid="vpop"><div class="vh">${c.errors.length ? `${c.errors.length} error${c.errors.length === 1 ? "" : "s"} – the list is not valid yet` : c.warnings.length ? "No errors – the list is valid, but check the warnings" : "Valid list – no issues found"}</div>
              ${c.errors.length ? `<ul>${c.errors.map((x) => `<li class="err">${esc(x.msg)}</li>`).join("")}</ul>` : ""}
              ${c.warnings.length ? `<div class="vh">${c.warnings.length} warning${c.warnings.length === 1 ? "" : "s"}</div><ul>${c.warnings.slice(0, 8).map((x) => `<li class="warn">${esc(x.msg)}</li>`).join("")}${c.warnings.length > 8 ? `<li>…</li>` : ""}</ul>` : ""}
              <div class="muted">Red = errors, amber = warnings only, green = valid. <a href="#" data-action="open-panel" data-panel="errors">Open validation panel</a></div></div></span>
          <button class="act" data-action="export" title="Export">${icon("export")}<span class="lbl">Export</span></button>
          <button class="act" data-action="list-menu" title="List options">${icon("kebab")}<span class="lbl">Options</span></button>
        </div>
        <div class="mtabs"><button class="${S.ui.tab === "catalog" ? "on" : ""}" data-action="tab" data-tab="catalog">Catalog</button><button class="${S.ui.tab === "roster" ? "on" : ""}" data-action="tab" data-tab="roster">Roster (${l.entries.length})</button></div>
        <div class="cols${panel ? " with-panel" : ""}" data-tab="${esc(S.ui.tab)}">
          <section class="col catalog">${F ? renderCatalog(l, F, c) : `<div class="empty">Faction not in data.</div>`}</section>
          <section class="col roster"><div class="scroll" data-sk="roster">${renderRoster(l, F, c, sub)}</div></section>
          ${panel ? `<section class="col panel">${renderPanel(l, F, c)}</section>` : ""}
        </div></div>`;
    });
  }

  function renderCatalog(l, F, c) {
    return `<div class="fhead"><div class="fname">${esc(F.f.name)}</div>${subOf(l) && subOf(l).name !== F.f.name ? `<div class="sub">${esc(subOf(l).name)}</div>` : ""}</div>
      <div class="scroll" data-sk="catalog" id="catbody">${renderCatalogBody(l, F, c)}</div>
      <div class="legend" title="Changes compared with the previous Munitorum Field Manual"><span><span class="chg-up">▲</span> points up</span><span><span class="chg-down">▼</span> points down</span><span><span class="chg-mixed">◆</span> mixed</span><span>in MFM ${esc((S.meta && S.meta.mfm_version) || "")} · n/N = taken / allowed</span></div>
      <div class="catsearch"><input type="search" placeholder="Search Units, Categories, Costs, Keywords…" value="${esc(S.ui.q)}" data-input="cat-search" aria-label="Search units"></div>`;
  }
  function renderCatalogBody(l, F, c) {
    const copies = {}; for (const e of l.entries) copies[e.unit] = (copies[e.unit] || 0) + 1;
    let units = F.f.units.filter((u) => l.showLegends || !u.lg || copies[u.n]);
    // units that need a detachment the list doesn't have (e.g. Blood Legions daemons -> Khorne Daemonkin)
    const lockedAll = units.filter((u) => !C.unitAllowed(u, l).ok);
    units = units.filter((u) => C.unitAllowed(u, l).ok || copies[u.n] || l.showLocked);
    units = C.searchUnits(units, S.ui.q);
    const lockToggle = lockedAll.length ? `<label class="locktoggle" data-testid="lock-toggle"><input type="checkbox" ${l.showLocked ? "checked" : ""} data-change="show-locked">
      Show ${lockedAll.length} unit${lockedAll.length === 1 ? "" : "s"} that need${lockedAll.length === 1 ? "s" : ""} another detachment <span class="muted">(${esc([...new Set(lockedAll.flatMap((u) => u.req))].join(", "))})</span></label>` : "";
    const byRole = {}; for (const u of units) (byRole[u.r] = byRole[u.r] || []).push(u);
    const size = c.size;
    const html = C.ROLE_ORDER.filter((r) => byRole[r]).map((role) => {
      const k = `cat:${role}`;
      return `<div class="sect${S.ui.q ? "" : collKey(k)}"><div class="sect-h" data-action="toggle-sect" data-key="${esc(k)}"><span class="tri"></span>${esc(role)} <span class="muted">(${byRole[role].length})</span></div>
        <div class="sect-body">${byRole[role].sort((a, b) => a.n.localeCompare(b.n)).map((u) => {
          const n = copies[u.n] || 0; const lim = C.unitLimit(u, size); const al = C.unitAllowed(u, l);
          if (!al.ok) return `<div class="crow locked" data-unit="${esc(u.n)}" data-testid="locked-unit" title="${esc(al.reason)}">
            ${pts(C.minCost(u, n + 1))}<span class="cname">${esc(u.n)}${u.lg ? `<span class="tag">Legends</span>` : ""}<span class="why">🔒 ${esc(al.reason)}</span></span>
            <span class="cnt">${n ? n : ""}</span>
            <button class="ibtn" data-action="preview-unit" data-unit="${esc(u.n)}" title="View">${icon("eye")}</button>
            <button class="ibtn add" disabled title="${esc(al.reason)}">${icon("plusbox")}</button></div>`;
          return `<div class="crow" data-action="add-unit" data-unit="${esc(u.n)}" title="Add ${esc(u.n)}">
            ${pts(C.minCost(u, n + 1))}<span class="cname">${esc(u.n)}${u.lg ? `<span class="tag">Legends</span>` : ""}${chgMark(u)}</span>
            <span class="cnt${lim != null && n > lim ? " over" : ""}">${lim != null ? `${n}/${lim}` : n ? n : ""}</span>
            <button class="ibtn" data-action="preview-unit" data-unit="${esc(u.n)}" title="View">${icon("eye")}</button>
            <button class="ibtn add" data-action="add-unit" data-unit="${esc(u.n)}" title="Add">${icon("plusbox", "green")}</button></div>`;
        }).join("")}</div></div>`;
    }).join("");
    return lockToggle + (html || `<div class="empty">No units match.</div>`);
  }

  function chgText(u) {
    const what = u.ch === "up" ? "Points went up" : u.ch === "down" ? "Points went down" : "Points changed (some up, some down)";
    const d = (u.chd || []).map((x) => `${x[0] ? x[0] + " " : ""}${x[1] > 0 ? "+" : ""}${x[1]}`).join(", ");
    return `${what} in the latest MFM (${(S.meta && S.meta.mfm_version) || ""})${d ? ": " + d + " pts" : ""}`;
  }
  const chgMark = (u) => u.ch ? `<span class="chg-${u.ch === "mixed" ? "mixed" : u.ch}" title="${esc(chgText(u))}" data-action="chg-info" data-unit="${esc(u.n)}" role="img" aria-label="${esc(chgText(u))}">${u.ch === "down" ? "▼" : u.ch === "up" ? "▲" : "◆"}</span>` : "";
  function entrySummary(r) {
    const e = r.entry, bits = [];
    if (r.unit && !(r.loLines && r.loLines.length) && C.modelOptions(r.unit, r.copy).length > 1) bits.push(r.modelsLabel);
    if (e.warlord) bits.push("Warlord");
    if (r.attachedTo) bits.push(`Attached to ${r.attachedTo.name}`);
    if (r.enhName) bits.push(`Enhancement: ${r.enhName} (+${r.enh})`);
    const linked = r.unit ? C.linkedWargear(r.unit) : new Set();
    for (const [w, n] of Object.entries(e.wargear || {})) if (n > 0 && !linked.has((r.unit.w || []).findIndex((x) => x[0] === w))) bits.push(`${n}x ${w}`);
    for (const a of e.addons || []) bits.push(a.replace(/^\+\s*/, ""));
    if (e.note) bits.push(e.note);
    return bits;
  }
  function renderRoster(l, F, c, sub) {
    const banner = factionImg(l, true);
    const size = c.size;
    const dets = (l.dets || []).map((n) => F && F.dets[n]).filter(Boolean);
    const dpOver = c.dpLimit != null && c.dp > c.dpLimit && !(size.single3dp && dets.length === 1 && c.dp === 3);
    const errsFor = (uid) => c.errors.filter((x) => x.uid === uid).concat(c.warnings.filter((x) => x.uid === uid));
    const sel = S.ui.panel || {};
    const cfg = `<div class="card${collKey("cfg")}"><div class="sect-h" data-action="toggle-sect" data-key="cfg">${icon("gear")} Configuration${!dets.length ? ` <span class="need" title="Error: select a detachment">!</span>` : !l.disposition && (c.dispositions || []).length ? ` <span class="need warn" title="Warning: no Force Disposition selected">!</span>` : ""}<span class="tri"></span></div><div class="sect-body">
      <div class="cfgrow${sel.type === "size" ? " selrow" : ""}" data-action="open-panel" data-panel="size"><span class="n"><b>Battle Size:</b> ${esc(size ? size.name : "?")}</span>${size ? pts(size.points) : ""}</div>
      <div class="cfgrow${sel.type === "dets" ? " selrow" : ""}" data-action="open-panel" data-panel="dets" data-testid="cfg-dets"><span class="n">${dets.length ? "" : `<span class="need" title="Error: select a detachment">!</span> `}<b>Detachment:</b> ${dets.length ? dets.map((d) => esc(d.n) + (d.src === "gs" ? `<span class="tag gs">GrimSlate</span>` : "")).join(", ") : `<span class="err">None selected</span>`}</span>
        <span class="dpchip${dpOver ? " over" : ""}" data-testid="dp">${c.dp}${c.dpLimit != null ? " / " + c.dpLimit : ""} DP</span></div>
      ${dets.map((d) => `<details class="coll cfgdet" data-testid="cfg-det" data-det="${esc(d.n)}"><summary><b>${esc(d.n)}</b>${d.rule ? ` – ${esc(d.rule[0])}` : ""} <span class="muted">· ${d.st.length} stratagem${d.st.length === 1 ? "" : "s"} · ${d.enh.length} enhancement${d.enh.length === 1 ? "" : "s"}</span></summary>
        <div class="cb">${d.rule ? `<div class="rules"><b>${esc(d.rule[0])}:</b> ${esc(clean(d.rule[1]))}</div>` : ""}${d.st.length ? d.st.map(stratHtml).join("") : `<span class="muted">No stratagem data for this detachment.</span>`}</div></details>`).join("")}
      <div class="cfgrow${sel.type === "disp" ? " selrow" : ""}" data-action="open-panel" data-panel="disp"><span class="n">${!l.disposition && (c.dispositions || []).length ? `<span class="need warn" title="Warning: select a Force Disposition">!</span> ` : ""}<b>Force Disposition:</b> ${l.disposition ? esc(dispName(l.disposition)) : `<span class="muted">${(c.dispositions || []).length ? "Select…" : "—"}</span>`}</span></div>
      <label class="cfgrow"><span class="n"><b>Show Legends</b></span><input type="checkbox" ${l.showLegends ? "checked" : ""} data-change="legends"></label>
      <label class="cfgrow" title="Off: attached Leaders/Support units appear inside their bodyguard unit's card"><span class="n"><b>Attached characters in their own category</b></span><input type="checkbox" ${l.leadersOwnCat ? "checked" : ""} data-change="leaders-own" data-testid="leaders-own"></label>
      <div class="cfgnote">Enhancements ${c.enhCount}${c.enhLimit != null ? " / " + c.enhLimit : ""} · Units ${c.units} pts · Enhancements ${c.enhancements} pts</div>
    </div></div>`;
    const rowHtml = (r, nested) => {
      const errs = errsFor(r.uid); const bits = entrySummary(r);
      return `<div class="urow${nested ? " attached" : ""}${sel.type === "unit" && sel.uid === r.uid ? " sel" : ""}" data-action="select-entry" data-uid="${esc(r.uid)}"${nested ? ` data-testid="attached-row" data-to="${esc(r.attachedTo.uid)}"` : ""}>
            <div class="line">${nested ? `<span class="att" title="${esc(r.attachKind === "support" ? "Support unit attached" : "Leader attached")}">↳</span>` : ""}${icon(ROLE_ICON)}<span class="n">${esc(r.name)}${r.unit && r.unit.lg ? `<span class="tag">Legends</span>` : ""}${nested ? ` <span class="tag">${r.attachKind === "support" ? "Support" : "Leader"}</span>` : ""}</span>
              ${errs.some((x) => c.errors.includes(x)) ? `<span class="dot err" title="${esc(errs.map((x) => x.msg).join("\n"))}">!</span>` : ""}
              ${pts(r.total)}${!nested && r.attached && r.attached.length ? `<span class="combo" title="Attached unit: ${esc([r.name, ...r.attached.map((x) => x.name)].join(" + "))}" data-testid="combo-pts">Σ ${r.total + r.attached.reduce((a, x) => a + x.total, 0)} pts</span>` : ""}
              <button class="ibtn" data-action="ds-pop" data-uid="${esc(r.uid)}" title="View datasheet">${icon("eye")}</button>
              ${nested ? `<button class="ibtn" data-action="unlink" data-uid="${esc(r.uid)}" title="Detach from ${esc(r.attachedTo.name)}" data-testid="unlink">⛓✕</button>` : ""}
              <button class="ibtn" data-action="dup-entry" data-uid="${esc(r.uid)}" title="Duplicate">${icon("copy")}</button>
              <button class="ibtn danger" data-action="del-entry" data-uid="${esc(r.uid)}" title="Remove">${icon("trash")}</button></div>
            <div class="swipe-acts"><button data-action="dup-entry" data-uid="${esc(r.uid)}">Duplicate</button>${r.attachedTo ? `<button data-action="unlink" data-uid="${esc(r.uid)}">Unlink</button>` : ""}<button class="danger" data-action="del-entry" data-uid="${esc(r.uid)}">Delete</button></div>
            ${bits.length || errs.length || (r.loLines && r.loLines.length) ? `<div class="sum">${(r.loLines || []).map((x) => `<span class="lo-line">• ${esc(C.loadoutText(x))}</span>`).join("")}${bits.map((b) => "• " + esc(b)).join(" ")}${errs.map((x) => `<div class="${c.errors.includes(x) ? "err" : "warn"}">${esc(x.msg)}</div>`).join("")}</div>` : ""}
          </div>`;
    };
    // attached Leaders/Support units are shown nested under their bodyguard (and counted in its section)
    // (list option "Attached characters in their own category" keeps them in their own role section instead)
    const own = !!l.leadersOwnCat;
    const roles = C.ROLE_ORDER.filter((r) => c.byRole[r] && c.byRole[r].entries.some((x) => own || !x.attachedTo)).map((role) => {
      const R = c.byRole[role]; const k = `ros:${role}`;
      const top = R.entries.filter((x) => own || !x.attachedTo);
      const ptsSum = own ? top.reduce((a, r) => a + r.total, 0) : top.reduce((a, r) => a + r.total + (r.attached || []).reduce((b, x) => b + x.total, 0), 0);
      return `<div class="card${collKey(k)}"><div class="sect-h" data-action="toggle-sect" data-key="${esc(k)}">${esc(role)} ${pts(ptsSum)}<span class="tri"></span></div><div class="sect-body">
        ${top.map((r) => (!own && r.attached && r.attached.length ? `<div class="ugroup" data-testid="attached-group">${rowHtml(r, false)}${r.attached.map((x) => rowHtml(x, true)).join("")}</div>` : rowHtml(r, false))).join("")}</div></div>`;
    }).join("");
    const missing = c.entries.filter((r) => r.missing);
    const miss = missing.length ? `<div class="card"><div class="sect-h">Not in current data</div>${missing.map((r) => `<div class="urow" data-uid="${esc(r.uid)}"><div class="line"><span class="n err">${esc(r.name)}</span>
      <button class="ibtn danger" data-action="del-entry" data-uid="${esc(r.uid)}" title="Remove">${icon("trash")}</button></div></div>`).join("")}</div>` : "";
    return `<div class="fbanner"${banner ? ` style="background-image:linear-gradient(90deg,rgba(0,0,0,.78),rgba(0,0,0,.25)),url('${esc(banner)}')"` : ""}>
        <div><div class="fbt">${esc(sub ? sub.name : F ? F.f.name : l.faction)}</div><div class="fbs">${esc(size ? size.name : "")} · ${c.entries.length} unit${c.entries.length === 1 ? "" : "s"}</div></div>
        <span class="pts big${size && c.total > size.points ? " over" : ""}">${c.total} / ${size ? size.points : "?"} pts</span></div>
      ${cfg}${roles}${miss}
      ${!l.entries.length ? `<div class="empty">Add units from the catalog${isPhone() ? " tab" : " on the left"}.</div>` : ""}`;
  }

  /* ------------------------------------------------------------------ right panel */
  function phead(t, sub, extra) {
    return `<div class="phead"><button class="ibtn phone-only" data-action="close-panel" title="Back">${icon("back")}</button><span class="t">${t}${sub ? `<div class="psub">${sub}</div>` : ""}</span>${extra || ""}
      <button class="ibtn" data-action="close-panel" title="Close">${icon("x")}</button></div>`;
  }
  function renderPanel(l, F, c) {
    const P = S.ui.panel;
    if (!F) return phead("—");
    if (P.type === "unit") return unitPanel(l, F, c, P.uid);
    if (P.type === "preview") return previewPanel(l, F, c, P.unit);
    if (P.type === "dets") return detsPanel(l, F, c);
    if (P.type === "size") return sizePanel(l, c);
    if (P.type === "disp") return dispPanel(l, c);
    if (P.type === "errors") return errorsPanel(l, c);
    return phead("");
  }
  function stratHtml(s) {
    return `<div class="strat"><div class="sh"><span class="n">${esc(s[0])}</span><span class="cp">${esc(s[1])} CP</span></div>
      <div class="meta">${[s[3], s[2], s[4]].filter(Boolean).map(esc).join(" · ")}</div><div class="txt">${esc(clean(s[5]))}</div></div>`;
  }
  /* ---------------------------------------------------------------- datasheet / Profiles (New Recruit style) */
  function dsOf(F, u) { const f = S.ds && S.ds.factions && F && S.ds.factions[F.f.id]; return (f && u && f.units[u.n]) || null; }
  const kwTip = (k) => { const g = S.ds && S.ds.weapon_keywords; const base = String(k).replace(/\s+[\dD+\-"]+$/, "").replace(/^\[|\]$/g, "");
    const t = g && (g[k] || g[base] || g[C.title ? base : base]); return t ? ` title="${esc(clean(t).slice(0, 400))}"` : ""; };
  /* what the unit currently carries: weapon name -> count, picked option names; null when unknown */
  function equipped(u, r) {
    let lines = r && r.loLines, lo = r && r.lo;
    if (!lines && C.hasLoadout(u)) { const o = C.modelOptions(u, 1)[0] || { models: 1 }; lo = C.getLoadout(u, {}, o.models, o.label); lines = C.loadoutLines(u, lo); }
    if (!lines || !lines.length) return null;
    const w = new Map(); for (const l of lines) for (const g of l.gear) w.set(C.norm(g.name), (w.get(C.norm(g.name)) || 0) + (g.count || 1));
    const picks = new Set(); for (const v of Object.values((lo && lo.p) || {})) for (const [k, n] of Object.entries(v)) if (n > 0) picks.add(C.norm(k));
    return { w, picks };
  }
  function datasheetHtml(F, u, r, o) {
    o = o || {};
    const ds = dsOf(F, u);
    const st = (ds && ds.s) || {};
    const eq = equipped(u, r);
    const filt = o.item ? String(o.item).split("|").map(C.norm).filter(Boolean) : null;
    const matchItem = (name) => !filt || filt.some((f) => C.norm(name).includes(f) || f.includes(C.norm(name)));
    let html = "";
    if (!ds) html += `<div class="muted" data-testid="ds-missing">${S.ds ? "GrimSlate has no datasheet for this unit." : "Profiles not downloaded yet – connect once to load them."}</div>`;
    else {
      if (!filt) html += `<table class="ds-t ds-unit" data-testid="ds-stats"><tr><th class="nm">Unit</th><th>M</th><th>T</th><th>Sv</th><th>W</th><th>Ld</th><th>OC</th><th>InSv</th></tr>
        <tr><td class="nm">${esc(u.n)}</td><td>${esc(st.M || "-")}</td><td>${esc(st.T || "-")}</td><td>${esc(st.SV || st.Sv || "-")}</td><td>${esc(st.W || "-")}</td><td>${esc(st.LD || st.Ld || "-")}</td><td>${esc(st.OC || "-")}</td><td data-testid="ds-inv">${esc(ds.inv || "-")}</td></tr></table>`;
      const wtab = (kind, label, skill) => {
        let ws = ds.wp.filter((w) => w[1] === kind && matchItem(w[0]));
        if (!ws.length) return "";
        const cnt = (w) => (eq ? eq.w.get(C.norm(w[0])) || 0 : null);
        if (eq) ws = ws.slice().sort((a, b) => (cnt(b) > 0) - (cnt(a) > 0));
        return `<table class="ds-t ds-w" data-testid="ds-${kind === "r" ? "ranged" : "melee"}"><tr><th class="nm">${label}</th><th>Range</th><th>A</th><th>${skill}</th><th>S</th><th>AP</th><th>D</th><th class="kw">Keywords</th></tr>
          ${ws.map((w) => { const n = cnt(w); const cls = n === null ? "" : n > 0 ? "eq" : "uneq";
            return w[2].map((p, i) => `<tr class="${cls}"${i === 0 ? ` data-weapon="${esc(w[0])}"` : ""}><td class="nm">${i === 0 ? `${n ? `<span class="eqn" title="Equipped">${n}×</span> ` : ""}${esc(w[0])}` : ""}${p[0] ? `<span class="pn">${i === 0 ? " – " : "↳ "}${esc(p[0])}</span>` : ""}</td>
              <td>${esc(p[1] || "-")}</td><td>${esc(p[2] || "-")}</td><td>${esc(p[3] || "-")}</td><td>${esc(p[4] || "-")}</td><td>${esc(p[5] || "-")}</td><td>${esc(p[6] || "-")}</td>
              <td class="kw">${(p[7] || []).map((k) => `<span class="kwc"${kwTip(k)}>${esc(k)}</span>`).join(", ") || "-"}</td></tr>`).join(""); }).join("")}</table>`;
      };
      html += wtab("r", "Ranged Weapons", "BS") + wtab("m", "Melee Weapons", "WS");
      if (eq && !filt && ds.wp.some((w) => !(eq.w.get(C.norm(w[0])) > 0))) html += `<div class="ds-note muted">Highlighted: current loadout (× = number of models carrying it). Dimmed: other wargear options.</div>`;
      const fr = (S.ds.factions[F.f.id] || {}).rules || [];
      const frText = (n) => { const x = fr.find((y) => C.norm(y[0]) === C.norm(n)); return x ? x[1] : ""; };
      const wa = ds.wa.filter((a) => matchItem(a[0]) || matchItem(a[1]));
      if (!filt) {
        html += `<div class="ds-sec" data-testid="ds-abilities"><div class="ds-h">Abilities</div>
          ${ds.cr.length ? `<div class="ds-ab"><b>Core:</b> ${ds.cr.map((n) => `<span class="kwc"${kwTip(n)}>${esc(n)}</span>`).join(", ")}</div>` : ""}
          ${ds.fa.length ? ds.fa.map((n) => `<details class="ds-ab"><summary><b>Faction:</b> ${esc(n)}</summary><div class="rules">${esc(clean(frText(n)) || "")}</div></details>`).join("") : ""}
          ${ds.ab.map((a) => `<div class="ds-ab"><b>${esc(a[0])}:</b> ${esc(clean(a[1]))}</div>`).join("")}
          ${u.ldr && u.ldr.length ? `<div class="ds-ab"><b>Leader:</b> This model can be attached to the following units: ${u.ldr.map((x) => `■ ${esc(title(x))}`).join(" ")}</div>` : ""}
          ${u.sup && u.sup.length ? `<div class="ds-ab"><b>Support:</b> This unit can be attached to: ${u.sup.map((x) => `■ ${esc(title(x))}`).join(" ")}</div>` : ""}
          ${(() => { const by = F.f.units.filter((x) => (x.ldr || []).concat(x.sup || []).some((y) => C.norm(y) === C.norm(u.n))).map((x) => x.n); return by.length ? `<div class="ds-ab"><b>Can be joined by:</b> ${esc(by.join(", "))}</div>` : ""; })()}
          ${ds.tr ? `<div class="ds-ab"><b>Transport:</b> ${esc(clean(typeof ds.tr === "string" ? ds.tr : JSON.stringify(ds.tr)))}</div>` : ""}</div>`;
      }
      if (wa.length) html += `<div class="ds-sec" data-testid="ds-wargear-ab"><div class="ds-h">Wargear abilities</div>${wa.map((a) => { const on = eq && (eq.picks.has(C.norm(a[0])) || eq.w.has(C.norm(a[0])));
        return `<div class="ds-ab${eq ? (on ? " eq" : " uneq") : ""}"><b>${esc(a[1])}</b>${C.norm(a[0]) !== C.norm(a[1]) ? ` <span class="muted">(${esc(a[0])})</span>` : ""}: ${esc(clean(a[2]))}</div>`; }).join("")}</div>`;
      if (filt && !html.includes("<table") && !wa.length) html += `<div class="muted">No separate profile for ${esc(String(o.item).replace(/\|/g, ", "))}.</div>`;
    }
    if (!filt) {
      html += `<div class="ds-sec" data-testid="ds-keywords"><div class="ds-h">Keywords</div><div class="ds-ab">${esc((u.kw || []).join(", ") || "—")}</div>
        <div class="ds-ab"><b>Faction keywords:</b> ${esc(u.fk || F.f.name)}</div></div>`;
      if (r && r.attachedTo) html += `<div class="ds-sec"><div class="ds-h">Attached</div><div class="ds-ab">${esc(r.attachKind === "support" ? "Support unit" : "Leader")} attached to <b>${esc(r.attachedTo.name)}</b></div></div>`;
      if (!o.noPoints) html += `<div class="ds-sec"><div class="ds-h">Points (MFM)</div>${pointsTable(u)}</div>`;
    }
    return `<div class="ds" data-testid="datasheet">${html}</div>`;
  }
  /* combined card for an attached unit: bodyguard + its Leader/Support (New Recruit's combined unit card) */
  function combinedDatasheet(F, r) {
    let h = datasheetHtml(F, r.unit, r);
    for (const x of r.attached || []) h += `<div class="ds-join" data-testid="ds-joined"><div class="ds-jh">+ ${esc(x.name)} <span class="tag">${x.attachKind === "support" ? "Support" : "Leader"}</span> ${pts(x.total)}</div>${datasheetHtml(F, x.unit, x, { noPoints: true })}</div>`;
    return h;
  }
  function pointsTable(u) {
    return `<table class="ptable"><tr><th>Copies</th><th>Size</th><th>Points</th></tr>${(u.t || []).map((t) => t[2].map((r, i) => `<tr><td>${i ? "" : esc(t[1] === null ? (t[0] === 1 ? "any" : `${t[0]}+`) : t[0] === t[1] ? `#${t[0]}` : `${t[0]}–${t[1]}`)}</td>
      <td>${esc(r[2] || (r[0] === 1 ? "1 model" : r[0] + " models"))}</td><td>${esc(r[1])}</td></tr>`).join("")).join("")}
      ${(u.w || []).map((w) => `<tr><td></td><td>${esc(w[0])}</td><td>+${esc(w[1])}</td></tr>`).join("")}</table>`;
  }
  function unitInfo(u) {
    const parts = [];
    if (u.ldr && u.ldr.length) parts.push(`<div class="opt"><span class="on"><b>Can lead:</b> ${esc(u.ldr.map(title).join(", "))}</span></div>`);
    if (u.sup && u.sup.length) parts.push(`<div class="opt"><span class="on"><b>Support:</b> ${esc(u.sup.map(title).join(", "))}</span></div>`);
    if (u.kw && u.kw.length) parts.push(`<div class="opt"><span class="on"><b>Keywords:</b> <span class="muted">${esc(u.kw.join(", "))}</span></span></div>`);
    if (u.upd) parts.push(`<div class="opt"><span class="on muted">${esc([].concat(u.upd).join("; "))}</span></div>`);
    return parts.join("");
  }
  function unitPanel(l, F, c, uid) {
    const r = c.entries.find((x) => x.uid === uid);
    if (!r || !r.unit) return phead("Unit not found");
    const u = r.unit, e = r.entry;
    const dets = (l.dets || []).map((n) => F.dets[n]).filter(Boolean);
    const opts = C.modelOptions(u, r.copy), adds = C.addonOptions(u, r.copy);
    const errs = c.errors.filter((x) => x.uid === uid).concat(c.warnings.filter((x) => x.uid === uid));
    const used = {}; for (const x of c.entries) if (x.uid !== uid && x.entry.enh) used[x.entry.enh.name] = (used[x.entry.enh.name] || 0) + 1;
    // Enhancements: every enhancement of every selected detachment. Characters see all of them, greyed with the
    // reason when they can't take one (keyword restriction in the text, already taken, one per attached unit,
    // army limit); other units only see the ones they can take (Upgrades, enhancements written for them).
    const isChar = C.isCharacter(u);
    const choices = C.enhancementChoices(l, S.idx, uid);
    const elig = (ch) => C.enhEligible(u, ch.en, F).ok;
    const shown = choices.filter((ch) => (isChar && !C.isEpicHero(u)) || elig(ch) || (e.enh && e.enh.det === ch.d.n && e.enh.name === ch.en[0]));
    let enhHtml = "";
    if (shown.length || (isChar && !C.isEpicHero(u)) || e.enh) {
      const upgradesOnly = !isChar || C.isEpicHero(u);
      const used = c.enhLimit != null ? ` <span class="muted" data-testid="enh-count">${c.enhCount} / ${c.enhLimit} used</span>` : "";
      enhHtml = `<div class="grp" data-testid="enh-grp"><div class="gh">${upgradesOnly && shown.every((ch) => ch.en[3]) ? "Upgrades" : "Enhancement"}${used}</div><div class="gb">
        <label class="opt"><input type="radio" name="enh" value="" ${!e.enh ? "checked" : ""} data-change="enh"><span class="on">None</span></label>
        ${shown.length ? shown.map(({ d, en, ok, reason, taken }) => {
          const checked = e.enh && e.enh.det === d.n && e.enh.name === en[0];
          const dis = !ok && !checked;
          return `<label class="opt${dis ? " disabled" : ""}" data-testid="enh-opt" data-enh="${esc(en[0])}"${dis ? ` title="${esc(reason)}"` : ""}><input type="radio" name="enh" value="${esc(d.n + "||" + en[0])}" ${checked ? "checked" : ""} ${dis ? "disabled" : ""} data-change="enh">
            <span class="on">${esc(en[0])}${en[3] ? ` <span class="tag">Upgrade</span>` : ""}${taken ? ` <span class="tag">taken</span>` : ""}${dets.length > 1 ? ` <span class="muted">(${esc(d.n)})</span>` : ""}${dis && reason ? `<span class="why" data-testid="enh-why">${esc(reason)}</span>` : ""}${checked && !ok && reason ? `<span class="why err">${esc(reason)}</span>` : ""}${en[2] ? `<span class="desc">${esc(clean(en[2]))}</span>` : ""}</span>${pts(en[1])}</label>`;
        }).join("") : `<div class="muted">${dets.length ? "No enhancements available to this unit." : "Select a detachment to see its enhancements."}</div>`}</div></div>`;
    }
    // Attach to: bodyguard units in the list this Leader / Support unit can join
    let attachHtml = "";
    if (C.canAttach(u)) {
      const targets = C.attachTargets(l, S.idx, uid);
      const kindOf = r.attachKind || (u.ldr && u.ldr.length ? "leader" : "support");
      const can = [...new Set([...(u.ldr || []), ...(u.sup || [])])].map(title);
      const curBad = e.attach && !targets.some((t) => t.entry.uid === e.attach);
      attachHtml = `<div class="grp" data-testid="attach-grp"><div class="gh">Attached to <span class="muted">(${kindOf === "support" ? "Support" : "Leader"})</span></div><div class="gb">
        <label class="opt"><input type="radio" name="attach" value="" ${!e.attach ? "checked" : ""} data-change="attach"><span class="on">Not attached</span></label>
        ${targets.map((t) => { const sameName = l.entries.filter((x) => x.unit === t.entry.unit).length > 1; const idx = l.entries.filter((x) => x.unit === t.entry.unit).indexOf(t.entry) + 1;
          const tr = c.entries.find((x) => x.uid === t.entry.uid) || {};
          const gearOf = (row) => new Set((row.loLines || []).flatMap((ln) => ln.gear.map((g) => g.name)));
          const peers = targets.filter((x) => x.entry.unit === t.entry.unit).map((x) => gearOf(c.entries.find((y) => y.uid === x.entry.uid) || {}));
          const mine = [...gearOf(tr)]; const common = (g) => peers.length > 1 && peers.every((p) => p.has(g));
          const gearTxt = mine.length ? mine.map((g) => (peers.length > 1 && !common(g) ? `<b>${esc(g)}</b>` : esc(g))).join(", ") : "";
          const cand = `<span class="cand muted">${esc(tr.modelsLabel || "")}${tr.total != null ? `${tr.modelsLabel ? " · " : ""}${tr.total} pts` : ""}${gearTxt ? ` · ${gearTxt}` : ""}</span>`;
          const checked = e.attach === t.entry.uid; const dis = t.taken && !checked;
          return `<label class="opt${dis ? " disabled" : ""}" data-testid="attach-opt" data-to="${esc(t.entry.uid)}"${dis ? ` title="Already has ${esc(t.kind === "support" ? "a Support unit" : "a Leader")}: ${esc(t.by.join(", "))}"` : ""}><input type="radio" name="attach" value="${esc(t.entry.uid)}" ${checked ? "checked" : ""} ${dis ? "disabled" : ""} data-change="attach">
            <span class="on">${esc(t.entry.unit)}${sameName ? ` #${idx}` : ""}${cand}${dis ? `<span class="why">Already has ${t.kind === "support" ? "a Support unit" : "a Leader"}: ${esc(t.by.join(", "))}</span>` : ""}</span></label>`; }).join("")}
        ${curBad ? `<div class="warn">Currently attached to a unit it can't join – choose another or "Not attached".</div>` : ""}
        ${!targets.length ? `<div class="muted">Add a unit it can join: ${esc(can.join(", "))}.</div>` : ""}</div></div>`;
    }
    const attachedHere = (r.attached || []).length ? `<div class="grp"><div class="gb"><div class="opt"><span class="on"><b>Attached:</b> ${esc(r.attached.map((x) => `${x.name} (${x.attachKind === "support" ? "Support" : "Leader"})`).join(", "))}</span></div></div></div>` : "";
    const strats = dets.flatMap((d) => d.st);
    const linked = C.linkedWargear(u);
    return phead(esc(u.n), `${pts(r.total, "big")} <span class="muted">${esc(u.r)}</span>`,
      `<button class="ibtn" data-action="dup-entry" data-uid="${esc(uid)}" title="Duplicate">${icon("copy")}</button><button class="ibtn danger" data-action="del-entry" data-uid="${esc(uid)}" title="Remove">${icon("trash")}</button>`) +
      `<div class="pbody scroll" data-sk="panel">
        ${errs.length ? `<div class="grp errgrp"><div class="gb">${errs.map((x) => `<div class="${c.errors.includes(x) ? "err" : "warn"}">${esc(x.msg)}</div>`).join("")}</div></div>` : ""}
        ${opts.length ? `<div class="grp"><div class="gh">Unit size${r.copy > 1 ? ` <span class="muted">(${r.copy}${["th", "st", "nd", "rd"][r.copy % 10 > 3 || [11, 12, 13].includes(r.copy % 100) ? 0 : r.copy % 10]} copy)</span>` : ""}</div><div class="gb">
          ${opts.map((o) => `<label class="opt"><input type="radio" name="models" value="${esc(o.models)}" ${o.models === (opts.find((x) => x.models === e.models) ? e.models : opts[0].models) ? "checked" : ""} data-change="models"><span class="on">${esc(o.label)}</span>${pts(o.points)}</label>`).join("")}</div></div>` : ""}
        ${adds.length ? `<div class="grp"><div class="gh">Add-ons</div><div class="gb">${adds.map((a) => `<label class="opt"><input type="checkbox" value="${esc(a.label)}" ${(e.addons || []).includes(a.label) ? "checked" : ""} data-change="addon"><span class="on">${esc(a.label.replace(/^\+\s*/, ""))}</span>${pts(a.points)}</label>`).join("")}</div></div>` : ""}
        ${r.lo ? loadoutTree(u, r) : ""}
        ${(u.w || []).some((w, i) => !linked.has(i)) ? `<div class="grp"><div class="gh">Wargear costs (MFM)</div><div class="gb">${u.w.map((w, i) => linked.has(i) ? "" : `<div class="opt"><span class="on">${esc(w[0])}</span>${pts(w[1])}
          <span class="counter"><button data-action="wg" data-w="${esc(w[0])}" data-d="-1">−</button><span>${esc((e.wargear || {})[w[0]] || 0)}</span><button data-action="wg" data-w="${esc(w[0])}" data-d="1">+</button></span></div>`).join("")}</div></div>` : ""}
        ${C.isCharacter(u) ? `<div class="grp"><div class="gb"><label class="opt"><input type="checkbox" ${e.warlord ? "checked" : ""} data-change="warlord"><span class="on"><b>Warlord</b></span></label></div></div>` : ""}
        ${attachHtml}${attachedHere}
        ${enhHtml}
        <div class="grp"><div class="gh">Notes</div><div class="gb"><textarea class="note" placeholder="Notes (included in exports)" data-change="note">${esc(e.note || "")}</textarea></div></div>
        <details class="coll profiles" open data-testid="profiles"><summary>Profiles${r.attached && r.attached.length ? ` <span class="muted">(combined with ${esc(r.attached.map((x) => x.name).join(", "))})</span>` : ""}</summary><div class="cb">${combinedDatasheet(F, r)}</div></details>
        ${dets.length ? `<details class="coll" data-testid="unit-strats"><summary>Stratagems (${strats.length})${dets.length > 1 ? ` <span class="muted">– ${dets.length} detachments</span>` : ""}</summary><div class="cb">${dets.map((d) => `<div class="stgrp" data-det="${esc(d.n)}"><div class="stgrp-h">${esc(d.n)}${d.rule ? ` <span class="muted">– ${esc(d.rule[0])}</span>` : ""}</div>${d.rule ? `<div class="rules small">${esc(clean(d.rule[1]))}</div>` : ""}${d.st.length ? d.st.map(stratHtml).join("") : `<span class="muted">No stratagem data for this detachment.</span>`}</div>`).join("")}</div></details>` : ""}
      </div>`;
  }
  /* New Recruit-style options tree: model types with counts, fixed weapons, weapon choices per slot */
  function loadoutTree(u, r) {
    const M = C.loModel(u), lo = r.lo, N = C.loN(M, (C.modelOptions(u, r.copy).find((o) => o.models === r.entry.models) || C.modelOptions(u, r.copy)[0] || { models: 1 }).models);
    const priceOf = (o) => o.w !== null && o.w !== undefined && u.w && u.w[o.w] ? ` ${pts(u.w[o.w][1])}` : "";
    const slotHtml = (s, key, k) => {
      if (!k) return "";
      const picks = lo.p[key] || {}; const [a, b] = C.slotRange(s, k);
      const sum = Object.values(picks).reduce((x, y) => x + y, 0);
      const desc = (o) => o.text ? `<span class="desc">${esc(clean(o.text))}</span>` : "";
      let body;
      if (k === 1 && b === 1) {
        const type = a === 1 ? "radio" : "checkbox";
        body = s.opts.map((o) => `<label class="opt"><input type="${type}" name="lo:${esc(r.uid)}:${esc(key)}" ${picks[o.name] ? "checked" : ""} data-change="lo-pick" data-key="${esc(key)}" data-opt="${esc(o.name)}">
          <span class="on">${esc(o.name)}${desc(o)}</span>${priceOf(o)}<button class="ibtn eye-s" data-action="ds-pop" data-unit="${esc(u.n)}" data-item="${esc(o.name)}" title="Profile">${icon("eye")}</button></label>`).join("");
      } else {
        body = s.opts.map((o) => { const v = picks[o.name] || 0; const mx = C.optMax(o, N, s, k);
          return `<div class="opt"><span class="on">${esc(o.name)}${mx !== Infinity ? ` <span class="muted">(max ${mx})</span>` : ""}${desc(o)}</span>${priceOf(o)}<button class="ibtn eye-s" data-action="ds-pop" data-unit="${esc(u.n)}" data-item="${esc(o.name)}" title="Profile">${icon("eye")}</button>
          <span class="counter"><button data-action="lo-inc" data-key="${esc(key)}" data-opt="${esc(o.name)}" data-d="-1" ${v <= 0 ? "disabled" : ""}>−</button><span>${v}</span><button data-action="lo-inc" data-key="${esc(key)}" data-opt="${esc(o.name)}" data-d="1" ${v >= Math.min(mx, b) ? "disabled" : ""}>+</button></span></div>`; }).join("");
      }
      const need = a === b ? `${a}` : `${a}–${b}`;
      // a group holding a single option of the same name (e.g. Redemptor "Icarus Rocket Pod") needs no heading
      const redundant = s.opts.length === 1 && C.norm(s.opts[0].name) === C.norm(s.name) && !(k > 1 || b > 1);
      if (redundant) return `<div class="slot solo">${body}</div>`;
      return `<div class="slot"><div class="slh">${esc(s.name)}${k > 1 || b > 1 ? `<span class="sum${sum < a || sum > b ? " bad" : ""}">${sum} / ${need}</span>` : ""}</div>${body}</div>`;
    };
    const types = M.types.map((t) => {
      const k = lo.c[t.name] || 0, mx = C.typeMax(t, N), mn = t.up || t.addOn ? t.min : C.effMin(M, t, lo.c);
      const adjustable = mx > t.min && (t.up || t.addOn || M.types.filter((x) => !x.up && !x.addOn).length > 1);
      const key = (sl) => `${t.name}|${sl.name}`;
      return `<div class="mt${k ? "" : " zero"}" data-testid="lo-type"><div class="mth"><span class="n">${esc(t.name)}</span>
        ${adjustable ? `<span class="counter"><button data-action="lo-count" data-type="${esc(t.name)}" data-d="-1" ${k <= mn ? "disabled" : ""}>−</button><span>${k}</span><button data-action="lo-count" data-type="${esc(t.name)}" data-d="1" ${k >= mx ? "disabled" : ""}>+</button></span><span class="muted">${mn}–${mx}</span>` : `<span class="muted">×${k}</span>`}${t.fixed.length ? `<button class="ibtn eye-s" data-action="ds-pop" data-unit="${esc(u.n)}" data-item="${esc(t.fixed.join("|"))}" data-title="${esc(t.name)}" title="Profiles of ${esc(t.name)}'s wargear" data-testid="lo-type-eye">${icon("eye")}</button>` : ""}</div>
        <div class="mtb">${t.fixed.length ? `<div class="fixed">${esc(t.fixed.join(", "))}</div>` : ""}${t.slots.map((sl) => slotHtml(sl, key(sl), k)).join("")}</div></div>`;
    }).join("");
    const unitSlots = M.unit.map((sl) => slotHtml(sl, `*|${sl.name}`, 1)).join("");
    return `<div class="grp loadout"><div class="gh">Loadout <span class="muted" title="Unit composition and wargear choices from GrimSlate; points from the Munitorum Field Manual">(GrimSlate)</span></div><div class="gb">${types}${unitSlots ? `<div class="mt"><div class="mth"><span class="n">Unit options</span></div><div class="mtb">${unitSlots}</div></div>` : ""}
      <button class="btn secondary small" data-action="lo-reset">Reset to default loadout</button></div></div>`;
  }
  function previewPanel(l, F, c, name) {
    const u = F.units[name]; if (!u) return phead("Unit not found");
    const n = l.entries.filter((e) => e.unit === name).length;
    return phead(esc(u.n), `${pts(C.minCost(u, n + 1), "big")} <span class="muted">${esc(u.r)}</span>`) + `<div class="pbody scroll" data-sk="panel">
      ${C.unitAllowed(u, l).ok ? `<button class="btn" data-action="add-unit" data-unit="${esc(u.n)}">${icon("plus")} Add to roster</button>` : `<div class="warn">🔒 ${esc(C.unitAllowed(u, l).reason)}</div>`}
      <details class="coll profiles" open data-testid="profiles"><summary>Profiles</summary><div class="cb">${datasheetHtml(F, u, null)}</div></details></div>`;
  }
  function metaChip(l, detName) {
    const md = C.metaDetachment(C.metaFaction(S.wr, l.faction, l.sub), detName);
    if (!md || !md.games) return "";
    return `<a class="wrchip" href="#/meta/${esc(C.metaFaction(S.wr, l.faction, l.sub).slug)}" title="listhammer.info, ${esc((S.wr.date_range || {}).label || "")}: ${md.wins}-${md.losses}">${C.fmtPct(md.win_rate)} · ${md.games} games</a>`;
  }
  /* one detachment's rule + enhancements + stratagems, grouped under its name */
  function detBlock(d, o) {
    o = o || {};
    return `<div class="detfocus${o.preview ? " preview" : ""}" data-testid="det-block" data-det="${esc(d.n)}"><h4>${esc(d.n)} <span class="dpchip">${d.dp} DP</span>${o.preview ? ` <span class="tag">not selected</span>` : ""}</h4>
        ${d.fd && d.fd.length ? `<div class="muted">Force Disposition: ${esc(d.fd.map(dispName).join(", "))}</div>` : ""}
        ${d.sup ? `<div class="muted">${esc([].concat(d.sup).join("; "))}</div>` : ""}
        ${d.gs_dp !== undefined && d.gs_dp !== d.dp ? `<div class="warn">GrimSlate lists ${esc(d.gs_dp)} DP (MFM value used)</div>` : ""}
        ${d.rule ? `<details class="coll"${o.open ? " open" : ""}><summary>Detachment rule: ${esc(d.rule[0])}</summary><div class="cb rules" data-testid="det-rule">${esc(clean(d.rule[1]))}</div></details>` : `<div class="muted">No detachment rule text available.</div>`}
        ${o.noEnh ? "" : `<details class="coll"${o.open ? " open" : ""}><summary>Enhancements (${d.enh.length})</summary><div class="cb">${d.enh.length ? d.enh.map((e) => `<div class="opt"><span class="on"><b>${esc(e[0])}</b>${e[3] ? ` <span class="tag">Upgrade</span>` : ""}${e[2] ? `<span class="desc">${esc(clean(e[2]))}</span>` : ""}</span>${pts(e[1])}</div>`).join("") : `<span class="muted">None listed.</span>`}</div></details>`}
        <details class="coll"${o.open ? " open" : ""}><summary>Stratagems (${d.st.length})</summary><div class="cb" data-testid="det-strats">${d.st.length ? d.st.map(stratHtml).join("") : `<span class="muted">No stratagem data for this detachment.</span>`}</div></details></div>`;
  }
  function detsPanel(l, F, c) {
    const all = F.f.dets.filter((d) => d.dp !== null && d.dp !== undefined);
    const mfm = all.filter((d) => d.src !== "gs"), gs = all.filter((d) => d.src === "gs");
    const selected = new Set(l.dets || []);
    const focus = F.dets[S.ui.focusDet] || F.dets[(l.dets || [])[0]] || mfm[0] || gs[0];
    const size = c.size;
    const over = c.dpLimit != null && c.dp > c.dpLimit && !(size.single3dp && l.dets.length === 1 && c.dp === 3);
    const row = (d) => `<div class="detrow${focus && focus.n === d.n ? " focus" : ""}"><label><input type="checkbox" ${selected.has(d.n) ? "checked" : ""} value="${esc(d.n)}" data-change="det">
        <span>${esc(d.n)}</span><span class="dpchip">${d.dp} Detachment Point${d.dp === 1 ? "" : "s"}</span>${d.src === "gs" ? `<span class="tag gs" title="Not in the current MFM – GrimSlate data">GrimSlate</span>` : ""}
        ${d.chg ? `<span class="tag">updated</span>` : ""}${(d.rs || []).map((x) => `<span class="tag">${esc(x)}</span>`).join("")}${metaChip(l, d.n)}</label>
        <button class="ibtn" data-action="focus-det" data-det="${esc(d.n)}" title="View rules">${icon("eye")}</button></div>`;
    // every selected detachment gets its own block (rule, enhancements, stratagems); an unselected detachment
    // opened with the eye button is shown as a preview after them
    const selDets = (l.dets || []).map((n) => F.dets[n]).filter(Boolean);
    const preview = focus && !selected.has(focus.n) && (S.ui.focusDet === focus.n || !selDets.length) ? focus : null;
    const fd = (selDets.length ? `<div class="detsel-h">Selected detachment${selDets.length === 1 ? "" : "s"} (${selDets.length})</div>` : "") +
      selDets.map((d) => detBlock(d, { open: true })).join("") + (preview ? detBlock(preview, { open: true, preview: true }) : "");
    return phead("Detachment", `<span class="${over ? "err" : "muted"}" data-testid="dp-used">${c.dp}${c.dpLimit != null ? " / " + c.dpLimit : ""} Detachment Points used</span>`) +
      `<div class="pbody scroll" data-sk="panel">
        ${size && size.single3dp ? `<div class="cfgnote">${esc(size.name)}: up to ${size.dp} DP, or a single 3 DP detachment.</div>` : ""}
        <div class="grp"><div class="gb">${mfm.map(row).join("") || "<span class='muted'>No detachments in the MFM.</span>"}</div></div>
        ${gs.length ? `<details class="coll"${gs.some((d) => selected.has(d.n)) ? " open" : ""}><summary>Not in current MFM (GrimSlate) – ${gs.length}</summary><div class="cb">${gs.map(row).join("")}</div></details>` : ""}
        ${fd}</div>`;
  }
  function sizePanel(l, c) {
    return phead("Battle Size") + `<div class="pbody scroll">${(S.data.battle_sizes || []).map((b) => `<label class="opt"><input type="radio" name="size" value="${esc(b.id)}" ${c.size && c.size.id === b.id ? "checked" : ""} data-change="size">
      <span class="on"><b>${esc(b.name)}</b> ${pts(b.points)}<span class="desc">${b.dp != null ? `${b.dp} Detachment Points · ${b.enh} enhancements · max ${b.unit_limit} of each unit (Battleline/Dedicated Transport ${b.unit_limit * 2}; Epic Heroes 1)${b.single3dp ? " · or a single 3 DP detachment" : ""}` : "Limits not defined by the current MFM – only points are checked."}</span></span></label>`).join("")}
      ${(S.data.rules_text || []).length ? `<details class="coll"><summary>Muster rules (MFM)</summary><div class="cb rules">${S.data.rules_text.map(esc).join("\n\n")}</div></details>` : ""}</div>`;
  }
  function dispPanel(l, c) {
    const ds = c.dispositions || [];
    return phead("Force Disposition") + `<div class="pbody scroll">${ds.length ? `<label class="opt"><input type="radio" name="disp" value="" ${!l.disposition ? "checked" : ""} data-change="disp"><span class="on">None</span></label>` +
      ds.map((d) => `<label class="opt"><input type="radio" name="disp" value="${esc(d)}" ${l.disposition === d ? "checked" : ""} data-change="disp"><span class="on">${esc(dispName(d))}</span></label>`).join("")
      : `<span class="muted">Select a detachment first; each detachment lists the Force Dispositions it offers.</span>`}</div>`;
  }
  function errorsPanel(l, c) {
    return phead("Validation", c.errors.length ? `<span class="err">${c.errors.length} error(s)</span>` : `<span class="ok">No errors</span>`) + `<div class="pbody scroll">
      <ul class="errlist">${c.errors.map((x) => `<li class="err"${x.uid ? ` data-action="select-entry" data-uid="${esc(x.uid)}"` : ""}>${esc(x.msg)}</li>`).join("")}</ul>
      ${c.warnings.length ? `<b>Warnings</b><ul class="errlist">${c.warnings.map((x) => `<li class="warn"${x.uid ? ` data-action="select-entry" data-uid="${esc(x.uid)}"` : ""}>${esc(x.msg)}</li>`).join("")}</ul>` : ""}
      ${!c.errors.length && !c.warnings.length ? "<p>This list passes all checks Muster knows about.</p>" : ""}
      <p class="muted">Checks: points limit, Detachment Points, enhancement count/eligibility/duplicates, unit limits (Battleline &amp; Dedicated Transport ×2, Epic Heroes 1), Warlord, Force Disposition. Detachment-granted Battleline is not modelled.</p></div>`;
  }

  /* ------------------------------------------------------------------ export (mirrors New Recruit's export dialog) */
  const enc = (s) => new TextEncoder().encode(s);
  async function streamBytes(bytes, Stream) {
    const s = new Blob([bytes]).stream().pipeThrough(new Stream("deflate-raw"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function encodeShare(l) {
    const json = JSON.stringify(C.shareableList(l));
    if (typeof CompressionStream === "function") { try { return "z" + C.b64urlEncode(await streamBytes(enc(json), CompressionStream)); } catch (e) { /* fall through */ } }
    return "j" + C.b64urlEncode(enc(json));
  }
  async function decodeShare(p) {
    const kind = p[0], bytes = C.b64urlDecode(p.slice(1));
    if (kind === "z") {
      if (typeof DecompressionStream !== "function") throw new Error("This browser cannot open compressed share links");
      return JSON.parse(new TextDecoder().decode(await streamBytes(bytes, DecompressionStream)));
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  const shareBase = () => location.href.split("#")[0];
  async function openShared(payload) {
    try {
      const o = await decodeShare(payload);
      const l = C.listFromShareable(o);
      $("#main").innerHTML = `<div class="empty">Shared list: <b>${esc(l.name)}</b></div>`;
      const m = modal("Import shared list", `<p>Add <b>${esc(l.name)}</b> (${esc((S.idx.subs[l.sub] || {}).name || l.faction)}, ${l.entries.length} units) to your lists?</p>
        <div class="mfoot"><button class="btn secondary" data-action="close-modal">Cancel</button><button class="btn" data-ok>Add to My Lists</button></div>`);
      $("[data-ok]", m).onclick = () => { S.lists.push(l); saveLists(); closeModal(); location.hash = `#/list/${l.id}`; };
    } catch (e) { $("#main").innerHTML = `<div class="empty">Could not read this share link (${esc(e.message)}). <a href="#/lists">My Lists</a></div>`; }
  }
  const EXP = { md: false };
  function exportTextFor(l) {
    const fmt = localStorage.getItem(LS_FMT) || "gw";
    return C.exportText(l, S.idx, S.meta, fmt, { markdown: EXP.md });
  }
  function openExport() {
    const l = CUR; if (!l) return;
    const fmt = localStorage.getItem(LS_FMT) || "gw";
    const text = exportTextFor(l);
    const m = modal("Export", `<div class="exp">
      <div class="expfmts">${C.EXPORT_FORMATS.map((f) => `<label class="opt"><input type="radio" name="fmt" value="${f.id}" ${f.id === fmt ? "checked" : ""} data-change="fmt"><span class="on"><b>${esc(f.name)}</b><span class="desc">${esc(f.desc)}</span></span></label>`).join("")}
        <label class="opt"><input type="checkbox" ${EXP.md ? "checked" : ""} data-change="md"><span class="on">Markdown formatting</span></label></div>
      <textarea readonly data-testid="export-text">${esc(text)}</textarea></div>
      <div class="mfoot wrap">
        <button class="btn" data-action="exp-copy">${icon("copy")} Copy</button>
        <button class="btn secondary" data-action="exp-txt">${icon("import")} Download .txt</button>
        <button class="btn secondary" data-action="exp-discord">Discord</button>
        <button class="btn secondary" data-action="exp-json">JSON</button>
        <button class="btn secondary" data-action="exp-link">Copy share link</button>
        ${navigator.share ? `<button class="btn secondary" data-action="exp-share">Share…</button>` : ""}
        <button class="btn secondary" data-action="exp-print">Print</button></div>`, { wide: true });
    return m;
  }
  function refreshExportPreview() { const ta = $("[data-testid=export-text]"); if (ta && CUR) ta.value = exportTextFor(CUR); }
  function openDiscord() {
    const blocks = C.discordBlocks(C.exportText(CUR, S.idx, S.meta, localStorage.getItem(LS_FMT) || "gw", {}), 2000);
    const m = modal("Copy for Discord", `<p class="muted">Discord messages are limited to 2000 characters, so the list is split into ${blocks.length} code block${blocks.length === 1 ? "" : "s"}.</p>
      ${blocks.map((b, i) => `<div class="dblock"><div class="dh"><b>Message ${i + 1}</b> <span class="muted">${b.length} chars</span><button class="btn" data-copy-block="${i}">${icon("copy")} Copy</button></div><pre>${esc(b)}</pre></div>`).join("")}`, { wide: true });
    $$("[data-copy-block]", m).forEach((b) => { b.onclick = () => copyText(blocks[+b.getAttribute("data-copy-block")]); });
  }
  function printList() {
    const l = CUR; const text = C.exportText(l, S.idx, S.meta, "gw", {});
    const w = window.open("", "_blank");
    if (!w) { window.print(); return; }
    w.document.write(`<!doctype html><title>${esc(l.name)}</title><style>body{font:13px/1.45 system-ui,sans-serif;margin:24px}pre{white-space:pre-wrap;font:inherit}</style><pre>${esc(text)}</pre>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 200);
  }

  /* ------------------------------------------------------------------ list options menu */
  function closeMenus() { $$(".menu").forEach((m) => m.remove()); }
  function openMenu(anchor, items) {
    closeMenus();
    const m = document.createElement("div"); m.className = "menu";
    m.innerHTML = items.map((it, i) => `<button data-mi="${i}" class="${it.danger ? "danger" : ""}">${icon(it.icon || "chev")}${esc(it.label)}</button>`).join("");
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = `${r.bottom + window.scrollY + 2}px`;
    m.style.left = `${Math.max(4, Math.min(r.right - 200, (window.innerWidth || 800) - 204))}px`;
    $$("button", m).forEach((b) => { b.onclick = (e) => { e.stopPropagation(); closeMenus(); items[+b.getAttribute("data-mi")].fn(); }; });
  }
  function listMenu(anchor) {
    const l = CUR;
    openMenu(anchor, [
      { label: "Rename", icon: "pencil", fn: () => renameList(l.id) },
      { label: "Duplicate", icon: "copy", fn: () => { const d = C.duplicateList(l); S.lists.push(d); saveLists(); location.hash = `#/list/${d.id}`; toast("List duplicated"); } },
      { label: "Export…", icon: "export", fn: openExport },
      { label: "Download JSON", icon: "import", fn: () => download(`${fileSafe(l.name)}.muster.json`, C.exportLists([l]), "application/json") },
      { label: "Print", icon: "text", fn: printList },
      { label: "Delete", icon: "trash", danger: true, fn: () => deleteList(l.id) },
    ]);
  }
  function renameList(id) {
    const l = findList(id); if (!l) return;
    promptModal("Rename list", "List Name", l.name, (v) => { l.name = v; l.updated = now(); saveLists(); route(); });
  }
  function deleteList(id) {
    const l = findList(id); if (!l) return;
    confirmModal(`Delete <b>${esc(l.name)}</b>? This cannot be undone.`, "Delete", () => {
      S.lists = S.lists.filter((x) => x.id !== id); saveLists();
      if (CUR && CUR.id === id) { CUR = null; location.hash = "#/lists"; } else route();
      toast("List deleted");
    });
  }
  function importText(text) {
    text = String(text || "").trim();
    const m = text.match(/#\/share\/([A-Za-z0-9_\-]+)/);
    if (m) { location.hash = `#/share/${m[1]}`; closeModal(); return; }
    try {
      const ls = C.importLists(text); S.lists.push(...ls); saveLists(); closeModal(); route();
      toast(`Imported ${ls.length} list${ls.length === 1 ? "" : "s"}`);
    } catch (e) { toast(`Import failed: ${e.message}`, 3500); }
  }
  function importFile() {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".json,application/json,text/plain";
    inp.onchange = () => { const f = inp.files && inp.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => importText(r.result); r.readAsText(f); };
    inp.click();
  }

  /* ------------------------------------------------------------------ Meta Win Rates (mirrors listhammer.info layout) */
  const wrClass = (v) => v === null || v === undefined ? "" : v >= 55 ? "wr-hi" : v >= 52 ? "wr-up" : v <= 45 ? "wr-lo" : v <= 48 ? "wr-dn" : "wr-mid";
  const wrCell = (v, games, min) => (min && (games || 0) < min && !S.ui.showSmall) ? `<span class="muted" title="${esc(C.fmtPct(v))} over ${games} games (fewer than ${min})">—</span>` : `<span class="wr ${wrClass(v)}">${esc(C.fmtPct(v))}</span>`;
  const signed = (v) => v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${Math.round(v)}`;
  const facThumb = (id) => { const F = S.idx && S.idx.factions[id]; return F && F.f.img ? `<img class="lthumb" src="${esc(F.f.img)}" alt="">` : ""; };
  function sortHead(cols, sortState, kind) {
    return `<tr>${cols.map(([k, label, cls]) => `<th class="${cls || ""}${sortState.key === k ? " sorted " + sortState.dir : ""}" data-action="sort" data-kind="${kind}" data-key="${esc(k)}">${esc(label)}${sortState.key === k ? (sortState.dir === "asc" ? " ▲" : " ▼") : ""}</th>`).join("")}</tr>`;
  }
  function metaHeader(t, sub) {
    const W = S.wr;
    return `<div class="meta-h"><div><h2>${t}</h2>${sub || ""}</div><div class="meta-src">Source: <a href="${esc((W && W.source_url) || "https://listhammer.info/stats")}" target="_blank" rel="noopener">listhammer.info</a>${W ? ` · fetched ${esc(localTime(W.fetched_at))}` : ""}</div></div>`;
  }
  function renderMeta(slug) {
    const W = S.wr;
    if (!W || !W.factions) { $("#main").innerHTML = `<div class="meta-page">${metaHeader("Meta Win Rates")}<div class="empty">No win-rate data available yet. It is downloaded with the points data when online.</div></div>`; return; }
    if (slug) return renderMetaFaction(slug);
    const range = S.ui.metaRange === "4weeks" && W.ranges && W.ranges["4weeks"] ? "4weeks" : "weekend";
    const R = (W.ranges && W.ranges[range]) || W.date_range || {};
    const rows = W.factions.map((f) => {
      const src = range === "4weeks" ? (f.last_4_weeks || {}) : f;
      return { slug: f.slug, name: f.name, mfm_id: f.mfm_id, win_rate: src.win_rate, players: src.players, games: src.games, x0: src.x0, x1: src.x1, event_wins: src.event_wins, overrep: src.overrep };
    });
    const sorted = C.sortRows(rows, S.ui.metaSort.key, S.ui.metaSort.dir);
    const disp = W.dispositions_4weeks || [];
    $("#main").innerHTML = `<div class="meta-page">
      ${metaHeader(`${esc(range === "4weeks" ? "Last 4 Weeks" : "This Weekend")} Meta Breakdown`, `<div class="muted">${esc(R.dates || "")}</div>`)}
      <div class="seg"><button class="${range === "weekend" ? "on" : ""}" data-action="meta-range" data-range="weekend">This Weekend</button><button class="${range === "4weeks" ? "on" : ""}" data-action="meta-range" data-range="4weeks">Last 4 Weeks</button></div>
      <div class="tablewrap"><table class="mtable" data-testid="meta-table">${sortHead([["name", "Faction", "l"], ["win_rate", "Win Rate"], ["players", "Players"], ["games", "Games"], ["x0", "X-0"], ["x1", "X-1"], ["event_wins", "Event Wins"], ["overrep", "Overrep"]], S.ui.metaSort, "meta")}
        ${sorted.map((r) => `<tr class="click" data-action="meta-faction" data-slug="${esc(r.slug)}"><td class="l">${facThumb(r.mfm_id)}<span>${esc(r.name)}</span></td>
          <td><div class="wrbar"><span style="width:${Math.max(0, Math.min(100, r.win_rate || 0))}%"></span></div>${wrCell(r.win_rate)}</td><td>${esc(r.players ?? "—")}</td><td>${esc(r.games ?? "—")}</td>
          <td>${esc(r.x0 ?? "—")}</td><td>${esc(r.x1 ?? "—")}</td><td>${esc(r.event_wins ?? "—")}</td><td>${r.overrep != null ? esc(r.overrep.toFixed(2)) + "x" : "—"}</td></tr>`).join("")}</table></div>
      <p class="muted small">Stats are compiled by listhammer.info from 2000-point singles events with 5+ rounds and 16+ players. Mirror matches are excluded. Click a faction for detachments and matchups${range === "4weeks" ? " (faction pages show This Weekend – the 4-week breakdown is only served from listhammer's API, which its robots.txt disallows)" : ""}.</p>
      ${disp.length ? `<h3>Disposition Win Rates <span class="muted small">(last 4 weeks)</span></h3><div class="tablewrap"><table class="mtable"><tr><th class="l">Disposition</th><th>Win Rate</th><th>Games</th><th>Players</th></tr>
        ${disp.map((d) => `<tr><td class="l">${esc(d.name)}</td><td>${wrCell(d.win_rate)}</td><td>${esc(d.games)}</td><td>${esc(d.players ?? "—")}</td></tr>`).join("")}</table></div>` : ""}
    </div>`;
  }
  function sparkline(weekly) {
    if (!weekly || weekly.length < 2) return "";
    const W = 600, H = 120, pad = 18, n = weekly.length;
    const x = (i) => pad + (i * (W - 2 * pad)) / (n - 1), y = (v) => H - pad - ((Math.max(30, Math.min(70, v)) - 30) / 40) * (H - 2 * pad);
    const pts = weekly.map((w, i) => `${x(i).toFixed(1)},${y(w.win_rate || 50).toFixed(1)}`).join(" ");
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Win rate trend">
      ${[70, 50, 30].map((g) => `<line x1="${pad}" x2="${W - pad}" y1="${y(g)}" y2="${y(g)}" class="g${g === 50 ? " mid" : ""}"/><text x="2" y="${y(g) + 4}">${g}%</text>`).join("")}
      <polyline points="${pts}"/>${weekly.map((w, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(w.win_rate || 50).toFixed(1)}" r="3"><title>Week of ${esc(w.week)}: ${esc(C.fmtPct(w.win_rate))} (${esc(w.games)} games)</title></circle>`).join("")}</svg>
      <div class="sparkx muted small"><span>${esc(weekly[0].week)}</span><span>${esc(weekly[n - 1].week)}</span></div>`;
  }
  function renderMetaFaction(slug) {
    const W = S.wr; const f = W.factions.find((x) => x.slug === slug);
    if (!f) { $("#main").innerHTML = `<div class="meta-page"><a href="#/meta">← All factions</a><div class="empty">Faction not found.</div></div>`; return; }
    const F = f.mfm_id && S.idx.factions[f.mfm_id];
    const R = W.date_range || {};
    const tile = (v, l) => `<div class="tile"><div class="tv">${v}</div><div class="tl">${esc(l)}</div></div>`;
    const dets = S.ui.detMode === "single" ? (f.detachments_single || []).map((d) => ({ ...d, field_pct: null })) : (f.detachments || []);
    const dsorted = C.sortRows(dets, S.ui.detSort.key, S.ui.detSort.dir);
    // rows shown as "—" (fewer than 10 games) always sort to the bottom: their key is null unless "show anyway" is on
    const small = (g) => !S.ui.showSmall && (g || 0) < 10;
    const muKey = { win_rate: (m) => small(m.games) ? null : m.win_rate, avg_diff: (m) => small(m.games) ? null : m.avg_diff,
      gf3: (m) => small(m.go_first && m.go_first.games) ? null : m.go_first && m.go_first.win_rate,
      gf4: (m) => small(m.go_first && m.go_first.games) ? null : m.go_first && m.go_first.avg_diff }[S.ui.muSort.key] || S.ui.muSort.key;
    const mus = C.sortRows(f.matchups || [], muKey, S.ui.muSort.dir);
    const detLabel = (d) => d.name === "Unknown" ? `<span class="muted">Unknown</span>` : (d.parts || [d.name]).map((p, i) => {
      const m = (d.mfm ? [].concat(d.mfm) : [])[i] || (d.mfm && !Array.isArray(d.mfm) ? d.mfm : null);
      return `${esc(p)}${m && m.src === "gs" ? `<span class="tag gs" title="Not in current MFM">GS</span>` : ""}`;
    }).join(" <span class='muted'>|</span> ");
    const l4 = f.last_4_weeks;
    $("#main").innerHTML = `<div class="meta-page">
      <a class="backlink" href="#/meta">${icon("back")} All factions</a>
      <div class="fbanner big"${F && F.f.banner ? ` style="background-image:linear-gradient(90deg,rgba(0,0,0,.8),rgba(0,0,0,.2)),url('${esc(F.f.banner)}')"` : ""}><div><div class="fbt">${esc(f.name)}</div><div class="fbs">${esc(R.label || "This Weekend")} · ${esc(R.dates || "")}</div></div>
        <a class="wrchip light" href="${esc(f.url)}" target="_blank" rel="noopener">listhammer ↗</a></div>
      <div class="tiles" data-testid="meta-tiles">${tile(`<span class="${wrClass(f.win_rate)}">${esc(C.fmtPct(f.win_rate))}</span>`, "Win Rate")}${tile(esc(f.games ?? "—"), "Games")}${tile(esc(f.players ?? "—"), "Players")}
        ${tile(esc(f.x0 ?? "—"), "X-0s")}${tile(esc(f.x1 ?? "—"), "X-1s")}${tile(esc(f.event_wins ?? "—"), "Event Wins")}${tile(f.overrep != null ? esc(f.overrep.toFixed(2)) + "x" : "—", "Overrep")}</div>
      <p class="muted small">Compiled from ${esc(f.event_count ?? "?")} qualifying events (5+ rounds, 16+ players) this weekend.
        ${l4 ? `Last 4 weeks: <b>${esc(C.fmtPct(l4.win_rate))}</b> over ${esc(l4.games)} games, ${esc(l4.players)} players.` : ""}
        ${f.overall_6mo ? `Trailing ~6 months: <b>${esc(C.fmtPct(f.overall_6mo.win_rate))}</b> over ${esc(f.overall_6mo.games)} games.` : ""} Mirror matches excluded.</p>
      ${f.weekly && f.weekly.length > 1 ? `<h3>Win Rate Trend</h3><div class="card pad">${sparkline(f.weekly)}</div>` : ""}
      <h3>Detachments</h3>
      <div class="seg"><button class="${S.ui.detMode !== "single" ? "on" : ""}" data-action="det-mode" data-mode="combos">Combinations</button><button class="${S.ui.detMode === "single" ? "on" : ""}" data-action="det-mode" data-mode="single">Per detachment</button></div>
      <div class="tablewrap"><table class="mtable" data-testid="det-table">${sortHead([["name", "Detachment", "l"], ["players", "Players"], ...(S.ui.detMode === "single" ? [] : [["field_pct", "Field %"]]), ["wins", "W-L"], ["games", "Games"], ["win_rate", "Win Rate"]], S.ui.detSort, "det")}
        ${dsorted.map((d) => `<tr><td class="l">${detLabel(d)}</td><td>${esc(d.players ?? "—")}</td>${S.ui.detMode === "single" ? "" : `<td>${d.field_pct != null ? esc(d.field_pct) + "%" : "—"}</td>`}<td>${esc(d.wins ?? 0)}-${esc(d.losses ?? 0)}</td><td>${esc(d.games ?? 0)}</td><td>${wrCell(d.win_rate)}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No detachment data.</td></tr>`}</table></div>
      ${S.ui.detMode === "single" ? `<p class="muted small">Per-detachment figures sum every combination that includes the detachment (derived by Muster).</p>` : ""}
      <h3>Matchups</h3>
      <p class="muted small">${esc(f.name)}'s win rate into each other faction, this weekend. Avg Diff is the mean victory-point margin. Matchups with fewer than 10 games show a dash, like listhammer.
        <label class="inline"><input type="checkbox" ${S.ui.showSmall ? "checked" : ""} data-change="show-small"> show anyway</label></p>
      <div class="tablewrap"><table class="mtable" data-testid="matchup-table">${sortHead([["opponent", "Faction", "l"], ["win_rate", "Win Rate"], ["avg_diff", "Avg Diff"], [(m) => m.go_first && m.go_first.win_rate, "Go 1st WR"], [(m) => m.go_first && m.go_first.avg_diff, "Go 1st Diff"], ["games", "Games"]].map((c, i) => [typeof c[0] === "function" ? `gf${i}` : c[0], c[1], c[2]]), S.ui.muSort, "mu")}
        ${mus.map((m) => `<tr class="click" data-action="meta-faction" data-slug="${esc(m.opponent_slug)}"><td class="l">${facThumb(m.opponent_mfm_id)}<span>${esc(m.opponent)}</span></td><td>${wrCell(m.win_rate, m.games, 10)}</td>
          <td>${(m.games || 0) < 10 && !S.ui.showSmall ? "—" : esc(signed(m.avg_diff))}</td><td>${wrCell(m.go_first && m.go_first.win_rate, m.go_first && m.go_first.games, 10)}</td>
          <td>${(m.go_first && m.go_first.games || 0) < 10 && !S.ui.showSmall ? "—" : esc(signed(m.go_first && m.go_first.avg_diff))}</td><td>${esc(m.games)}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No matchup data.</td></tr>`}</table></div>
      ${f.dispositions && Object.keys(f.dispositions).length ? `<h3>Force Dispositions</h3><div class="tablewrap"><table class="mtable"><tr><th class="l">Disposition</th><th>Players</th></tr>${Object.entries(f.dispositions).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td class="l">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table></div>` : ""}
    </div>`;
  }
  const MU_KEYS = { gf3: (m) => m.go_first && m.go_first.win_rate, gf4: (m) => m.go_first && m.go_first.avg_diff };

  /* ------------------------------------------------------------------ about */
  function about() {
    const m = S.meta || {}; const W = S.wr;
    modal("About Muster", `<p><b>Muster</b> is an unofficial, offline-capable Warhammer 40,000 army list builder for personal use. It is not affiliated with, endorsed by or connected to Games Workshop. Warhammer 40,000 and all faction names and artwork are trademarks/© of Games Workshop.</p>
      <table class="ptable"><tr><td>Points</td><td>Munitorum Field Manual ${esc(m.mfm_version || "?")}, fetched ${esc(m.fetched_at ? localTime(m.fetched_at) : "?")}</td></tr>
      <tr><td>Rules text &amp; stratagems</td><td>GrimSlate (secondary), ${esc(m.gs_fetched_at ? localTime(m.gs_fetched_at) : "?")}</td></tr>
      <tr><td>Win rates</td><td>${W ? `listhammer.info, ${esc((W.date_range || {}).label || "")} ${esc((W.date_range || {}).dates || "")}, fetched ${esc(localTime(W.fetched_at))}` : "not loaded"}</td></tr>
      <tr><td>Data hash</td><td>${esc(m.hash || "?")}</td></tr><tr><td>Saved lists</td><td>${S.lists.length} (stored only on this device)</td></tr></table>
      <div class="mfoot wrap">${S.report ? `<button class="btn secondary" data-action="show-report">Show last points-update report</button>` : ""}<button class="btn secondary" data-action="check-update">Check for points updates</button><button class="btn" data-action="close-modal">Close</button></div>`);
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", cur);
    try { localStorage.setItem(LS_THEME, cur); } catch (e) { /* ignore */ }
    const mt = $("meta[name=theme-color]"); if (mt) mt.setAttribute("content", cur === "dark" ? "#1d1d1d" : "#3C4043");
  }

  /* ------------------------------------------------------------------ events */
  const entryOf = (uid) => CUR && CUR.entries.find((e) => e.uid === uid);
  function addUnit(name) {
    const F = C.getFaction(S.idx, CUR); const u = F && F.units[name]; if (!u) return;
    const e = C.newEntry(u);
    mutate((l) => { l.entries.push(e); });
    if (isPhone()) toast(`Added ${u.n}`); else { S.ui.panel = { type: "unit", uid: e.uid }; renderEditor(CUR.id); }
  }
  const actions = {
    "new-list": () => openCreate(),
    "close-modal": () => closeModal(),
    "modal-bg": (t, ev) => { if (ev.target === t) closeModal(); },
    "pick-group": (t) => { NEW.group = S.data.groups[+t.dataset.i].name; renderCreate(); },
    "pick-sub": (t) => { NEW.sub = t.dataset.id; renderCreate(); },
    "pick-back": () => { if (NEW.sub) NEW.sub = null; else NEW.group = null; renderCreate(); },
    "create-list": () => createList(),
    "open-list": (t) => { location.hash = `#/list/${t.dataset.id}`; },
    "rename-list": (t) => renameList(t.dataset.id),
    "rename-cur": () => CUR && renameList(CUR.id),
    "dup-list": (t) => { const l = findList(t.dataset.id); if (!l) return; S.lists.push(C.duplicateList(l)); saveLists(); route(); toast("List duplicated"); },
    "del-list": (t) => deleteList(t.dataset.id),
    "import-file": () => importFile(),
    "import-text": () => {
      const m = modal("Text Import", `<p class="muted">Paste a Muster JSON export or a Muster share link.</p><textarea autofocus data-import></textarea>
        <div class="mfoot"><button class="btn secondary" data-action="close-modal">Cancel</button><button class="btn" data-ok>Import</button></div>`);
      $("[data-ok]", m).onclick = () => importText($("[data-import]", m).value);
    },
    "export-all": () => download(`muster-lists-${new Date().toISOString().slice(0, 10)}.json`, C.exportLists(S.lists), "application/json"),
    "toggle-theme": () => toggleTheme(),
    "about": () => about(),
    "check-update": async () => { const r = await checkForUpdates(true); if (r.updated || r.wrUpdated) route(); },
    "dismiss-report": () => { if (S.report) { S.report.dismissed = true; try { localStorage.setItem(LS_REPORT, JSON.stringify(S.report)); } catch (e) { /* ignore */ } } renderBanner(); },
    "show-report": () => { if (S.report) { S.report.dismissed = false; closeModal(); renderBanner(); window.scrollTo(0, 0); } },
    // editor
    "tab": (t) => { S.ui.tab = t.dataset.tab; renderEditor(CUR.id); },
    "toggle-sect": (t) => { const k = t.dataset.key; S.ui.collapsed[k] = !S.ui.collapsed[k]; try { localStorage.setItem(LS_COLL, JSON.stringify(S.ui.collapsed)); } catch (e) { /* ignore */ } t.parentElement.classList.toggle("collapsed"); },
    "add-unit": (t) => addUnit(t.dataset.unit),
    "preview-unit": (t) => { S.ui.panel = { type: "preview", unit: t.dataset.unit }; renderEditor(CUR.id); },
    "select-entry": (t) => { S.ui.panel = { type: "unit", uid: t.dataset.uid }; renderEditor(CUR.id); },
    "dup-entry": (t) => { const e = entryOf(t.dataset.uid); if (!e) return; const c = JSON.parse(JSON.stringify(e)); c.uid = C.uid(); c.warlord = false; c.enh = null; delete c.attach;
      mutate((l) => { l.entries.splice(l.entries.indexOf(e) + 1, 0, c); }); },
    "del-entry": (t) => { const uid = t.dataset.uid; if (S.ui.panel && S.ui.panel.uid === uid) S.ui.panel = null; mutate((l) => { l.entries = l.entries.filter((e) => e.uid !== uid); for (const e of l.entries) if (e.attach === uid) delete e.attach; }); },
    "ds-pop": (t, ev) => {
      if (ev) ev.stopPropagation();
      const F = C.getFaction(S.idx, CUR); if (!F) return;
      if (t.dataset.uid) {
        const c = C.calcList(CUR, S.idx); const r = c.entries.find((x) => x.uid === t.dataset.uid); if (!r || !r.unit) return;
        modal(r.attached && r.attached.length ? `${r.name} + ${r.attached.map((x) => x.name).join(" + ")}` : r.name, combinedDatasheet(F, r), { wide: true, sheet: true });
      } else {
        const u = F.units[t.dataset.unit]; if (!u) return;
        const c = C.calcList(CUR, S.idx); const r = S.ui.panel && S.ui.panel.uid ? c.entries.find((x) => x.uid === S.ui.panel.uid && x.unit === u) : null;
        modal(t.dataset.item ? `${t.dataset.title || t.dataset.item} – ${u.n}` : u.n, datasheetHtml(F, u, r || null, { item: t.dataset.item || null }), { wide: true, sheet: true });
      }
    },
    "unlink": (t, ev) => { if (ev) ev.stopPropagation(); const uid = t.dataset.uid; mutate((l) => { const e = l.entries.find((x) => x.uid === uid); if (e) delete e.attach; }); toast("Detached"); },
    "open-panel": (t) => { S.ui.panel = { type: t.dataset.panel }; renderEditor(CUR.id); },
    "close-panel": () => { S.ui.panel = null; renderEditor(CUR.id); },
    "focus-det": (t) => { S.ui.focusDet = t.dataset.det; renderEditor(CUR.id); },
    "wg": (t) => { const uid = S.ui.panel.uid; mutate((l) => { const e = l.entries.find((x) => x.uid === uid); e.wargear = e.wargear || {};
      const v = Math.max(0, (e.wargear[t.dataset.w] || 0) + +t.dataset.d); if (v) e.wargear[t.dataset.w] = v; else delete e.wargear[t.dataset.w]; }); },
    "export": () => openExport(),
    "toggle-vpop": (t) => { const w = t.closest(".dotwrap"); w.classList.toggle("open"); },
    "chg-info": (t, ev) => { ev.stopPropagation(); const F = C.getFaction(S.idx, CUR); const u = F && F.units[t.dataset.unit]; if (u) toast(chgText(u), 3500); },
    "lo-count": (t) => withLo((lo, r, u, N) => C.setModelCount(u, lo, t.dataset.type, (lo.c[t.dataset.type] || 0) + +t.dataset.d, N)),
    "lo-inc": (t) => withLo((lo, r, u, N) => loInc(u, lo, t.dataset.key, t.dataset.opt, +t.dataset.d, N)),
    "lo-reset": () => withLo(() => null),
    "list-menu": (t) => listMenu(t),
    "exp-copy": () => copyText(exportTextFor(CUR)),
    "exp-txt": () => download(`${fileSafe(CUR.name)}.txt`, exportTextFor(CUR)),
    "exp-discord": () => openDiscord(),
    "exp-json": () => download(`${fileSafe(CUR.name)}.muster.json`, C.exportLists([CUR]), "application/json"),
    "exp-link": async () => copyText(`${shareBase()}#/share/${await encodeShare(CUR)}`),
    "exp-share": async () => { try { await navigator.share({ title: CUR.name, text: exportTextFor(CUR), url: `${shareBase()}#/share/${await encodeShare(CUR)}` }); } catch (e) { /* cancelled */ } },
    "exp-print": () => printList(),
    // meta
    "meta-faction": (t) => { location.hash = `#/meta/${t.dataset.slug}`; window.scrollTo(0, 0); },
    "meta-range": (t) => { S.ui.metaRange = t.dataset.range; try { localStorage.setItem(LS_WRRANGE, S.ui.metaRange); } catch (e) { /* ignore */ } renderMeta(null); },
    "det-mode": (t) => { S.ui.detMode = t.dataset.mode; route(); },
    "sort": (t) => {
      const st = { meta: S.ui.metaSort, det: S.ui.detSort, mu: S.ui.muSort }[t.dataset.kind]; const k = t.dataset.key;
      if (st.key === k) st.dir = st.dir === "asc" ? "desc" : "asc"; else { st.key = k; st.dir = ["name", "opponent"].includes(k) ? "asc" : "desc"; }
      route();
    },
  };
  /* edit the selected entry's loadout: fn(normalisedLoadout, row, unit, unitSize) -> new loadout (null = defaults) */
  function withLo(fn) {
    const uid = S.ui.panel && S.ui.panel.uid; if (!uid) return;
    mutate((l) => {
      const c = C.calcList(l, S.idx); const r = c.entries.find((x) => x.uid === uid); if (!r || !r.lo) return;
      const N = C.loN(C.loModel(r.unit), (C.modelOptions(r.unit, r.copy).find((o) => o.models === r.entry.models) || C.modelOptions(r.unit, r.copy)[0] || { models: 1 }).models);
      const res = fn(JSON.parse(JSON.stringify(r.lo)), r, r.unit, N);
      if (res === null) delete r.entry.lo; else r.entry.lo = res;
    });
  }
  function slotOf(u, key) {
    const M = C.loModel(u); const [tn, sn] = key.split("|");
    const t = tn === "*" ? null : M.types.find((x) => x.name === tn);
    return { s: (t ? t.slots : M.unit).find((x) => x.name === sn), t };
  }
  function loInc(u, lo, key, opt, d, N) {
    const { s, t } = slotOf(u, key); if (!s) return lo;
    const k = t ? lo.c[t.name] || 0 : 1; const [a, b] = C.slotRange(s, k);
    const p = { ...(lo.p[key] || {}) }; const sum = Object.values(p).reduce((x, y) => x + y, 0);
    const o = s.opts.find((x) => x.name === opt); if (!o) return lo;
    const donor = () => { const pref = s.defaults.find((n) => n !== opt && p[n] > 0); if (pref) return pref;
      return Object.keys(p).filter((n) => n !== opt && p[n] > 0).sort((x, y) => p[y] - p[x])[0]; };
    if (d > 0) {
      if ((p[opt] || 0) >= C.optMax(o, N, s, k)) return lo;
      if (sum >= b) { const dn = donor(); if (!dn) return lo; p[dn]--; if (!p[dn]) delete p[dn]; }
      p[opt] = (p[opt] || 0) + 1;
    } else {
      if (!(p[opt] > 0)) return lo;
      if (sum <= a) { const rc = s.defaults.find((n) => n !== opt) || s.opts.map((x) => x.name).find((n) => n !== opt); if (!rc) return lo; p[rc] = (p[rc] || 0) + 1; }
      p[opt]--; if (!p[opt]) delete p[opt];
    }
    return { c: lo.c, p: { ...lo.p, [key]: p } };
  }
  const changes = {
    "legends": (t) => mutate((l) => { l.showLegends = t.checked; }),
    "show-locked": (t) => mutate((l) => { l.showLocked = t.checked; }),
    "leaders-own": (t) => mutate((l) => { if (t.checked) l.leadersOwnCat = true; else delete l.leadersOwnCat; }),
    "attach": (t) => mutate((l) => { const e = l.entries.find((x) => x.uid === S.ui.panel.uid); if (!e) return; if (t.value) e.attach = t.value; else delete e.attach; }),
    "size": (t) => mutate((l) => { l.size = t.value; }),
    "disp": (t) => mutate((l) => { if (t.value) l.disposition = t.value; else delete l.disposition; }),
    "det": (t) => mutate((l) => {
      const n = t.value; l.dets = l.dets || [];
      if (t.checked) { if (!l.dets.includes(n)) l.dets.push(n); S.ui.focusDet = n; }
      else {
        l.dets = l.dets.filter((x) => x !== n);
        let dropped = 0; for (const e of l.entries) if (e.enh && e.enh.det === n) { e.enh = null; dropped++; }
        if (dropped) toast(`Removed ${dropped} enhancement${dropped === 1 ? "" : "s"} from ${n}`);
      }
      const F = C.getFaction(S.idx, l); const fds = [...new Set(l.dets.flatMap((x) => (F.dets[x] && F.dets[x].fd) || []))];
      if (l.disposition && !fds.includes(l.disposition)) delete l.disposition;
      if (!l.disposition && fds.length === 1) l.disposition = fds[0];
    }),
    "models": (t) => { const uid = S.ui.panel.uid; mutate((l) => { l.entries.find((x) => x.uid === uid).models = t.value === "null" ? null : +t.value; }); },
    "addon": (t) => { const uid = S.ui.panel.uid; mutate((l) => { const e = l.entries.find((x) => x.uid === uid); e.addons = (e.addons || []).filter((a) => a !== t.value); if (t.checked) e.addons.push(t.value); }); },
    "warlord": (t) => { const uid = S.ui.panel.uid; mutate((l) => { for (const e of l.entries) e.warlord = t.checked ? e.uid === uid : (e.uid === uid ? false : e.warlord); }); },
    "enh": (t) => { const uid = S.ui.panel.uid; mutate((l) => { const e = l.entries.find((x) => x.uid === uid); if (!t.value) e.enh = null; else { const [det, name] = t.value.split("||"); e.enh = { det, name }; } }); },
    "note": (t) => { const uid = S.ui.panel.uid; mutate((l) => { const e = l.entries.find((x) => x.uid === uid); const v = t.value.trim(); if (v) e.note = v; else delete e.note; }); },
    "new-size": (t) => { NEW.size = t.value; },
    "lo-pick": (t) => withLo((lo, r, u) => {
      const { s } = slotOf(u, t.dataset.key); const p = {};
      if (t.type === "radio" || t.checked) p[t.dataset.opt] = 1;   // radio: exactly one; checkbox (0–1): toggle
      if (t.type === "checkbox" && !t.checked) { /* none selected */ }
      return { c: lo.c, p: { ...lo.p, [t.dataset.key]: s ? p : lo.p[t.dataset.key] } };
    }),
    "fmt": (t) => { try { localStorage.setItem(LS_FMT, t.value); } catch (e) { /* ignore */ } refreshExportPreview(); },
    "md": (t) => { EXP.md = t.checked; refreshExportPreview(); },
    "show-small": (t) => { S.ui.showSmall = t.checked; route(); },
  };
  const inputs = {
    "cat-search": (t) => { S.ui.q = t.value; const F = C.getFaction(S.idx, CUR); const body = $("#catbody"); if (body && F) body.innerHTML = renderCatalogBody(CUR, F, C.calcList(CUR, S.idx)); },
    "list-search": (t) => { S.ui.listQ = t.value; const pos = t.selectionStart; renderLists(); const n = $("[data-input=list-search]"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } } },
    "new-name": (t) => { NEW.name = t.value; },
  };
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".menu")) closeMenus();
    const t = ev.target.closest("[data-action]"); if (!t) return;
    const a = actions[t.dataset.action]; if (!a) return;
    if (t.tagName === "A" && t.getAttribute("href") && !t.getAttribute("href").startsWith("#")) return;
    if (t.tagName === "BUTTON" || t.tagName === "A") ev.preventDefault();
    a(t, ev);
  });
  let SW = null;
  document.addEventListener("touchstart", (ev) => { const row = ev.target.closest && ev.target.closest(".roster .urow"); if (!row || !ev.touches || !ev.touches[0]) { SW = null; return; } SW = { row, x: ev.touches[0].clientX, y: ev.touches[0].clientY }; }, { passive: true });
  document.addEventListener("touchend", (ev) => {
    if (!SW) return; const t = ev.changedTouches && ev.changedTouches[0]; if (!t) { SW = null; return; }
    const dx = t.clientX - SW.x, dy = t.clientY - SW.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      document.querySelectorAll(".urow.swiped").forEach((x) => { if (x !== SW.row) x.classList.remove("swiped"); });
      SW.row.classList.toggle("swiped", dx < 0);
    }
    SW = null;
  }, { passive: true });
  document.addEventListener("change", (ev) => { const t = ev.target.closest("[data-change]"); if (t && changes[t.dataset.change]) changes[t.dataset.change](t, ev); });
  document.addEventListener("input", (ev) => { const t = ev.target.closest("[data-input]"); if (t && inputs[t.dataset.input]) inputs[t.dataset.input](t, ev); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { if ($("#modal").innerHTML) closeModal(); else if (S.ui.panel && CUR) { S.ui.panel = null; renderEditor(CUR.id); } } });

  window.Muster = { S, route, checkForUpdates, applyNewData, setData, encodeShare, decodeShare, boot, idb, actions, changes };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
