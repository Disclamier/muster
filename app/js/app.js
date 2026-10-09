/* Muster app shell: routing, rendering, storage, data updates. Classic script; depends on window.MusterCore. */
(function () {
  "use strict";
  const C = window.MusterCore;
  const LS_LISTS = "muster.lists", LS_THEME = "muster.theme", LS_FMT = "muster.exportFormat", LS_REPORT = "muster.updateReport",
    LS_COLL = "muster.collapsed", LS_WRRANGE = "muster.metaRange", LS_TOMBS = "muster.tombs", LS_OWNER = "muster.sync.owner",
    LS_PENDING = "muster.pendingHash", LS_GUEST = "muster.guest", LS_WRRTT = "muster.metaRtt", LS_WRTAB = "muster.metaTab", LS_WRHOME = "muster.metaHome";
  const ROLE_ICON = "unit";

  /* ------------------------------------------------------------------ state */
  const S = {
    data: null, idx: null, meta: null, wr: null, lists: [], tombs: {}, report: null, sync: null,
    ui: { panel: null, q: "", tab: "roster", focusDet: null, collapsed: {}, listQ: "", metaSort: { key: "win_rate", dir: "desc" },
      detSort: { key: "games", dir: "desc" }, muSort: { key: "win_rate", dir: "desc" }, detMode: "combos", metaRange: "weekend", showSmall: false,
      metaRtt: false, metaTab: "overview", metaHome: "factions", metaQ: "", metaDispOpen: null, metaListDet: "" },
  };
  try { S.ui.collapsed = JSON.parse(localStorage.getItem(LS_COLL) || "{}"); } catch (e) { S.ui.collapsed = {}; }
  try { S.ui.metaRange = localStorage.getItem(LS_WRRANGE) || "weekend"; S.ui.metaRtt = localStorage.getItem(LS_WRRTT) === "1";
    S.ui.metaTab = localStorage.getItem(LS_WRTAB) || "overview"; S.ui.metaHome = localStorage.getItem(LS_WRHOME) || "factions"; } catch (e) { /* ignore */ }

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
  function loadLists() {
    try { S.lists = JSON.parse(localStorage.getItem(LS_LISTS) || "[]"); } catch (e) { S.lists = []; }
    try { S.tombs = JSON.parse(localStorage.getItem(LS_TOMBS) || "{}") || {}; } catch (e) { S.tombs = {}; }
  }
  function storeLists() {
    try { localStorage.setItem(LS_LISTS, JSON.stringify(S.lists)); } catch (e) { toast("Could not save – storage full?"); }
    try { if (Object.keys(S.tombs).length) localStorage.setItem(LS_TOMBS, JSON.stringify(S.tombs)); else localStorage.removeItem(LS_TOMBS); } catch (e) { /* ignore */ }
  }
  /* every list change (create / edit / rename / delete / import) goes through here: saved locally, then pushed to the account (debounced) */
  function saveLists() { storeLists(); if (SY && SY.configured && SY.session()) SY.schedulePush(); }
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

  /* ------------------------------------------------------------------ accounts + cloud sync (Supabase; js/sync.js) */
  const SY = window.MusterSync ? window.MusterSync.create(window.MUSTER_CONFIG || {}, {
    getLocal: () => ({ lists: S.lists, tombs: S.tombs }),
    apply: (res) => applyMerge(res),
    onStatus: (i) => { S.sync = i; renderAcct(); },
    onSignedOut: (reason) => { if (reason === "expired") { AUTH.msg = { err: true, text: "Your session expired – please sign in again. Your lists are safe on this device." }; route(); } },
  }) : null;
  /* guest mode ("Try it without an account"): the whole app, lists saved only on this device, nothing syncs, max GUEST_MAX list(s) */
  const GUEST_MAX = 1;
  const nLists = (n) => `${n} list${n === 1 ? "" : "s"}`;
  const guestFlag = () => { try { return localStorage.getItem(LS_GUEST) === "1"; } catch (e) { return false; } };
  const isGuest = () => !!(SY && SY.configured && !SY.session() && guestFlag());
  const authWall = () => !!(SY && SY.configured && !SY.session() && !guestFlag());
  /* in-place update keeps references (CUR, open panels) pointing at the live list object */
  function applyMerge(res) {
    S.tombs = res.tombs;
    if (!res.changed) { storeLists(); return; }
    const byId = new Map(S.lists.map((l) => [l.id, l]));
    S.lists = res.lists.map((l) => {
      const old = byId.get(l.id);
      if (old && old !== l) { for (const k of Object.keys(old)) delete old[k]; Object.assign(old, l); l = old; }
      if (S.idx && (res.added.includes(l.id) || res.replaced.includes(l.id))) { try { l.total = C.calcList(l, S.idx).total; } catch (e) { /* ignore */ } }
      return l;
    });
    storeLists();
    const h = location.hash || "#/lists";
    const curId = CUR && CUR.id;
    if (curId && res.removed.includes(curId) && h.startsWith("#/list/")) { CUR = null; toast("This list was deleted on another device", 3000); location.hash = "#/lists"; return; }
    const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && document.activeElement.closest("#main");
    if ($("#modal").innerHTML || typing) return;
    if (!h.startsWith("#/list/") && !h.startsWith("#/meta") && !h.startsWith("#/share/")) route();
    else if (curId && res.replaced.includes(curId) && h.startsWith("#/list/")) route();
  }
  /* which account the lists in localStorage belong to. Lists made before the first sign-in (no owner) are uploaded
     to the account; a different account's lists are parked under muster.stash.<id> so nothing is lost or mixed. */
  function adoptAccount(user) {
    const owner = localStorage.getItem(LS_OWNER);
    if (owner === user.id) return;
    if (owner) stashAccount(owner);
    try {
      const st = JSON.parse(localStorage.getItem(`muster.stash.${user.id}`) || "null");
      if (st) {
        const have = new Set(S.lists.map((l) => l.id));
        S.lists.push(...(st.lists || []).filter((l) => !have.has(l.id)));
        S.tombs = { ...(st.tombs || {}), ...S.tombs };
        if (st.known) localStorage.setItem(SY.LS_KNOWN, JSON.stringify(st.known));
        localStorage.removeItem(`muster.stash.${user.id}`);
      }
    } catch (e) { /* ignore */ }
    for (const l of S.lists) if (!l.updated) l.updated = now();
    localStorage.setItem(LS_OWNER, user.id);
    storeLists();
  }
  function stashAccount(owner) {
    try { localStorage.setItem(`muster.stash.${owner}`, JSON.stringify({ lists: S.lists, tombs: S.tombs, known: JSON.parse(localStorage.getItem(SY.LS_KNOWN) || "{}") })); } catch (e) { /* ignore */ }
    clearLocalAccountData();
  }
  function clearLocalAccountData() {
    S.lists = []; S.tombs = {}; CUR = null;
    for (const k of [LS_LISTS, LS_TOMBS, LS_OWNER, SY.LS_KNOWN]) localStorage.removeItem(k);
  }
  function afterSignIn() {
    adoptAccount(SY.user());   // guest lists have no owner, so they are kept and uploaded into the account
    try { localStorage.removeItem(LS_GUEST); } catch (e) { /* ignore */ }
    document.body.classList.remove("auth-wall");
    AUTH.msg = null; closeModal();
    let pend = null; try { pend = localStorage.getItem(LS_PENDING); localStorage.removeItem(LS_PENDING); } catch (e) { /* ignore */ }
    const h = location.hash || "";
    if (pend && (!h || h === "#" || h === "#/lists" || !h.startsWith("#/"))) { history.replaceState(null, "", pend); }
    route(); renderAcct();
    SY.syncNow({ pull: true }).then((ok) => { if (ok && S.lists.length) renderAcct(); });
  }
  const SYNC_TXT = { synced: "Synced", syncing: "Syncing…", offline: "Offline", error: "Sync error", idle: "Signed in", signedout: "Signed out" };
  function syncTooltip(i) {
    if (!i) return "";
    const t = { synced: `All lists synced${i.lastSync ? " · " + localTime(i.lastSync) : ""}`, syncing: "Syncing your lists…",
      offline: `Offline – ${i.pending ? i.pending + " change(s) will upload when you're back online" : "changes upload when you're back online"}`,
      error: `Sync error: ${i.error || "unknown"} – will retry`, idle: "Signed in", signedout: "Not signed in" }[i.status] || "";
    return `${i.email ? i.email + " · " : ""}${t}`;
  }
  function renderAcct() {
    const b = $("#acct"); if (!b) return;
    const use = $("use", b), lbl = $(".lbl", b);
    if (isGuest()) {
      b.hidden = false; b.className = "hbtn acct guest"; b.title = `Guest mode – ${S.lists.length}/${nLists(GUEST_MAX)}, saved only on this device. Tap to create a free account.`;
      b.dataset.action = "guest-info"; b.setAttribute("data-testid", "guest-btn"); if (use) use.setAttribute("href", "#i-user");
      lbl.textContent = "Guest"; lbl.classList.remove("lbl-opt"); return;
    }
    b.dataset.action = "account"; b.removeAttribute("data-testid"); if (use) use.setAttribute("href", "#i-cloud"); lbl.classList.add("lbl-opt");
    if (!SY || !SY.configured || !SY.session()) { b.hidden = true; return; }
    const i = S.sync || SY.info();
    b.hidden = false; b.className = `hbtn acct s-${i.status}`; b.title = syncTooltip(i);
    lbl.textContent = SYNC_TXT[i.status] || "Account";
  }
  function accountModal() {
    if (!SY || !SY.session()) return;
    const i = SY.info();
    const m = modal("Account", `<table class="ptable" data-testid="account-info"><tr><td>Signed in as</td><td><b>${esc(i.email || "")}</b></td></tr>
      <tr><td>Sync</td><td><span class="sync-pill s-${esc(i.status)}">${esc(SYNC_TXT[i.status] || i.status)}</span> ${esc(syncTooltip({ ...i, email: null }))}</td></tr>
      <tr><td>Lists</td><td>${S.lists.length} – saved on this device and in your account; changes sync automatically to every device you sign in on.</td></tr></table>
      <div class="mfoot wrap"><button class="btn secondary" data-action="sync-now">${icon("refresh")} Sync now</button><button class="btn danger" data-action="sign-out">Sign out</button><button class="btn" data-action="close-modal">Close</button></div>`);
    return m;
  }
  async function signOut() {
    const i = await SY.flush();
    const go = async () => {
      if (i.pending) stashAccount(localStorage.getItem(LS_OWNER) || SY.user().id);   // unsynced changes stay on this device for next sign-in
      else clearLocalAccountData();                                                       // everything is in the account
      try { localStorage.removeItem(LS_GUEST); } catch (e) { /* ignore */ }   // back to the sign-in screen, never into guest mode
      await SY.signOut(); closeModal(); AUTH.mode = "signin"; AUTH.msg = { text: "Signed out." };
      if (location.hash !== "#/lists") location.hash = "#/lists"; route();
    };
    if (i.pending) confirmModal(`${i.pending} change${i.pending === 1 ? " hasn't" : "s haven't"} uploaded yet (offline?). Sign out anyway? They stay on this device and upload the next time you sign in here.`, "Sign out", go);
    else go();
  }
  /* ---- guest mode */
  function startGuest() {
    // lists still on this device from an account whose session ended belong to that account: park them for its next sign-in
    const owner = localStorage.getItem(LS_OWNER);
    if (owner) stashAccount(owner);
    try { localStorage.setItem(LS_GUEST, "1"); localStorage.removeItem(LS_PENDING); } catch (e) { /* ignore */ }
    AUTH.msg = null; document.body.classList.remove("auth-wall");
    route(); renderAcct();
    toast(`Guest mode – ${GUEST_MAX === 1 ? "1 list" : `up to ${GUEST_MAX} lists`}, saved on this device`, 3000);
  }
  /* leave guest mode for the sign-in / create-account screen; guest lists stay on this device and go into the account on sign-in */
  function leaveGuest(mode, msg) {
    try { localStorage.removeItem(LS_GUEST); } catch (e) { /* ignore */ }
    closeModal(); AUTH.mode = mode || "signin"; AUTH.msg = msg ? { text: msg } : null;
    route(); renderAcct();
  }
  const guestKeep = () => S.lists.length ? ` Your guest ${S.lists.length === 1 ? "list" : `lists (${S.lists.length})`} will be added to your account.` : "";
  function guestModal() {
    const n = S.lists.length;
    return modal("Guest mode", `<div class="guest-box" data-testid="guest-info"><p>You're using Muster without an account. Your lists are saved <b>only on this device</b> and don't sync.</p>
      <p class="guest-count"><b>${n} of ${GUEST_MAX}</b> guest ${GUEST_MAX === 1 ? "list" : "lists"} used.</p>
      <p class="muted">Create a free account to save unlimited lists and sync them between your PC and phone. Your guest list comes with you.</p></div>
      <div class="mfoot wrap guest-foot"><button class="btn" data-action="guest-signup" data-testid="guest-signup">Create free account</button><button class="btn secondary" data-action="guest-signin">Sign in</button>
        <button class="btn secondary" data-action="guest-exit" data-testid="guest-exit">Exit guest mode</button><button class="btn secondary" data-action="close-modal">Close</button></div>`);
  }
  function guestLimitModal(extra) {
    return modal("List limit reached", `<div class="guest-box" data-testid="guest-limit">${extra ? `<p><b>${esc(extra)}</b></p>` : ""}
      <p>Guest mode is limited to ${GUEST_MAX === 1 ? "1 list" : `${GUEST_MAX} lists`}. Create a free account to save unlimited lists and sync them between your PC and phone.</p>
      <p class="muted">Your guest list is kept and moved into your new account.</p></div>
      <div class="mfoot wrap guest-foot"><button class="btn" data-action="guest-signup">Create account</button><button class="btn secondary" data-action="guest-signin">Sign in</button><button class="btn secondary" data-action="close-modal">Cancel</button></div>`);
  }
  /* how many more lists this device may hold (Infinity unless in guest mode) */
  const guestRoom = () => isGuest() ? Math.max(0, GUEST_MAX - S.lists.length) : Infinity;
  /* true (and shows the limit dialog) when adding n lists would go past the guest limit */
  function guestBlocked(n) { if (guestRoom() >= (n || 1)) return false; guestLimitModal(); return true; }
  /* sign-in / create-account screen (shown instead of every page while signed out, when accounts are configured) */
  const AUTH = { mode: "signin", msg: null, busy: false, email: "" };
  function renderAuth() {
    document.body.classList.add("auth-wall"); document.body.classList.remove("app-fixed");
    const h = location.hash || "";
    if (/^#\/(share|list|meta)\//.test(h) || h === "#/meta") { try { localStorage.setItem(LS_PENDING, h); } catch (e) { /* ignore */ } }
    const ctx = h.startsWith("#/share/") ? "Sign in or create a free account to add the shared list to your lists."
      : h.startsWith("#/meta") ? "Sign in or create a free account to view Meta Win Rates."
      : "Create a free account so your lists sync automatically between your PC and phone.";
    const M = AUTH.mode;
    const ttl = M === "signup" ? "Create account" : M === "forgot" ? "Reset password" : "Sign in";
    $("#main").innerHTML = `<div class="auth-page"><form class="auth-card" data-form="auth" data-testid="auth-screen" novalidate>
      <div class="auth-brand"><img src="icons/icon-192.png" alt=""><div><b>Muster</b><small>40K army list builder</small></div></div>
      ${M !== "forgot" ? `<div class="seg auth-tabs"><button type="button" class="${M === "signin" ? "on" : ""}" data-action="auth-mode" data-mode="signin">Sign in</button><button type="button" class="${M === "signup" ? "on" : ""}" data-action="auth-mode" data-mode="signup">Create account</button></div>` : `<h3>${ttl}</h3>`}
      <p class="muted small">${M === "forgot" ? "Enter your account email and we'll send you a link to set a new password." : esc(ctx)}</p>
      ${AUTH.msg ? `<div class="auth-msg${AUTH.msg.err ? " err" : ""}" role="status">${esc(AUTH.msg.text)}</div>` : ""}
      <label class="l" for="auth-email">Email</label><input id="auth-email" type="email" name="email" autocomplete="email" inputmode="email" required value="${esc(AUTH.email)}" data-testid="auth-email">
      ${M !== "forgot" ? `<label class="l" for="auth-pw">Password</label><input id="auth-pw" type="password" name="password" required minlength="6" autocomplete="${M === "signup" ? "new-password" : "current-password"}" data-testid="auth-password">` : ""}
      ${M === "signup" ? `<label class="l" for="auth-pw2">Confirm password</label><input id="auth-pw2" type="password" name="password2" required minlength="6" autocomplete="new-password">` : ""}
      <button class="btn auth-go" type="submit" ${AUTH.busy ? "disabled" : ""} data-testid="auth-submit">${AUTH.busy ? "Please wait…" : M === "signup" ? "Create free account" : M === "forgot" ? "Send reset link" : "Sign in"}</button>
      <div class="auth-links">${M === "signin" ? `<a href="#" data-action="auth-mode" data-mode="forgot">Forgot password?</a>` : `<a href="#" data-action="auth-mode" data-mode="signin">Back to sign in</a>`}</div>
      ${M !== "forgot" ? `<div class="auth-or"><span>or</span></div>
      <button type="button" class="btn secondary auth-guest" data-action="guest-start" data-testid="guest-start">Try it without an account</button>
      <p class="muted small auth-guest-note">${GUEST_MAX === 1 ? "Build 1 list" : `Up to ${GUEST_MAX} lists`}, saved only on this device. Create an account later and keep it.</p>` : ""}
      <p class="muted small">Your lists are private to your account. Muster is an unofficial fan tool.</p>
    </form></div>`;
    $("#banner").innerHTML = "";
    if (S.meta) renderFooter(); else $("#footer").innerHTML = "Muster is an <b>unofficial</b> fan tool, not affiliated with or endorsed by Games Workshop.";
    setActiveNav();
  }
  async function submitAuth(form) {
    if (AUTH.busy) return;
    const fv = (n) => { const el = form.querySelector(`[name=${n}]`); return el ? el.value : ""; };
    const email = fv("email").trim(), pw = fv("password"), M = AUTH.mode;
    AUTH.email = email;
    const fail = (text) => { AUTH.busy = false; AUTH.msg = { err: true, text }; renderAuth(); };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter a valid email address.");
    if (M !== "forgot" && pw.length < 6) return fail("Password must be at least 6 characters.");
    if (M === "signup" && pw !== fv("password2")) return fail("The passwords don't match.");
    AUTH.busy = true; AUTH.msg = null; renderAuth();
    try {
      if (M === "forgot") { await SY.recover(email); AUTH.busy = false; AUTH.mode = "signin"; AUTH.msg = { text: `If ${email} has an account, a password reset link is on its way. Open it on this device.` }; renderAuth(); return; }
      const r = M === "signup" ? await SY.signUp(email, pw) : await SY.signIn(email, pw);
      AUTH.busy = false;
      if (r.confirm) { AUTH.mode = "signin"; AUTH.msg = { text: `Almost done: we sent a confirmation link to ${email}. Open it, then sign in here.` }; renderAuth(); return; }
      toast(M === "signup" ? "Account created – your lists now sync" : "Signed in");
      afterSignIn();
    } catch (e) {
      const m = String(e.message || e);
      fail(e.kind === "offline" ? "You're offline – connect to the internet to sign in." : /invalid login/i.test(m) ? "Wrong email or password." : /not confirmed/i.test(m) ? "Please confirm your email first (check your inbox), then sign in." : m);
    }
  }
  function newPasswordModal() {
    const m = modal("Set a new password", `<label class="l">New password</label><input type="password" class="wide" minlength="6" autocomplete="new-password" autofocus data-newpw>
      <div class="mfoot"><button class="btn secondary" data-action="close-modal">Later</button><button class="btn" data-ok>Save password</button></div>`);
    $("[data-ok]", m).onclick = async () => {
      const v = $("[data-newpw]", m).value; if (v.length < 6) { toast("At least 6 characters"); return; }
      try { await SY.updatePassword(v); closeModal(); toast("Password updated"); } catch (e) { toast(`Could not update password: ${e.message}`, 3500); }
    };
  }
  async function initSync() {
    if (!SY || !SY.configured) return;
    const h = location.hash || "";
    if (/(^#|&)(access_token|error_description|error)=/.test(h.replace(/^#\/?/, "#"))) {   // email confirmation / password reset link
      const r = await SY.consumeRedirect(h);
      history.replaceState(null, "", location.pathname + location.search + "#/lists");
      if (r && r.error) AUTH.msg = { err: true, text: `That link didn't work: ${r.error}. Try again or request a new one.` };
      else if (r && r.session) { afterSignIn(); if (r.type === "recovery") newPasswordModal(); else toast("Email confirmed – you're signed in", 3000); }
    }
    if (SY.session()) { try { localStorage.removeItem(LS_GUEST); } catch (e) { /* ignore */ } adoptAccount(SY.user()); renderAcct(); SY.syncNow({ pull: true }); }
    const pullSoon = () => { if (SY.session() && document.visibilityState !== "hidden" && Date.now() - SY.lastPull() > 5000) SY.syncNow({ pull: true }); };
    window.addEventListener("focus", pullSoon);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pullSoon(); });
    window.addEventListener("online", () => { if (SY.session()) SY.syncNow({ pull: true }); });
    window.addEventListener("offline", () => { if (SY.session()) { S.sync = { ...SY.info(), status: "offline" }; renderAcct(); } });
    setInterval(() => { if (SY.session() && document.visibilityState !== "hidden") SY.syncNow({ pull: true }); }, 60000);
  }

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
    if (authWall()) renderAuth();
    const syncReady = initSync().catch(() => {});
    try { S.report = JSON.parse(localStorage.getItem(LS_REPORT) || "null"); } catch (e) { S.report = null; }
    const cached = await idb.get("points");
    if (cached && cached.factions) setData(cached);
    S.wr = (await idb.get("winrates")) || null;
    S.ds = (await idb.get("datasheets")) || null;
    await syncReady;
    if (S.data) route();
    const r = await checkForUpdates(false);
    if (!S.data && authWall()) { renderAuth(); return; }
    if (!S.data) { $("#main").innerHTML = `<div class="empty">No points data available${r.offline ? " offline" : ""}. Connect once to download the Munitorum Field Manual data.</div>`; return; }
    route();
    if ("serviceWorker" in navigator && /^https?:/.test(location.protocol)) {
      const hadSW = !!navigator.serviceWorker.controller; let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadSW && !reloaded) { reloaded = true; location.reload(); } });
      navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
        reg.update().catch(() => {});
        document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
      }).catch(() => {});
    }
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
      (fetched ${esc(m.fetched_at ? localTime(m.fetched_at) : "?")}) · rules, stratagems &amp; profiles: GrimSlate${S.ds && S.ds.data_version ? ` (data ${esc(S.ds.data_version)})` : ""} · Adeptus Astartes: Codex: Space Marines (11th ed.)${S.wr ? " · win rates: listhammer.info" : ""} · faction artwork © Games Workshop, personal use.
      <button data-action="about">About</button>`;
  }
  function setActiveNav() {
    const h = location.hash || "#/lists";
    $$("#hdr [data-nav]").forEach((a) => a.classList.toggle("on", h.startsWith(a.getAttribute("data-nav"))));
  }

  /* ------------------------------------------------------------------ router */
  function route() {
    if (authWall()) { closeMenus(); renderAuth(); return; }
    document.body.classList.remove("auth-wall");
    if (!S.data) { if ($(".auth-page")) $("#main").innerHTML = `<div class="empty">Loading…</div>`; return; }
    const h = location.hash || "#/lists";
    const parts = h.replace(/^#\/?/, "").split("/");
    closeMenus();
    // the editor is a fixed-height app view (header/title row stay put, each column scrolls on its own)
    document.body.classList.toggle("app-fixed", parts[0] === "list" && !!parts[1]);
    if (parts[0] === "list" && parts[1]) renderEditor(decodeURIComponent(parts[1]));
    else if (parts[0] === "meta") renderMeta(parts[1] ? decodeURIComponent(parts[1]) : null);
    else if (parts[0] === "share" && parts[1]) openShared(parts.slice(1).join("/"));
    else renderLists();
    renderBanner(); renderFooter(); setActiveNav(); renderAcct();
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
      ${isGuest() ? `<div class="guest-note${S.lists.length >= GUEST_MAX ? " full" : ""}" data-testid="guest-note">${icon("user")}<span><b>Guest: ${S.lists.length}/${nLists(GUEST_MAX)}</b> · saved only on this device</span>
        <button class="btn sm" data-action="guest-signup">Create free account</button></div>` : ""}
      <input class="search" type="search" placeholder="Search lists…" value="${esc(S.ui.listQ)}" data-input="list-search">
      ${!S.lists.length ? `<div class="empty">No lists yet. Use <b>Create List</b> to start, or import a Muster JSON file.</div>` : ""}
      ${names.map((n) => {
        const ls = groups[n].sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
        return `<div class="lgroup"><h3>${factionImg(ls[0]) ? `<img class="fthumb" src="${esc(factionImg(ls[0]))}" alt="">` : ""}${esc(n)}</h3>
          ${ls.map((l) => {
            let c = null; try { c = C.calcList(l, S.idx); } catch (e) { c = null; }
            const size = c && c.size;
            return `<div class="lrow${l.disposition ? " has-disp" : ""}"${dispAttr(l)} data-action="open-list" data-id="${esc(l.id)}">
              ${factionImg(l) ? `<img class="lthumb" src="${esc(factionImg(l))}" alt="">` : icon(ROLE_ICON)}
              <span class="lmain"><span class="name">${esc(l.name)}</span>${l.disposition ? dispChip(l.disposition, "sm") : ""}</span>
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
    const fl = opts && opts.float;
    m.innerHTML = `<div class="modal-wrap${opts && opts.sheet ? " sheetwrap" : ""}${fl ? " floatwrap" : ""}"${fl ? "" : ` data-action="modal-bg"`}><div class="modal${opts && opts.wide ? " wide" : ""}${opts && opts.sheet ? " sheet" : ""}${fl ? " float" : ""}" role="dialog" aria-label="${esc(titleText)}">
      <div class="mtitle"><span>${esc(titleText)}</span><button class="ibtn" data-action="close-modal" title="Close">${icon("x")}</button></div>
      <div class="mbody">${body}</div></div></div>`;
    const f = $(".modal input[autofocus], .modal textarea[autofocus]", m); if (f) setTimeout(() => f.focus(), 0);
    if (fl) makeDraggable($(".modal", m));
    return $(".modal", m);
  }
  // desktop floating window (Colors): no dim, the page behind stays usable; drag it by the title bar, kept inside the viewport
  let FLOAT_POS = null;
  function clampFloat(el, x, y) {
    const r = el.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight;
    const hb = $("#hdr"), top = hb ? hb.getBoundingClientRect().bottom : 0;   // never over the header (Refresh, Colors stay reachable)
    x = Math.max(0, Math.min(x, W - r.width)); y = Math.max(top, Math.min(y, H - r.height));
    el.style.left = x + "px"; el.style.top = y + "px"; return { x, y };
  }
  function makeDraggable(el) {
    if (!el) return;
    const bar = $(".mtitle", el);
    el.style.position = "fixed";
    const r = el.getBoundingClientRect();
    FLOAT_POS = clampFloat(el, FLOAT_POS ? FLOAT_POS.x : (window.innerWidth - r.width) / 2, FLOAT_POS ? FLOAT_POS.y : Math.max(48, (window.innerHeight - r.height) / 2));
    let d = null;
    bar.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || ev.target.closest("button")) return;
      const b = el.getBoundingClientRect(); d = { dx: ev.clientX - b.left, dy: ev.clientY - b.top };
      try { bar.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      el.classList.add("dragging"); ev.preventDefault();
    });
    bar.addEventListener("pointermove", (ev) => { if (d) FLOAT_POS = clampFloat(el, ev.clientX - d.dx, ev.clientY - d.dy); });
    const end = () => { d = null; el.classList.remove("dragging"); };
    bar.addEventListener("pointerup", end); bar.addEventListener("pointercancel", end);
  }
  window.addEventListener("resize", () => { const el = $("#modal .modal.float"); if (el && FLOAT_POS) FLOAT_POS = clampFloat(el, FLOAT_POS.x, FLOAT_POS.y); });
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
    if (guestBlocked(1)) return;
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
  // Force Disposition chip in Games Workshop's color (Colors setting can override per device)
  const dispSlug = (d) => String(d || "").toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
  const dispChip = (d, cls) => `<span class="dispc${cls ? " " + cls : ""}" data-disp="${esc(dispSlug(d))}">${esc(dispName(d))}</span>`;
  // the list's chosen Force Disposition colors its container (CSS var --dc via [data-disp]); nothing when none is chosen
  const dispAttr = (l) => (l && l.disposition ? ` data-disp="${esc(dispSlug(l.disposition))}"` : "");
  // a detachment's offered dispositions; the list's chosen one is highlighted
  const fdChips = (fd, l) => (fd || []).map((x) => dispChip(x, l && l.disposition ? (l.disposition === x ? "chosen" : "other") : "")).join(" ");

  function renderEditor(id) {
    const l = findList(id);
    if (!l) { $("#main").innerHTML = `<div class="empty">List not found. <a href="#/lists">Back to My Lists</a></div>`; return; }
    CUR = l;
    const F = C.getFaction(S.idx, l);
    const c = C.calcList(l, S.idx);
    const sub = subOf(l);
    const panel = S.ui.panel;
    keepScroll(() => {
      $("#main").innerHTML = `<div class="editor${l.disposition ? " has-disp" : ""}"${dispAttr(l)} data-testid="editor">
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
      <div class="catsearch"><input type="search" placeholder="Search units, keywords, costs…" value="${esc(S.ui.q)}" data-input="cat-search" aria-label="Search units"></div>`;
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
      <div class="cfgrow detsrow${sel.type === "dets" ? " selrow" : ""}" data-action="open-panel" data-panel="dets" data-testid="cfg-dets"><span class="n">${dets.length ? "" : `<span class="need" title="Error: select a detachment">!</span> `}<b>Detachment:</b> ${dets.length ? dets.map((d) => `<span class="dn">${esc(d.n)}</span>` + (d.src === "gs" ? `<span class="tag gs">GrimSlate</span>` : "")).join(", ") : `<span class="err">None selected</span>`}</span>
        <span class="dpchip${dpOver ? " over" : ""}" data-testid="dp">${c.dp}${c.dpLimit != null ? " / " + c.dpLimit : ""} DP</span></div>
      ${dets.map((d) => `<details class="coll cfgdet" data-testid="cfg-det" data-det="${esc(d.n)}"><summary><b>${esc(d.n)}</b>${d.rule ? ` – ${esc(d.rule[0])}` : ""} <span class="muted">· ${d.st.length} stratagem${d.st.length === 1 ? "" : "s"} · ${d.enh.length} enhancement${d.enh.length === 1 ? "" : "s"}</span></summary>
        <div class="cb">${d.rule ? `<div class="rules"><b>${esc(d.rule[0])}:</b> ${esc(clean(d.rule[1]))}</div>` : ""}${d.st.length ? d.st.map(stratHtml).join("") : `<span class="muted">No stratagem data for this detachment.</span>`}</div></details>`).join("")}
      <div class="cfgrow disprow${sel.type === "disp" ? " selrow" : ""}" data-action="open-panel" data-panel="disp" data-testid="cfg-disp"><span class="n">${!l.disposition && (c.dispositions || []).length ? `<span class="need warn" title="Warning: select a Force Disposition">!</span> ` : ""}<b>Force Disposition:</b> ${l.disposition ? dispChip(l.disposition) : `<span class="muted">${(c.dispositions || []).length ? "Select…" : "—"}</span>`}</span></div>
      <label class="cfgrow"><span class="n"><b>Show Legends</b></span><input type="checkbox" ${l.showLegends ? "checked" : ""} data-change="legends"></label>
      <label class="cfgrow" title="Off: attached Leaders/Support units appear inside their bodyguard unit's card"><span class="n"><b>Attached characters in their own category</b></span><input type="checkbox" ${l.leadersOwnCat ? "checked" : ""} data-change="leaders-own" data-testid="leaders-own"></label>
      <div class="cfgnote">Enhancements ${c.enhCount}${c.enhLimit != null ? " / " + c.enhLimit : ""} · Units ${c.units} pts · Enhancements ${c.enhancements} pts</div>
    </div></div>`;
    const rowHtml = (r, nested) => {
      const errs = errsFor(r.uid); const bits = entrySummary(r);
      return `<div class="urow${nested ? " attached" : ""}${sel.type === "unit" && sel.uid === r.uid ? " sel" : ""}" data-action="select-entry" data-uid="${esc(r.uid)}"${nested ? ` data-testid="attached-row" data-to="${esc(r.attachedTo.uid)}"` : ""}>
            <div class="line">${nested ? `<span class="att" title="${esc(r.attachKind === "support" ? "Support unit attached" : "Leader attached")} to ${esc(r.attachedTo.name)} (below)">↓</span>` : ""}${icon(ROLE_ICON)}<span class="n">${esc(r.name)}${r.unit && r.unit.lg ? `<span class="tag">Legends</span>` : ""}${nested ? ` <span class="tag">${r.attachKind === "support" ? "Support" : "Leader"}</span>` : ""}</span>
              ${errs.some((x) => c.errors.includes(x)) ? `<span class="dot err" title="${esc(errs.map((x) => x.msg).join("\n"))}">!</span>` : ""}
              ${pts(r.total)}${!nested && r.attached && r.attached.length ? `<span class="combo" title="Attached unit: ${esc([...r.attached.map((x) => x.name), r.name].join(" + "))}" data-testid="combo-pts">Σ ${r.total + r.attached.reduce((a, x) => a + x.total, 0)} pts</span>` : ""}
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
        ${top.map((r) => (!own && r.attached && r.attached.length ? `<div class="ugroup" data-testid="attached-group">${r.attached.map((x) => rowHtml(x, true)).join("")}${rowHtml(r, false)}</div>` : rowHtml(r, false))).join("")}</div></div>`;
    }).join("");
    const missing = c.entries.filter((r) => r.missing);
    const miss = missing.length ? `<div class="card"><div class="sect-h">Not in current data</div>${missing.map((r) => `<div class="urow" data-uid="${esc(r.uid)}"><div class="line"><span class="n err">${esc(r.name)}</span>
      <button class="ibtn danger" data-action="del-entry" data-uid="${esc(r.uid)}" title="Remove">${icon("trash")}</button></div></div>`).join("")}</div>` : "";
    return `<div class="fbanner"${banner ? ` style="background-image:linear-gradient(90deg,rgba(0,0,0,.78),rgba(0,0,0,.25)),url('${esc(banner)}')"` : ""}>
        <div><div class="fbt">${esc(sub ? sub.name : F ? F.f.name : l.faction)}</div><div class="fbs">${esc(size ? size.name : "")} · ${c.entries.length} unit${c.entries.length === 1 ? "" : "s"}</div>${l.disposition ? `<div class="fbdisp" data-testid="banner-disp">${dispChip(l.disposition)}</div>` : ""}</div>
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
    const w = new Map(); for (const l of lines) for (const g of l.gear) for (const part of String(g.name).split(" + ")) w.set(C.norm(part), (w.get(C.norm(part)) || 0) + (g.count || 1));
    const picks = new Set(); for (const v of Object.values((lo && lo.p) || {})) for (const [k, n] of Object.entries(v)) if (n > 0) for (const part of String(k).split(" + ")) picks.add(C.norm(part));
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
        <tr><td class="nm">${esc(u.n)}</td><td>${esc(st.M || "-")}</td><td>${esc(st.T || "-")}</td><td>${esc(st.SV || st.Sv || "-")}</td><td>${esc(st.W || "-")}</td><td>${esc(st.LD || st.Ld || "-")}</td><td>${esc(st.OC || "-")}</td><td data-testid="ds-inv">${esc(ds.inv || "-")}</td></tr>${(ds.sx || []).map((x) => `<tr data-testid="ds-sx"><td class="nm">${esc(x[0])}</td><td>${esc(x[1].M || "-")}</td><td>${esc(x[1].T || "-")}</td><td>${esc(x[1].SV || "-")}</td><td>${esc(x[1].W || "-")}</td><td>${esc(x[1].LD || "-")}</td><td>${esc(x[1].OC || "-")}</td><td>${esc(x[2] || "-")}</td></tr>`).join("")}</table>${ds.src === "codex" ? `<div class="ds-src muted" data-testid="ds-codex">Source: Codex: Space Marines (11th edition)</div>` : ""}`;
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
      // abilities, split New Recruit-style into clearly separated sub-sections, one card per ability
      const isAura = (a) => /\baura\b/i.test(a[0] || "") || /^\W*aura\b/i.test(clean(a[1] || ""));
      const isDmg = (a) => /^damaged\b/i.test(a[0] || "");
      const card = (name, text, cls, extra) => `<div class="ab-card${cls ? " " + cls : ""}" data-testid="ab-card"><div class="ab-n">${name}${extra || ""}</div>${text ? `<div class="ab-t">${text}</div>` : ""}</div>`;
      const sub = (key, label, body) => (body ? `<div class="ab-sub ab-${key}" data-testid="ab-${key}"><div class="ab-h">${label}</div>${body}</div>` : "");
      const auraBadge = `<span class="aura-badge">Aura</span>`;
      const wa = ds.wa.filter((a) => matchItem(a[0]) || matchItem(a[1]));
      const waHtml = wa.map((a) => { const on = eq && (eq.picks.has(C.norm(a[0])) || eq.w.has(C.norm(a[0]))); const aura = isAura([a[1], a[2]]);
        return card(`${esc(a[1])}${C.norm(a[0]) !== C.norm(a[1]) ? ` <span class="muted">(${esc(a[0])})</span>` : ""}`, esc(clean(a[2])), `${eq ? (on ? "eq" : "uneq") : ""}${aura ? " aura" : ""}`, aura ? auraBadge : ""); }).join("");
      if (!filt) {
        const core = ds.cr.length ? `<div class="ab-card core"><div class="ab-chips">${ds.cr.map((n) => `<span class="ab-chip kwc"${kwTip(n)}>${esc(n)}</span>`).join("")}</div></div>` : "";
        const fac = ds.fa.map((n) => `<details class="ab-card fac"><summary class="ab-n">${esc(n)}</summary><div class="ab-t">${esc(clean(frText(n)) || "")}</div></details>`).join("");
        const plain = ds.ab.filter((a) => !isAura(a) && !isDmg(a)).map((a) => card(esc(a[0]), esc(clean(a[1])))).join("");
        const auras = ds.ab.filter((a) => isAura(a) && !isDmg(a)).map((a) => card(esc(String(a[0]).replace(/\s*\(aura\)\s*/i, " ").trim()), esc(clean(a[1])), "aura", auraBadge)).join("");
        const dmg = ds.ab.filter(isDmg).map((a) => card(esc(a[0]), esc(clean(a[1])), "dmg")).join("");
        const psy = (ds.ps || []).map((a) => card(esc(a[0]), esc(clean(a[1])), "psy")).join("");
        const by = F.f.units.filter((x) => (x.ldr || []).concat(x.sup || []).some((y) => C.norm(y) === C.norm(u.n))).map((x) => x.n);
        const lead = [
          u.ldr && u.ldr.length ? card("Leader", `This model can be attached to the following units:<ul class="ab-ul">${u.ldr.map((x) => `<li>${esc(title(x))}</li>`).join("")}</ul>`, "lead") : "",
          u.sup && u.sup.length ? card("Support", `This unit can be attached to:<ul class="ab-ul">${u.sup.map((x) => `<li>${esc(title(x))}</li>`).join("")}</ul>`, "lead") : "",
          by.length ? card("Can be joined by", esc(by.join(", ")), "lead") : "",
          r && r.attachedTo ? card("Attached", `${esc(r.attachKind === "support" ? "Support unit" : "Leader")} attached to <b>${esc(r.attachedTo.name)}</b>`, "lead") : "",
          ds.tr ? card("Transport", esc(clean(typeof ds.tr === "string" ? ds.tr : JSON.stringify(ds.tr))), "lead") : ""].join("");
        html += `<div class="ds-sec" data-testid="ds-abilities"><div class="ds-h">Abilities</div>
          ${sub("core", "Core", core)}${sub("faction", "Faction", fac)}${sub("datasheet", "Abilities", plain)}${sub("aura", "Auras", auras)}${sub("psychic", "Psychic Abilities", psy)}${sub("wargear", "Wargear Abilities", waHtml)}${sub("damaged", "Damaged", dmg)}${sub("leader", "Leader &amp; attachment", lead)}</div>`;
        if (ds.wo && ds.wo.length) html += `<div class="ds-sec" data-testid="ds-wargear-options"><div class="ds-h">Wargear Options</div><ul class="ds-ul">${ds.wo.map((x) => `<li>${esc(clean(x))}</li>`).join("")}</ul></div>`;
        if (ds.comp && ds.comp.length) html += `<div class="ds-sec" data-testid="ds-composition"><div class="ds-h">Unit Composition</div><ul class="ds-ul">${ds.comp.map((x) => `<li>${esc(clean(x))}</li>`).join("")}</ul></div>`;
      } else if (wa.length) html += `<div class="ds-sec" data-testid="ds-wargear-ab"><div class="ds-h">Wargear abilities</div>${waHtml}</div>`;
      if (filt && !html.includes("<table") && !wa.length) html += `<div class="muted">No separate profile for ${esc(String(o.item).replace(/\|/g, ", "))}.</div>`;
    }
    if (!filt) {
      const dk = ds || {};
      html += `<div class="ds-sec" data-testid="ds-keywords"><div class="ds-h">Keywords</div><div class="ds-ab">${esc((dk.kwm ? u.kw.filter((k) => !dk.kwm.some((m) => m[1].includes(k))) : u.kw || []).join(", ") || "—")}</div>
        ${(dk.kwm || []).map((m) => `<div class="ds-ab"><b>${esc(m[0])}:</b> ${esc(m[1].join(", "))}</div>`).join("")}
        <div class="ds-ab"><b>Faction keywords:</b> ${esc(dk.fkw ? dk.fkw.join(", ") : u.fk || F.f.name)}</div></div>`;
      if (!o.noPoints) html += `<div class="ds-sec"><div class="ds-h">Points (MFM)</div>${pointsTable(u)}</div>`;
    }
    return `<div class="ds" data-testid="datasheet">${html}</div>`;
  }
  /* combined card for an attached unit: bodyguard + its Leader/Support (New Recruit's combined unit card) */
  function combinedDatasheet(F, r) {
    // attached Leaders/Support units first, then the bodyguard they lead (character above the unit)
    const at = r.attached || [];
    if (!at.length) return datasheetHtml(F, r.unit, r);
    return at.map((x) => `<div class="ds-join ds-lead" data-testid="ds-joined"><div class="ds-jh">${esc(x.name)} <span class="tag">${x.attachKind === "support" ? "Support" : "Leader"}</span> ${pts(x.total)}</div>${datasheetHtml(F, x.unit, x, { noPoints: true })}</div>`).join("") +
      `<div class="ds-join ds-body" data-testid="ds-bodyguard"><div class="ds-jh">+ ${esc(r.name)} <span class="tag">Bodyguard</span> ${pts(r.total)}</div>${datasheetHtml(F, r.unit, r)}</div>`;
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
      // New Recruit-style dropdown: one collapsed row showing the current pick (or None) + its points; opening it
      // lists the options (same eligibility / taken / reason rules as before). Picking one closes it again.
      const upgradesOnly = !isChar || C.isEpicHero(u);
      const label = upgradesOnly && shown.every((ch) => ch.en[3]) ? "Upgrades" : "Enhancement";
      const usedTxt = c.enhLimit != null ? `<span class="muted enh-count" data-testid="enh-count">${c.enhCount} / ${c.enhLimit} used</span>` : "";
      const cur = e.enh ? shown.find((ch) => ch.d.n === e.enh.det && ch.en[0] === e.enh.name) || choices.find((ch) => ch.d.n === e.enh.det && ch.en[0] === e.enh.name) : null;
      const curBad = cur && !cur.ok && cur.reason ? cur.reason : e.enh && !cur ? `${e.enh.name} is not available in the selected detachments` : "";
      const curName = e.enh ? (cur ? cur.en[0] : e.enh.name) : "None";
      const open = S.ui.enhOpen === uid;
      const val = `<span class="enh-val${e.enh ? "" : " none"}" data-testid="enh-current"><span class="enh-vn">${esc(curName)}</span>${cur && dets.length > 1 ? ` <span class="muted">(${esc(cur.d.n)})</span>` : ""}${curBad ? ` <span class="need" title="${esc(curBad)}">!</span>` : ""}${cur ? pts(cur.en[1]) : ""}<span class="caret" aria-hidden="true"></span></span>`;
      enhHtml = `<details class="grp enh-dd" data-testid="enh-grp" data-uid="${esc(uid)}"${open ? " open" : ""}>
        <summary class="gh" data-testid="enh-sum" aria-label="${esc(label)}: ${esc(curName)}${cur ? ` (${cur.en[1]} pts)` : ""}. ${open ? "Close" : "Open"} to change"${cur && cur.en[2] ? ` title="${esc(clean(cur.en[2]))}"` : ""}><span class="enh-lbl">${label}</span>${usedTxt}${val}</summary>
        ${curBad ? `<div class="why err enh-curwhy">${esc(curBad)}</div>` : ""}
        <div class="gb enh-list" role="radiogroup" aria-label="${esc(label)}">
        <label class="opt enh-none"><input type="radio" name="enh" value="" ${!e.enh ? "checked" : ""} data-change="enh"><span class="on">None</span></label>
        ${shown.length ? shown.map(({ d, en, ok, reason, taken }) => {
          const checked = e.enh && e.enh.det === d.n && e.enh.name === en[0];
          const dis = !ok && !checked;
          return `<label class="opt${dis ? " disabled" : ""}${checked ? " sel" : ""}" data-testid="enh-opt" data-enh="${esc(en[0])}"${dis ? ` title="${esc(reason)}"` : ""}><input type="radio" name="enh" value="${esc(d.n + "||" + en[0])}" ${checked ? "checked" : ""} ${dis ? "disabled" : ""} data-change="enh">
            <span class="on">${esc(en[0])}${en[3] ? ` <span class="tag">Upgrade</span>` : ""}${taken ? ` <span class="tag">taken</span>` : ""}${dets.length > 1 ? ` <span class="muted">(${esc(d.n)})</span>` : ""}${dis && reason ? `<span class="why" data-testid="enh-why">${esc(reason)}</span>` : ""}${checked && !ok && reason ? `<span class="why err">${esc(reason)}</span>` : ""}${en[2] ? `<span class="desc">${esc(clean(en[2]))}</span>` : ""}</span>${pts(en[1])}</label>`;
        }).join("") : `<div class="muted">${dets.length ? "No enhancements available to this unit." : "Select a detachment to see its enhancements."}</div>`}</div></details>`;
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
        <details class="coll profiles" open data-testid="profiles"><summary>Profiles${r.attached && r.attached.length ? ` <span class="muted">(led by ${esc(r.attached.map((x) => x.name).join(", "))})</span>` : ""}</summary><div class="cb">${combinedDatasheet(F, r)}</div></details>
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
        ${d.fd && d.fd.length ? `<div class="muted fdline">Force Disposition: ${fdChips(d.fd, CUR)}</div>` : ""}
        ${d.sup ? `<div class="muted">${esc([].concat(d.sup).join("; "))}</div>` : ""}
        ${d.gs_dp !== undefined && d.gs_dp !== d.dp ? `<div class="warn">GrimSlate lists ${esc(d.gs_dp)} DP (MFM value used)</div>` : ""}
        ${d.rule ? `<details class="coll"${o.open ? " open" : ""}><summary>Detachment rule: ${esc(d.rule[0])}</summary><div class="cb rules" data-testid="det-rule">${esc(clean(d.rule[1]))}</div></details>` : `<div class="muted">No detachment rule text available.</div>`}
        ${o.noEnh ? "" : `<details class="coll enh-coll"${o.open ? " open" : ""}><summary>Enhancements (${d.enh.length})</summary><div class="cb">${d.enh.length ? d.enh.map((e) => `<div class="opt"><span class="on"><b class="enh-n">${esc(e[0])}</b>${e[3] ? ` <span class="tag">Upgrade</span>` : ""}${e[2] ? `<span class="desc">${esc(clean(e[2]))}</span>` : ""}</span>${pts(e[1])}</div>`).join("") : `<span class="muted">None listed.</span>`}</div></details>`}
        <details class="coll st-coll"${o.open ? " open" : ""}><summary>Stratagems (${d.st.length})</summary><div class="cb" data-testid="det-strats">${d.st.length ? d.st.map(stratHtml).join("") : `<span class="muted">No stratagem data for this detachment.</span>`}</div></details></div>`;
  }
  function detsPanel(l, F, c) {
    const all = F.f.dets.filter((d) => d.dp !== null && d.dp !== undefined);
    const mfm = all.filter((d) => d.src !== "gs"), gs = all.filter((d) => d.src === "gs");
    const selected = new Set(l.dets || []);
    const focus = F.dets[S.ui.focusDet] || F.dets[(l.dets || [])[0]] || mfm[0] || gs[0];
    const size = c.size;
    const over = c.dpLimit != null && c.dp > c.dpLimit && !(size.single3dp && l.dets.length === 1 && c.dp === 3);
    const row = (d) => `<div class="detrow${focus && focus.n === d.n ? " focus" : ""}"><label><input type="checkbox" ${selected.has(d.n) ? "checked" : ""} value="${esc(d.n)}" data-change="det">
        <span class="dn">${esc(d.n)}</span><span class="dpchip">${d.dp} Detachment Point${d.dp === 1 ? "" : "s"}</span>${d.src === "gs" ? `<span class="tag gs" title="Not in the current MFM – GrimSlate data">GrimSlate</span>` : ""}
        ${d.chg ? `<span class="tag">updated</span>` : ""}${(d.rs || []).map((x) => `<span class="tag">${esc(x)}</span>`).join("")}${d.fd && d.fd.length ? `<span class="fdchips" data-testid="det-fd">${fdChips(d.fd, l)}</span>` : ""}${metaChip(l, d.n)}</label>
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
      ds.map((d) => `<label class="opt"><input type="radio" name="disp" value="${esc(d)}" ${l.disposition === d ? "checked" : ""} data-change="disp"><span class="on">${dispChip(d)}</span></label>`).join("")
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
      $("[data-ok]", m).onclick = () => { if (guestBlocked(1)) return; S.lists.push(l); saveLists(); closeModal(); location.hash = `#/list/${l.id}`; };
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
      <div class="ys-box" data-testid="ys-box"><div class="ys-txt"><b>Tabletop Simulator (Yellowscribe)</b><span class="muted">Download a roster file, upload it at
        <a href="${YS_URL}" target="_blank" rel="noopener">yellowscribe.link</a>, then paste the code it gives you into the Yellowscribe mod in Tabletop Simulator.</span></div>
        <button class="btn" data-action="exp-ys" data-testid="exp-ys">${icon("import")} Export for Yellowscribe</button></div>
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

  /* Yellowscribe (Tabletop Simulator): BattleScribe-style .rosz built from Muster's own profiles + loadouts */
  const YS_URL = "https://yellowscribe.link/";
  function exportYellowscribe() {
    const l = CUR; if (!l) return;
    if (!S.ds) { toast("Unit profiles aren't downloaded yet – go online once, then try again", 4000); return; }
    const r = C.exportYellowscribeRosz(l, S.idx, S.ds, S.meta);
    download(r.filename, r.bytes, "application/octet-stream");
    const m = modal("Export for Yellowscribe", `<div class="ys-help" data-testid="ys-help">
      <p>Downloaded <b>${esc(r.filename)}</b>. To get the army into Tabletop Simulator:</p>
      <ol><li>Open <a href="${YS_URL}" target="_blank" rel="noopener">yellowscribe.link</a> and choose <b>Upload</b>, then pick <b>${esc(r.filename)}</b> (on a phone it's in your Downloads / Files).</li>
        <li>Check the units, then press <b>Submit</b> at the bottom and copy the code.</li>
        <li>In Tabletop Simulator, load the <b>Yellowscribe v2</b> mod from the Steam Workshop, paste the code, pick a model for each model type and press <b>Create Army</b>.</li></ol>
      <p class="muted">Yellowscribe keeps the upload for about 10 minutes. Stats, weapons and abilities come from Muster's datasheets.</p>
      ${r.issues.length ? `<details class="ys-issues"><summary>${r.issues.length} item${r.issues.length === 1 ? "" : "s"} exported without full profiles</summary><ul>${r.issues.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}
      </div><div class="mfoot wrap"><a class="btn" href="${YS_URL}" target="_blank" rel="noopener">Open yellowscribe.link</a>
        <button class="btn secondary" data-action="exp-ys">Download again</button><button class="btn secondary" data-action="close-modal">Close</button></div>`);
    return m;
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
      { label: "Duplicate", icon: "copy", fn: () => { if (guestBlocked(1)) return; const d = C.duplicateList(l); S.lists.push(d); saveLists(); location.hash = `#/list/${d.id}`; toast("List duplicated"); } },
      { label: "Export…", icon: "export", fn: openExport },
      { label: "Export for Yellowscribe (TTS)", icon: "export", fn: exportYellowscribe },
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
      S.lists = S.lists.filter((x) => x.id !== id);
      if (SY && SY.configured && !isGuest()) S.tombs[id] = now();   // tombstone: other devices drop it on their next sync
      saveLists();
      if (CUR && CUR.id === id) { CUR = null; location.hash = "#/lists"; } else route();
      toast("List deleted");
    });
  }
  function importText(text) {
    text = String(text || "").trim();
    const m = text.match(/#\/share\/([A-Za-z0-9_\-]+)/);
    if (m) { location.hash = `#/share/${m[1]}`; closeModal(); return; }
    try {
      const all = C.importLists(text); const room = guestRoom();
      const ls = all.slice(0, room);
      if (ls.length) { S.lists.push(...ls); saveLists(); }
      closeModal(); route();
      if (ls.length < all.length) {
        guestLimitModal(ls.length ? `Imported ${ls.length} of ${all.length} lists – the other ${all.length - ls.length} weren't imported.` : `${all.length === 1 ? "The list wasn't" : `None of the ${all.length} lists were`} imported.`);
        return;
      }
      toast(`Imported ${ls.length} list${ls.length === 1 ? "" : "s"}`);
    } catch (e) { toast(`Import failed: ${e.message}`, 3500); }
  }
  function importFile() {
    if (guestBlocked(1)) return;
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".json,application/json,text/plain";
    inp.onchange = () => { const f = inp.files && inp.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => importText(r.result); r.readAsText(f); };
    inp.click();
  }

  /* ------------------------------------------------------------------ Meta Win Rates (mirrors listhammer.info layout) */
  const wrClass = (v) => v === null || v === undefined ? "" : v >= 55 ? "wr-hi" : v >= 52 ? "wr-up" : v <= 45 ? "wr-lo" : v <= 48 ? "wr-dn" : "wr-mid";
  const wrCell = (v, games, min) => (min && (games || 0) < min && !S.ui.showSmall) ? `<span class="muted" title="${esc(C.fmtPct(v))} over ${games} games (fewer than ${min})">—</span>` : `<span class="wr ${wrClass(v)}">${esc(C.fmtPct(v))}</span>`;
  const signed = (v) => v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${Math.round(v)}`;
  const facThumb = (id) => { const F = S.idx && S.idx.factions[id]; return F && F.f.img ? `<img class="lthumb" src="${esc(F.f.img)}" alt="">` : ""; };
  const fmtN = (n) => n === null || n === undefined ? "—" : Number(n).toLocaleString("en-US");
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
  function sortHead(cols, sortState, kind) {
    return `<tr>${cols.map(([k, label, cls]) => `<th class="${cls || ""}${sortState.key === k ? " sorted " + sortState.dir : ""}" data-action="sort" data-kind="${kind}" data-key="${esc(k)}">${esc(label)}${sortState.key === k ? (sortState.dir === "asc" ? " ▲" : " ▼") : ""}</th>`).join("")}</tr>`;
  }
  function metaHeader(t, sub) {
    const W = S.wr;
    return `<div class="meta-h"><div><h2>${t}</h2>${sub || ""}</div><div class="meta-src">Source: <a href="${esc((W && W.source_url) || "https://listhammer.info/stats")}" target="_blank" rel="noopener">listhammer.info</a>${W ? ` · fetched ${esc(localTime(W.fetched_at))}` : ""}</div></div>`;
  }
  /* time-window segmented control + Include RTTs switch (same on the faction table and every faction page) */
  function metaControls(V) {
    const W = S.wr; const rs = C.metaRanges(W);
    return `<div class="meta-ctl" data-testid="meta-controls">
      ${rs.length > 1 ? `<div class="seg scroll">${rs.map((r) => `<button class="${V.range === r.key ? "on" : ""}" data-action="meta-range" data-range="${esc(r.key)}">${esc(r.label)}</button>`).join("")}</div>` : ""}
      ${C.metaHasRtt(W) ? `<label class="switch" title="Widen the criteria to RTTs: 3+ rounds and 8+ players"><input type="checkbox" data-change="meta-rtt" data-testid="rtt-toggle" ${S.ui.metaRtt ? "checked" : ""}><span class="sl"></span><span>Include RTTs</span></label>` : ""}
    </div>`;
  }
  const mtabs = (tabs, cur, scope) => `<div class="metatabs" role="tablist">${tabs.map(([k, l, n]) => `<button role="tab" class="${cur === k ? "on" : ""}" data-action="meta-tab" data-scope="${scope}" data-tab="${k}">${esc(l)}${n !== undefined && n !== null ? ` <span class="cnt">${esc(n)}</span>` : ""}</button>`).join("")}</div>`;
  function renderMeta(slug) {
    const W = S.wr;
    if (!W || !W.factions) { $("#main").innerHTML = `<div class="meta-page">${metaHeader("Meta Win Rates")}<div class="empty">No win-rate data available yet. It is downloaded with the points data when online.</div></div>`; return; }
    if (slug) return renderMetaFaction(slug);
    const V = C.metaView(W, S.ui.metaRange, S.ui.metaRtt);
    const tab = ["factions", "dispositions", "events"].includes(S.ui.metaHome) ? S.ui.metaHome : "factions";
    const q = (S.ui.metaQ || "").trim().toLowerCase();
    let body = "";
    if (tab === "factions") {
      const rows = C.sortRows(V.rows.filter((r) => !q || r.name.toLowerCase().includes(q)), S.ui.metaSort.key, S.ui.metaSort.dir);
      body = `<input class="search" type="search" placeholder="Search factions…" value="${esc(S.ui.metaQ || "")}" data-input="meta-q" aria-label="Search factions">
      <div class="tablewrap"><table class="mtable sticky1" data-testid="meta-table">${sortHead([["name", "Faction", "l"], ["win_rate", "Win Rate"], ["players", "Players"], ["games", "Games"], ["x0", "X-0"], ["x1", "X-1"], ["event_wins", "Event Wins"], ["overrep", "Overrep"]], S.ui.metaSort, "meta")}
        ${rows.map((r) => `<tr class="click" data-action="meta-faction" data-slug="${esc(r.slug)}"><td class="l"><div class="fcell">${facThumb(r.mfm_id)}<span>${esc(r.name)}</span></div></td>
          <td><div class="wrbar"><span style="width:${Math.max(0, Math.min(100, r.win_rate || 0))}%"></span></div>${wrCell(r.win_rate)}</td><td>${esc(fmtN(r.players))}</td><td>${esc(fmtN(r.games))}</td>
          <td>${esc(r.x0 ?? "—")}</td><td>${esc(r.x1 ?? "—")}</td><td>${esc(r.event_wins ?? "—")}</td><td>${r.overrep != null ? esc(Number(r.overrep).toFixed(2)) + "x" : "—"}</td></tr>`).join("") || `<tr><td colspan="8" class="muted l">No faction matches “${esc(S.ui.metaQ)}”.</td></tr>`}</table></div>
      <p class="muted small">${esc(V.criteria || "Stats are compiled from singles events that are 2000 points, 5 or more rounds and with 16 or more players.")} Mirror matches are excluded. Tap a faction for its detachments, matchups and lists.</p>`;
    } else if (tab === "dispositions") {
      const tot = V.dispositions.reduce((a, d) => a + (d.players || 0), 0);
      const open = S.ui.metaDispOpen;
      const vs = (name) => V.disposition_matchups.filter((m) => m.name === name && m.games > 0).sort((a, b) => (b.win_rate || 0) - (a.win_rate || 0));
      body = V.dispositions.length ? `<p class="muted small">Tap a disposition to see its win rate against each other disposition.</p>
      <div class="tablewrap"><table class="mtable" data-testid="disp-table"><tr><th class="l">Disposition</th><th>Win Rate</th><th>Games</th><th>Field</th></tr>
        ${V.dispositions.slice().sort((a, b) => (b.win_rate || 0) - (a.win_rate || 0)).map((d) => `<tr class="click${open === d.name ? " open" : ""}" data-action="meta-disp" data-name="${esc(d.name)}"><td class="l"><span class="caret">${open === d.name ? "▾" : "▸"}</span>${dispChip(d.name)}</td><td>${wrCell(d.win_rate)}</td><td>${esc(fmtN(d.games))}</td><td>${tot ? esc((Math.round((d.players || 0) / tot * 1000) / 10).toFixed(1)) + "%" : "—"}</td></tr>
          ${open === d.name ? `<tr class="sub"><td colspan="4"><table class="mtable inner" data-testid="disp-vs"><tr><th class="l">Vs</th><th>Win Rate</th><th>Avg Diff</th><th>Go 1st WR</th><th>Go 1st Diff</th><th>Games</th></tr>
            ${vs(d.name).map((m) => `<tr><td class="l">${esc(m.opponent)}</td><td>${wrCell(m.win_rate)}</td><td>${esc(signed(m.avg_diff))}</td><td>${wrCell(m.go_first && m.go_first.win_rate, m.go_first && m.go_first.games, 10)}</td><td>${(m.go_first && m.go_first.games || 0) < 10 && !S.ui.showSmall ? "—" : esc(signed(m.go_first && m.go_first.avg_diff))}</td><td>${esc(fmtN(m.games))}</td></tr>`).join("") || `<tr><td colspan="6" class="muted l">No games.</td></tr>`}</table></td></tr>` : ""}`).join("")}</table></div>
      <p class="muted small">Win rates are compiled over qualifying events ${esc(V.range === "weekend" ? "this weekend" : V.range === "4weeks" ? "in the trailing 4 weeks" : (V.label || "").charAt(0).toLowerCase() + (V.label || "").slice(1))}${V.rtt ? ", incl. RTTs" : ""}. Mirror matches are excluded. Avg Diff is the mean victory-point margin from the row's side. The Go 1st columns repeat both over just the games the row's disposition had the first turn in (10+ games needed).</p>`
        : `<div class="empty">No disposition data for this view.</div>`;
    } else {
      const ev = V.events.slice().sort((a, b) => (b.players || 0) - (a.players || 0));
      body = ev.length ? `<p class="small"><b>${esc(fmtN(V.event_count ?? ev.length))} events · ${esc(fmtN(V.event_players ?? ev.reduce((a, e) => a + (e.players || 0), 0)))} players</b> <span class="muted">counted in this view</span></p>
      <div class="tablewrap"><table class="mtable" data-testid="events-table"><tr><th class="l">Event</th><th class="l">Where</th><th>Players</th></tr>
        ${ev.map((e) => `<tr><td class="l wrap">${esc(e.name)}${e.in_progress ? ` <span class="tag live">in progress</span>` : ""}</td><td class="l">${esc([e.state, e.country].filter(Boolean).join(", "))}</td><td>${esc(fmtN(e.players))}</td></tr>`).join("")}</table></div>`
        : `<div class="empty">No event list for this view.</div>`;
    }
    $("#main").innerHTML = `<div class="meta-page" data-view="${esc(V.key)}">
      ${metaHeader(`${esc(V.label)} Meta Breakdown`, `<div class="muted">${esc(V.dates || "")}${V.rtt ? ` · <span class="tag rtt">incl. RTTs</span>` : ""}</div>`)}
      ${metaControls(V)}
      ${mtabs([["factions", "Factions", V.rows.length], ["dispositions", "Dispositions"], ["events", "Events", V.event_count || null]], tab, "home")}
      ${body}
    </div>`;
  }
  function sparkline(weekly, marks) {
    if (!weekly || weekly.length < 2) return "";
    const W = 600, H = 120, pad = 18, n = weekly.length;
    const x = (i) => pad + (i * (W - 2 * pad)) / (n - 1), y = (v) => H - pad - ((Math.max(30, Math.min(70, v)) - 30) / 40) * (H - 2 * pad);
    const t0 = Date.parse(weekly[0].week), t1 = Date.parse(weekly[n - 1].week);
    const mx = (d) => pad + ((Date.parse(d) - t0) / Math.max(1, t1 - t0)) * (W - 2 * pad);
    const ms = (marks || []).filter((m) => { const t = Date.parse(m.date); return t > t0 && t <= t1 + 6 * 864e5; });
    const pts = weekly.map((w, i) => `${x(i).toFixed(1)},${y(w.win_rate || 50).toFixed(1)}`).join(" ");
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Win rate trend">
      ${[70, 50, 30].map((g) => `<line x1="${pad}" x2="${W - pad}" y1="${y(g)}" y2="${y(g)}" class="g${g === 50 ? " mid" : ""}"/><text x="2" y="${y(g) + 4}">${g}%</text>`).join("")}
      ${ms.map((m) => `<line class="mark ${esc(m.kind)}" x1="${Math.min(W - pad, mx(m.date)).toFixed(1)}" x2="${Math.min(W - pad, mx(m.date)).toFixed(1)}" y1="${pad - 6}" y2="${H - pad}"><title>${esc(m.label || (m.kind === "codex" ? "Codex" : "Dataslate"))} ${esc(m.date)}</title></line>`).join("")}
      <polyline points="${pts}"/>${weekly.map((w, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(w.win_rate || 50).toFixed(1)}" r="3"><title>Week of ${esc(w.week)}: ${esc(C.fmtPct(w.win_rate))} (${w.wins != null ? esc(w.wins) + "-" + esc(w.losses) + ", " : ""}${esc(w.games)} games)</title></circle>`).join("")}</svg>
      <div class="sparkx muted small"><span>${esc(weekly[0].week)}</span>${ms.length ? `<span><span class="mk dataslate"></span> dataslate${ms.some((m) => m.kind === "codex") ? ` <span class="mk codex"></span> codex` : ""}</span>` : ""}<span>${esc(weekly[n - 1].week)}</span></div>`;
  }
  async function loadMetaLists(slug) {
    S.metaLists = S.metaLists || {};
    if (S.metaLists[slug]) return S.metaLists[slug];
    const W = S.wr;
    try {
      const d = await fetchJSON(`data/meta-lists/${encodeURIComponent(slug)}.json?v=${encodeURIComponent((W && (W.lists_hash || W.fetched_at)) || "")}`);
      S.metaLists[slug] = d;
    } catch (e) { S.metaLists[slug] = { error: true }; }
    return S.metaLists[slug];
  }
  function renderMetaFaction(slug) {
    const W = S.wr; const f0 = W.factions.find((x) => x.slug === slug);
    if (!f0) { $("#main").innerHTML = `<div class="meta-page"><a class="backlink" href="#/meta">${icon("back")} All factions</a><div class="empty">Faction not found.</div></div>`; return; }
    const V = C.metaView(W, S.ui.metaRange, S.ui.metaRtt);
    const f = C.metaDetail(f0, V.rtt);
    const F = f.mfm_id && S.idx.factions[f.mfm_id];
    const row = V.rows.find((r) => r.name === f.name) || {};
    const wk = V.range === "weekend";
    const hd = wk ? f : row;           // headline tiles follow the chosen window (faction table numbers)
    const tile = (v, l) => `<div class="tile"><div class="tv">${v}</div><div class="tl">${esc(l)}</div></div>`;
    const TABS = [["overview", "Overview"], ["detachments", "Detachments", (f.detachments || []).filter((d) => d.name !== "Unknown").length], ["matchups", "Matchups", (f.matchups || []).length], ["dispositions", "Dispositions"], ["lists", "Lists"]];
    const tab = TABS.some((t) => t[0] === S.ui.metaTab) ? S.ui.metaTab : "overview";
    const weekendNote = !wk && tab !== "overview" ? `<div class="mnote" data-testid="weekend-only">Showing <b>This Weekend</b>${V.rtt ? " (incl. RTTs)" : ""}: listhammer only serves ${esc(V.label)} detachments, matchups and lists through its API, which its robots.txt asks tools not to use.</div>` : "";
    const when = V.rtt ? "this weekend, incl. RTTs" : "this weekend";
    let body = "";
    if (tab === "overview") {
      const l4 = W.datasets ? (C.metaView(W, "4weeks", V.rtt).rows.find((r) => r.name === f.name)) : f.last_4_weeks;
      const ds = W.datasets && W.datasets.dataslate ? C.metaView(W, "dataslate", V.rtt) : null; const dsr = ds && ds.range === "dataslate" ? ds.rows.find((r) => r.name === f.name) : null;
      const marks = (W.rules_updates || []).filter((m) => m.kind === "dataslate" || (m.kind === "codex" && (m.factions || []).includes(f.slug)));
      body = `<div class="tiles" data-testid="meta-tiles">${tile(`<span class="${wrClass(hd.win_rate)}">${esc(C.fmtPct(hd.win_rate))}</span>`, "Win Rate")}${tile(esc(fmtN(hd.games)), "Games")}${tile(esc(fmtN(hd.players)), "Players")}
        ${tile(esc(hd.x0 ?? "—"), "X-0s")}${tile(esc(hd.x1 ?? "—"), "X-1s")}${tile(esc(hd.event_wins ?? "—"), "Event Wins")}${tile(hd.overrep != null ? esc(Number(hd.overrep).toFixed(2)) + "x" : "—", "Overrep")}</div>
        <p class="muted small">${wk ? esc(f.criteria || `Compiled from ${f.event_count ?? "?"} qualifying events.`) + " The tallies cover qualifying events " + esc(when) + "; only the trend spans the trailing ~6 months." : `${esc(V.label)} (${esc(V.dates || "")}) from listhammer's faction table. ${esc(V.criteria || "")}`} Mirror matches excluded.</p>
        <div class="mcards">
          ${l4 ? `<div class="mcard"><div class="k">Last 4 weeks</div><div class="v ${wrClass(l4.win_rate)}">${esc(C.fmtPct(l4.win_rate))}</div><div class="muted small">${esc(fmtN(l4.games))} games · ${esc(fmtN(l4.players))} players</div></div>` : ""}
          ${dsr ? `<div class="mcard"><div class="k">${esc(ds.label)}</div><div class="v ${wrClass(dsr.win_rate)}">${esc(C.fmtPct(dsr.win_rate))}</div><div class="muted small">${esc(fmtN(dsr.games))} games · ${esc(fmtN(dsr.players))} players</div></div>` : ""}
          ${f.overall_6mo ? `<div class="mcard"><div class="k">Trailing ~6 months</div><div class="v ${wrClass(f.overall_6mo.win_rate)}">${esc(C.fmtPct(f.overall_6mo.win_rate))}</div><div class="muted small">${esc(fmtN(f.overall_6mo.games))} games</div></div>` : ""}
        </div>
        ${f.weekly && f.weekly.length > 1 ? `<h3>Win Rate Trend</h3><div class="card pad">${sparkline(f.weekly, marks)}</div><p class="muted small">Week-by-week win rate over qualifying events${V.rtt ? " incl. RTTs" : ""}. Hover or long-press a point for its record.</p>` : ""}`;
    } else if (tab === "detachments") {
      // like listhammer, players without an identified detachment count towards Field % but aren't listed
      const dets = (S.ui.detMode === "single" ? (f.detachments_single || []).map((d) => ({ ...d, field_pct: null })) : (f.detachments || [])).filter((d) => d.name !== "Unknown");
      const dsorted = C.sortRows(dets, S.ui.detSort.key, S.ui.detSort.dir);
      const detLabel = (d) => d.name === "Unknown" ? `<span class="muted">Unknown</span>` : (d.parts || [d.name]).map((p, i) => {
        const m = (d.mfm ? [].concat(d.mfm) : [])[i] || (d.mfm && !Array.isArray(d.mfm) ? d.mfm : null);
        return `<div class="dpart">${esc(p)}${m && m.src === "gs" ? `<span class="tag gs" title="Not in current MFM">GS</span>` : ""}</div>`;
      }).join("");
      const nd = f.no_detachment_players;
      body = `${V.rtt ? `<div class="mnote warn"><b>RTT detachment stats can be heavily skewed.</b> listhammer doesn't fetch detachment data for every RTT list, so Field % and win rates lean towards the lists it collects.</div>` : ""}
      <div class="seg"><button class="${S.ui.detMode !== "single" ? "on" : ""}" data-action="det-mode" data-mode="combos">Combinations</button><button class="${S.ui.detMode === "single" ? "on" : ""}" data-action="det-mode" data-mode="single">Per detachment</button></div>
      <p class="muted small">Unique detachment combinations ${esc(when)}. Field % is the share of ${esc(f.name)} players. WR excludes mirrors and draws.${nd ? ` ${esc(nd)} of ${esc(f.players)} players (${esc((Math.round(nd / Math.max(1, f.players) * 1000) / 10).toFixed(1))}%) have no identified detachment; they count towards Field % but aren't listed.` : ""}</p>
      <div class="tablewrap"><table class="mtable" data-testid="det-table">${sortHead([["name", "Detachment", "l"], ["players", "Players"], ...(S.ui.detMode === "single" ? [] : [["field_pct", "Field %"]]), ["wins", "W-L"], ["games", "Games"], ["win_rate", "Win Rate"]], S.ui.detSort, "det")}
        ${dsorted.map((d) => `<tr><td class="l wrap">${detLabel(d)}</td><td>${esc(d.players ?? "—")}</td>${S.ui.detMode === "single" ? "" : `<td>${d.field_pct != null ? esc(d.field_pct) + "%" : "—"}</td>`}<td>${esc(d.wins ?? 0)}-${esc(d.losses ?? 0)}</td><td>${esc(d.games ?? 0)}</td><td>${wrCell(d.win_rate, d.games, S.ui.detMode === "single" ? 0 : 10)}</td></tr>`).join("") || `<tr><td colspan="6" class="muted l">No detachment data.</td></tr>`}</table></div>
      ${S.ui.detMode === "single" ? `<p class="muted small">Per-detachment figures sum every combination that includes the detachment (derived by Muster).</p>` : `<p class="muted small">Win rates with fewer than 10 games show a dash, like listhammer.</p>`}`;
    } else if (tab === "matchups") {
      const small = (g) => !S.ui.showSmall && (g || 0) < 10;
      const muKey = { win_rate: (m) => small(m.games) ? null : m.win_rate, avg_diff: (m) => small(m.games) ? null : m.avg_diff,
        gf3: (m) => small(m.go_first && m.go_first.games) ? null : m.go_first && m.go_first.win_rate,
        gf4: (m) => small(m.go_first && m.go_first.games) ? null : m.go_first && m.go_first.avg_diff }[S.ui.muSort.key] || S.ui.muSort.key;
      const mus = C.sortRows(f.matchups || [], muKey, S.ui.muSort.dir);
      body = `<p class="muted small">${esc(f.name)}'s win rate into each other faction, ${esc(when)}. Avg Diff is the mean victory-point margin. Fewer than 10 games show a dash, like listhammer.
        <label class="inline"><input type="checkbox" ${S.ui.showSmall ? "checked" : ""} data-change="show-small"> show anyway</label></p>
      <div class="tablewrap"><table class="mtable sticky1" data-testid="matchup-table">${sortHead([["opponent", "Faction", "l"], ["win_rate", "Win Rate"], ["avg_diff", "Avg Diff"], ["gf3", "Go 1st WR"], ["gf4", "Go 1st Diff"], ["games", "Games"]], S.ui.muSort, "mu")}
        ${mus.map((m) => `<tr class="click" data-action="meta-faction" data-slug="${esc(m.opponent_slug)}"><td class="l"><div class="fcell">${facThumb(m.opponent_mfm_id)}<span>${esc(m.opponent)}</span></div></td><td>${wrCell(m.win_rate, m.games, 10)}</td>
          <td>${small(m.games) ? "—" : esc(signed(m.avg_diff))}</td><td>${wrCell(m.go_first && m.go_first.win_rate, m.go_first && m.go_first.games, 10)}</td>
          <td>${small(m.go_first && m.go_first.games) ? "—" : esc(signed(m.go_first && m.go_first.avg_diff))}</td><td>${esc(m.games)}</td></tr>`).join("") || `<tr><td colspan="6" class="muted l">No matchup data.</td></tr>`}</table></div>`;
    } else if (tab === "dispositions") {
      const ent = Object.entries(f.dispositions || {}).sort((a, b) => b[1] - a[1]); const tot = ent.reduce((a, e) => a + e[1], 0);
      body = ent.length ? `<p class="muted small">How ${esc(f.name)} players build across dispositions, ${esc(when)}.</p>
      <div class="dbars" data-testid="fac-disp">${ent.map(([k, v]) => `<div class="dbar"><div class="dl"><span>${dispChip(k)}</span><span><b>${esc(v)}</b> · ${esc((Math.round(v / Math.max(1, tot) * 1000) / 10).toFixed(1))}%</span></div><div class="db"><span style="width:${(v / Math.max(1, tot) * 100).toFixed(1)}%"></span></div></div>`).join("")}</div>` : `<div class="empty">No disposition data.</div>`;
    } else {
      const L = S.metaLists && S.metaLists[slug];
      if (!L) { body = `<div class="empty">Loading lists…</div>`; loadMetaLists(slug).then(() => { if (location.hash.startsWith(`#/meta/${slug}`) && S.ui.metaTab === "lists") route(); }); }
      else if (L.error || !(L.std || L.rtt)) body = `<div class="empty">Recent lists aren't available offline or for this faction yet.</div>`;
      else {
        const src = (V.rtt ? L.rtt : L.std) || L.std || { lists: [] };
        const dets = [...new Set(src.lists.map((x) => x.detachment).filter(Boolean))].sort();
        const fd = dets.includes(S.ui.metaListDet) ? S.ui.metaListDet : "";
        const shown = src.lists.filter((x) => !fd || x.detachment === fd);
        body = `<p class="muted small">Recent undefeated / X-1 lists from ${V.rtt ? "8+ player events incl. RTTs" : "16+ player non-team events"} — newest ${esc(src.lists.length)} of ${esc(fmtN(src.total ?? src.lists.length))}. <a href="${esc(f.url)}" target="_blank" rel="noopener">More on listhammer ↗</a></p>
        ${dets.length > 1 ? `<label class="msel">Detachment <select data-change="meta-list-det"><option value="">All detachments</option>${dets.map((d) => `<option ${d === fd ? "selected" : ""}>${esc(d)}</option>`).join("")}</select></label>` : ""}
        <div class="mlists" data-testid="meta-lists">${shown.map((x) => { const i = src.lists.indexOf(x); return `<details class="mlist"><summary>
          <div class="mlh"><b>${esc(x.player || "Unknown player")}</b><span class="res">${esc(x.w ?? 0)}-${esc(x.l ?? 0)}${x.d ? "-" + esc(x.d) : ""}</span></div>
          <div class="mls">${esc([x.detachment, x.disposition].filter(Boolean).join(" · "))}</div>
          <div class="mls muted">${esc(x.event || "")}${x.event_players ? ` (${esc(x.event_players)} players)` : ""}${x.date ? " · " + esc(new Date(x.date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" })) : ""}${x.rtt ? ` <span class="tag rtt">RTT</span>` : ""}</div></summary>
          ${x.text ? `<div class="mlbtns"><button class="btn secondary sm" data-action="meta-copy-list" data-slug="${esc(slug)}" data-i="${i}">${icon("copy")} Copy list</button></div><pre class="mltext">${esc(x.text)}</pre>` : `<p class="muted small">No list text.</p>`}</details>`; }).join("") || `<div class="empty">No lists.</div>`}</div>`;
      }
    }
    $("#main").innerHTML = `<div class="meta-page" data-view="${esc(V.key)}">
      <a class="backlink" href="#/meta">${icon("back")} All factions</a>
      <div class="fbanner big"${F && F.f.banner ? ` style="background-image:linear-gradient(90deg,rgba(0,0,0,.8),rgba(0,0,0,.2)),url('${esc(F.f.banner)}')"` : ""}><div><div class="fbt">${esc(f.name)}</div><div class="fbs">${esc(V.label)} · ${esc(V.dates || "")}${V.rtt ? " · incl. RTTs" : ""}</div></div>
        <a class="wrchip light" href="${esc(f.url)}" target="_blank" rel="noopener">listhammer ↗</a></div>
      ${metaControls(V)}
      ${mtabs(TABS, tab, "faction")}
      ${weekendNote}
      ${body}
    </div>`;
  }
  const MU_KEYS = { gf3: (m) => m.go_first && m.go_first.win_rate, gf4: (m) => m.go_first && m.go_first.avg_diff };

  /* ------------------------------------------------------------------ about */
  function about() {
    const m = S.meta || {}; const W = S.wr;
    modal("About Muster", `<p><b>Muster</b> is an unofficial, offline-capable Warhammer 40,000 army list builder for personal use. It is not affiliated with, endorsed by or connected to Games Workshop. Warhammer 40,000 and all faction names and artwork are trademarks/© of Games Workshop.</p>
      <table class="ptable"><tr><td>Points</td><td>Munitorum Field Manual ${esc(m.mfm_version || "?")}, fetched ${esc(m.fetched_at ? localTime(m.fetched_at) : "?")}</td></tr>
      <tr><td>Rules text &amp; stratagems</td><td>GrimSlate (secondary), ${esc(m.gs_fetched_at ? localTime(m.gs_fetched_at) : "?")}</td></tr>
      <tr><td>Space Marines datasheets, detachments &amp; stratagems</td><td>Codex: Space Marines (11th edition) – overrides GrimSlate for Adeptus Astartes; points stay MFM</td></tr>
      <tr><td>Win rates</td><td>${W ? `listhammer.info, ${esc((W.date_range || {}).label || "")} ${esc((W.date_range || {}).dates || "")}, fetched ${esc(localTime(W.fetched_at))}` : "not loaded"}</td></tr>
      <tr><td>Data hash</td><td>${esc(m.hash || "?")}</td></tr><tr><td>Saved lists</td><td>${S.lists.length} ${SY && SY.session() ? `(synced to your account)` : isGuest() ? `of ${GUEST_MAX} (guest mode – stored only on this device)` : "(stored only on this device)"}</td></tr>
      ${SY && SY.session() ? `<tr><td>Account</td><td>${esc(SY.user().email || "")} · ${esc(SYNC_TXT[(S.sync || SY.info()).status] || "")} <a href="#" data-action="account">Manage / sign out</a></td></tr>` : ""}</table>
      <div class="mfoot wrap">${S.report ? `<button class="btn secondary" data-action="show-report">Show last points-update report</button>` : ""}<button class="btn secondary" data-action="colors">Colors</button><button class="btn secondary" data-action="check-update">Check for points updates</button><button class="btn" data-action="close-modal">Close</button></div>`);
  }
  /* ------------------------------------------------------------------ Colors setting (per device) */
  const MC = window.MusterColors;
  const SW_TEXT = ["#39ff14", "#ffd60a", "#ff9f1c", "#ff4d6d", "#ff5cf0", "#b388ff", "#4d8dff", "#00e5ff"];
  const SW_DISP = ["#1e8a2e", "#0b5fa5", "#b3261e", "#c9a100", "#0b8a80", "#6a3fb5", "#c25e00", "#3c4043"];
  const SAMPLE = { det: "Gladius Task Force", strat: "Armour of Contempt", cat: "Intercessor Squad", abil: "Deep Strike", aura: "Aura", enh: "Artificer Armour" };
  const isDark = () => document.documentElement.getAttribute("data-theme") === "dark";
  // what the picker shows when a category is still on its default
  const colorDefault = (c) => c.def || (c.k === "aura" ? "#8a5cd1" : isDark() ? "#e8e8e8" : "#000000");
  function colorPreview(c) {
    const v = `--c-${c.k}`;
    if (c.disp) return `<span class="cprev disp"><span class="pl"><span class="dispc" data-disp="${esc(c.k.slice(5))}">${esc(c.label)}</span></span><span class="pd"><span class="dispc" data-disp="${esc(c.k.slice(5))}">${esc(c.label)}</span></span></span>`;
    if (c.k === "aura") return `<span class="cprev"><span class="pl"><span class="aura-badge" style="background:var(${v}, #8a5cd1);color:var(${v}-fg, #fff)">Aura</span></span><span class="pd"><span class="aura-badge" style="background:var(${v}, #7a4fc4);color:var(${v}-fg, #fff)">Aura</span></span></span>`;
    return `<span class="cprev"><span class="pl" style="color:var(${v}, ${c.def || "#000"})">${esc(SAMPLE[c.k] || c.label)}</span><span class="pd" style="color:var(${v}, ${c.def || "#e8e8e8"})">${esc(SAMPLE[c.k] || c.label)}</span></span>`;
  }
  // brightness slider for one color: shades the picked (or built-in default) color, hue stays the same
  const bLabel = (b) => (b > 0 ? "+" + b : String(b));
  function brightRow(c) {
    const base = MC.base(c.k), b = MC.getB(c.k), off = !base;
    return `<div class="cs-bright${off ? " off" : ""}" data-testid="color-bright">
      <span class="cs-res" style="background:var(--c-${c.k}, ${base || "transparent"})" title="Result" aria-hidden="true"></span>
      <span class="cs-bl">Darker</span>
      <input type="range" min="-50" max="50" step="1" value="${b}" data-input="color-b" data-k="${esc(c.k)}" aria-label="${esc(c.label)} brightness" ${off ? "disabled" : ""}>
      <span class="cs-bl">Brighter</span><output class="cs-bv">${off ? "" : bLabel(b)}</output>
      ${off ? `<span class="cs-bhint muted">Pick a color to adjust its brightness</span>` : ""}</div>`;
  }
  function colorRow(c) {
    const cur = MC.get(c.k), val = cur || colorDefault(c), custom = cur || MC.getB(c.k);
    return `<div class="cset${custom ? " custom" : ""}" data-ck="${esc(c.k)}" data-testid="color-row">
      <div class="cs-top"><div class="cs-t"><b>${esc(c.label)}</b>${c.desc ? `<small>${esc(c.desc)}</small>` : ""}</div>
        <button class="btn secondary sm cs-reset" data-action="color-reset" data-k="${esc(c.k)}" title="Back to the default color">Reset</button></div>
      <div class="cs-ctl">${colorPreview(c)}</div>
      <div class="cs-ctl"><span class="cs-sw">${(c.disp ? SW_DISP : SW_TEXT).map((x) => `<button class="sw${cur === x ? " on" : ""}" data-action="color-pick" data-k="${esc(c.k)}" data-v="${x}" style="background:${x}" title="${x}" aria-label="${esc(c.label)}: ${x}"></button>`).join("")}
        <label class="cs-pick" title="Custom color: pick any color"><input type="color" value="${esc(val)}" data-input="color" data-k="${esc(c.k)}" aria-label="${esc(c.label)}: custom color"></label></span></div>
      ${brightRow(c)}</div>`;
  }
  function openColors() {
    const txt = MC.CATS.filter((c) => !c.disp), disp = MC.CATS.filter((c) => c.disp);
    modal("Colors", `<div class="colors" data-testid="colors">
      <p class="muted cs-intro">Pick a color for each part of the list builder. Changes show right away and are saved on this device. Each preview shows light mode on the left and dark mode on the right.</p>
      ${txt.map(colorRow).join("")}
      <div class="cs-h">Force Dispositions</div>
      <p class="muted cs-intro">Defaults are the colors Games Workshop uses on the 11th edition Force Disposition icons.</p>
      ${disp.map(colorRow).join("")}
      <div class="mfoot"><button class="btn secondary" data-action="color-reset-all" data-testid="color-reset-all">Reset all</button><button class="btn" data-action="close-modal">Done</button></div></div>`, isPhone() ? { sheet: true } : { float: true });
  }
  function refreshColorRow(k) {
    const row = $(`.cset[data-ck="${k}"]`); const c = MC.cat(k); if (!row || !c) return;
    const cur = MC.get(k); row.classList.toggle("custom", !!(cur || MC.getB(k)));
    const br = $(".cs-bright", row); if (br) br.outerHTML = brightRow(c);
    $$(".sw", row).forEach((b) => b.classList.toggle("on", b.dataset.v === cur));
    const inp = $("input[type=color]", row); if (inp && document.activeElement !== inp) inp.value = cur || colorDefault(c);
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
    "new-list": () => { if (!guestBlocked(1)) openCreate(); },
    "close-modal": () => closeModal(),
    "modal-bg": (t, ev) => { if (ev.target === t) closeModal(); },
    "pick-group": (t) => { NEW.group = S.data.groups[+t.dataset.i].name; renderCreate(); },
    "pick-sub": (t) => { NEW.sub = t.dataset.id; renderCreate(); },
    "pick-back": () => { if (NEW.sub) NEW.sub = null; else NEW.group = null; renderCreate(); },
    "create-list": () => createList(),
    "open-list": (t) => { location.hash = `#/list/${t.dataset.id}`; },
    "rename-list": (t) => renameList(t.dataset.id),
    "rename-cur": () => CUR && renameList(CUR.id),
    "dup-list": (t) => { const l = findList(t.dataset.id); if (!l || guestBlocked(1)) return; S.lists.push(C.duplicateList(l)); saveLists(); route(); toast("List duplicated"); },
    "del-list": (t) => deleteList(t.dataset.id),
    "import-file": () => importFile(),
    "import-text": () => {
      if (guestBlocked(1)) return;
      const m = modal("Text Import", `<p class="muted">Paste a Muster JSON export or a Muster share link.</p><textarea autofocus data-import></textarea>
        <div class="mfoot"><button class="btn secondary" data-action="close-modal">Cancel</button><button class="btn" data-ok>Import</button></div>`);
      $("[data-ok]", m).onclick = () => importText($("[data-import]", m).value);
    },
    "export-all": () => download(`muster-lists-${new Date().toISOString().slice(0, 10)}.json`, C.exportLists(S.lists), "application/json"),
    "toggle-theme": () => toggleTheme(),
    "about": () => about(),
    "colors": () => openColors(),
    "color-pick": (t) => { MC.set(t.dataset.k, t.dataset.v); refreshColorRow(t.dataset.k); },
    "color-reset": (t) => { MC.set(t.dataset.k, null); refreshColorRow(t.dataset.k); },
    "color-reset-all": () => { MC.resetAll(); MC.CATS.forEach((c) => refreshColorRow(c.k)); toast("All colors back to their defaults"); },
    "account": () => accountModal(),
    "sync-now": async () => { closeModal(); const ok = await SY.syncNow({ pull: true }); toast(ok ? "Lists synced" : `Sync failed – ${SYNC_TXT[(S.sync || {}).status] || "will retry"}`); },
    "sign-out": () => signOut(),
    "guest-start": () => startGuest(),
    "guest-info": () => guestModal(),
    "guest-signup": () => leaveGuest("signup", `Create your free account.${guestKeep()}`),
    "guest-signin": () => leaveGuest("signin", `Sign in to your account.${guestKeep()}`),
    "guest-exit": () => leaveGuest("signin", S.lists.length ? `You left guest mode. Your guest ${S.lists.length === 1 ? "list stays" : "lists stay"} on this device and ${S.lists.length === 1 ? "is" : "are"} added to your account when you sign in or create one here.` : "You left guest mode."),
    "auth-mode": (t) => { AUTH.mode = t.dataset.mode; AUTH.msg = null; const e = $("#auth-email"); if (e) AUTH.email = e.value; renderAuth(); },
    "reload-page": () => { const b = document.querySelector(".hbtn.reload"); if (b) b.classList.add("spin"); setTimeout(() => location.reload(), 150); },
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
        modal(r.attached && r.attached.length ? `${r.attached.map((x) => x.name).join(" + ")} + ${r.name}` : r.name, combinedDatasheet(F, r), { wide: true, sheet: true });
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
    "exp-ys": () => exportYellowscribe(),
    // meta
    "meta-faction": (t) => { S.ui.metaListDet = ""; location.hash = `#/meta/${t.dataset.slug}`; window.scrollTo(0, 0); },
    "meta-range": (t) => { S.ui.metaRange = t.dataset.range; lsSet(LS_WRRANGE, S.ui.metaRange); route(); },
    "meta-tab": (t) => { if (t.dataset.scope === "home") { S.ui.metaHome = t.dataset.tab; lsSet(LS_WRHOME, t.dataset.tab); } else { S.ui.metaTab = t.dataset.tab; lsSet(LS_WRTAB, t.dataset.tab); } route(); },
    "meta-disp": (t) => { S.ui.metaDispOpen = S.ui.metaDispOpen === t.dataset.name ? null : t.dataset.name; route(); },
    "meta-copy-list": (t) => { const L = S.metaLists && S.metaLists[t.dataset.slug]; const V = C.metaView(S.wr, S.ui.metaRange, S.ui.metaRtt);
      const src = L && ((V.rtt ? L.rtt : L.std) || L.std); const x = src && src.lists[+t.dataset.i]; if (x && x.text) copyText(x.text); },
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
    "enh": (t) => { const uid = S.ui.panel.uid; S.ui.enhOpen = null; mutate((l) => { const e = l.entries.find((x) => x.uid === uid); if (!t.value) e.enh = null; else { const [det, name] = t.value.split("||"); e.enh = { det, name }; } }); },
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
    "meta-rtt": (t) => { S.ui.metaRtt = t.checked; lsSet(LS_WRRTT, t.checked ? "1" : "0"); route(); },
    "meta-list-det": (t) => { S.ui.metaListDet = t.value; route(); },
  };
  const inputs = {
    "cat-search": (t) => { S.ui.q = t.value; const F = C.getFaction(S.idx, CUR); const body = $("#catbody"); if (body && F) body.innerHTML = renderCatalogBody(CUR, F, C.calcList(CUR, S.idx)); },
    "list-search": (t) => { S.ui.listQ = t.value; const pos = t.selectionStart; renderLists(); const n = $("[data-input=list-search]"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } } },
    "new-name": (t) => { NEW.name = t.value; },
    "color": (t) => { MC.set(t.dataset.k, t.value); refreshColorRow(t.dataset.k); },
    "color-b": (t) => { const k = t.dataset.k; MC.setB(k, t.value); const row = t.closest(".cset"); if (row) { row.classList.toggle("custom", !!(MC.get(k) || MC.getB(k))); const o = $(".cs-bv", row); if (o) o.textContent = bLabel(MC.getB(k)); } },
    "meta-q": (t) => { S.ui.metaQ = t.value; const pos = t.selectionStart; renderMeta(null); const n = $("[data-input=meta-q]"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } } },
  };
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".menu")) closeMenus();
    const t = ev.target.closest("[data-action]"); if (!t) return;
    const a = actions[t.dataset.action]; if (!a) return;
    if (authWall() && !AUTH_OK.has(t.dataset.action)) { ev.preventDefault(); closeModal(); route(); return; }
    if (t.tagName === "A" && t.getAttribute("href") && !t.getAttribute("href").startsWith("#")) return;
    if (t.tagName === "BUTTON" || t.tagName === "A") ev.preventDefault();
    a(t, ev);
  });
  const AUTH_OK = new Set(["guest-start", "auth-mode", "toggle-theme", "about", "colors", "color-pick", "color-reset", "color-reset-all", "close-modal", "modal-bg", "check-update", "reload-page", "show-report", "dismiss-report"]);
  document.addEventListener("submit", (ev) => { const f = ev.target.closest("[data-form=auth]"); if (!f) return; ev.preventDefault(); submitAuth(f); });
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
  // enhancement dropdown: remember which one is open so background re-renders (sync, data refresh) don't snap it shut
  document.addEventListener("toggle", (ev) => { const d = ev.target; if (!d.classList || !d.classList.contains("enh-dd")) return;
    if (d.open) S.ui.enhOpen = d.dataset.uid; else if (S.ui.enhOpen === d.dataset.uid) S.ui.enhOpen = null;
    const sm = d.querySelector("summary"); if (sm) sm.setAttribute("aria-label", sm.getAttribute("aria-label").replace(/(Open|Close) to change$/, d.open ? "Close to change" : "Open to change")); }, true);
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { const dd = ev.target.closest && ev.target.closest("details.enh-dd[open]"); if (dd) { dd.open = false; const sm = dd.querySelector("summary"); if (sm) sm.focus(); return; } }
    if (ev.key === "Escape") { if ($("#modal").innerHTML) closeModal(); else if (S.ui.panel && CUR) { S.ui.panel = null; renderEditor(CUR.id); } } });

  window.Muster = { S, SY, isGuest, GUEST_MAX, applyMerge, route, checkForUpdates, applyNewData, setData, encodeShare, decodeShare, boot, idb, actions, changes };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
