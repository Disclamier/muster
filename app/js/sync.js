/* Muster accounts + cloud sync: Supabase GoTrue (auth) and PostgREST (table "lists") over plain fetch – no SDK, no CDN.
   Classic script; depends on window.MusterCore (merge logic). Exposes window.MusterSync.create(config, hooks).
   hooks: getLocal() -> {lists, tombs}; apply(mergeResult); onStatus(status); onSignedOut(reason). */
(function (root) {
  "use strict";
  const LS_AUTH = "muster.auth", LS_KNOWN = "muster.sync.known", LS_CSYNC = "muster.colors.syncedAt";
  // Colors bundle rides in the user's auth metadata (user_metadata.musterColors): no table/SQL needed. It is also copied
  // into the access token, so keep it small (a few KB; 16 KB hard cap).
  const COLORS_MAX = 16000;
  const C = root.MusterCore;

  function create(cfg, hooks) {
    cfg = cfg || {}; hooks = hooks || {};
    const base = String(cfg.SUPABASE_URL || "").trim().replace(/\/+$/, "");
    const key = String(cfg.SUPABASE_ANON_KEY || "").trim();
    const configured = !!(base && key);
    const fetchFn = (...a) => root.fetch(...a);
    const ls = {
      get(k) { try { return JSON.parse(root.localStorage.getItem(k) || "null"); } catch (e) { return null; } },
      set(k, v) { try { if (v === null || v === undefined) root.localStorage.removeItem(k); else root.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    };
    let session = configured ? ls.get(LS_AUTH) : null;
    if (session && !(session.access_token && session.refresh_token && session.user)) session = null;
    const st = { status: session ? "idle" : "signedout", error: null, lastSync: null, busy: null, again: null, debounce: null, lastPull: 0 };

    class SyncError extends Error { constructor(msg, kind, status) { super(msg); this.kind = kind; this.status = status; } }
    const nowSec = () => Math.floor(Date.now() / 1000);
    const redirectUrl = () => { try { return root.location.origin + root.location.pathname; } catch (e) { return ""; } };
    function errMsg(j, status) {
      const m = j && (j.msg || j.error_description || j.message || (typeof j.error === "string" ? j.error : null));
      return m || `HTTP ${status}`;
    }
    async function call(path, opts) {
      opts = opts || {};
      const headers = { apikey: key, "Content-Type": "application/json", ...(opts.headers || {}) };
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      let res;
      try { res = await fetchFn(base + path, { method: opts.method || "GET", headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, cache: "no-store" }); }
      catch (e) { throw new SyncError("You appear to be offline", "offline"); }
      let j = null; const txt = res.text ? await res.text().catch(() => "") : JSON.stringify(await res.json().catch(() => null));
      try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = null; }
      if (!res.ok) throw new SyncError(errMsg(j, res.status), res.status === 401 || res.status === 403 ? "auth" : "http", res.status);
      return j;
    }

    /* ---------------------------------------------------------------- session */
    function setSession(j) {
      if (!j || !j.access_token) return null;
      const exp = Number(j.expires_at) || (nowSec() + (Number(j.expires_in) || 3600));
      session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: exp,
        user: { id: j.user && j.user.id, email: j.user && j.user.email } };
      ls.set(LS_AUTH, session);
      return session;
    }
    function clearSession(reason) {
      session = null; ls.set(LS_AUTH, null); setStatus("signedout");
      if (reason && hooks.onSignedOut) hooks.onSignedOut(reason);
    }
    let refreshing = null;
    function refresh() {
      if (!session) return Promise.reject(new SyncError("Not signed in", "auth"));
      if (refreshing) return refreshing;
      const rt = session.refresh_token, user = session.user;
      refreshing = call("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: rt } })
        .then((j) => { if (!j.user) j.user = user; return setSession(j); })
        .catch((e) => { if (e.kind !== "offline" && e.status >= 400 && e.status < 500) { clearSession("expired"); } throw e; })
        .finally(() => { refreshing = null; });
      return refreshing;
    }
    /* a valid access token, refreshed when it expires within 2 minutes */
    async function token() {
      if (!session) throw new SyncError("Not signed in", "auth");
      if (!session.expires_at || session.expires_at - nowSec() < 120) await refresh();
      return session.access_token;
    }
    async function authed(path, opts) {
      let t = await token();
      try { return await call(path, { ...opts, token: t }); } catch (e) {
        if (e.kind !== "auth" || e.status !== 401) throw e;
        await refresh(); t = session.access_token;            // token revoked/expired early: refresh once and retry
        return call(path, { ...opts, token: t });
      }
    }

    /* ---------------------------------------------------------------- auth API */
    const cleanEmail = (e) => String(e || "").trim().toLowerCase();
    async function signUp(email, password) {
      const j = await call(`/auth/v1/signup?redirect_to=${encodeURIComponent(redirectUrl())}`, { method: "POST", body: { email: cleanEmail(email), password } });
      if (j && j.access_token) { setSession(j); setStatus("idle"); return { session }; }
      return { confirm: true };   // email confirmation is ON: GoTrue returns the user but no session
    }
    async function signIn(email, password) {
      const j = await call("/auth/v1/token?grant_type=password", { method: "POST", body: { email: cleanEmail(email), password } });
      setSession(j); setStatus("idle"); return { session };
    }
    async function recover(email) {
      await call(`/auth/v1/recover?redirect_to=${encodeURIComponent(redirectUrl())}`, { method: "POST", body: { email: cleanEmail(email) } });
      return true;
    }
    async function updatePassword(password) { await authed("/auth/v1/user", { method: "PUT", body: { password } }); return true; }
    async function signOut() {
      const t = session && session.access_token;
      if (t) { try { await call("/auth/v1/logout", { method: "POST", token: t }); } catch (e) { /* offline / already expired: local sign-out still happens */ } }
      clearSession(null);
    }
    /* email links (confirm sign-up, reset password) land on the site with #access_token=…&type=… or #error=… */
    async function consumeRedirect(hash) {
      const h = String(hash || "").replace(/^#\/?/, "");
      if (!/(^|&)(access_token|error_description|error)=/.test(h)) return null;
      const p = new URLSearchParams(h);
      if (p.get("error") || p.get("error_description")) return { error: (p.get("error_description") || p.get("error") || "").replace(/\+/g, " ") };
      const tmp = { access_token: p.get("access_token"), refresh_token: p.get("refresh_token"), expires_at: p.get("expires_at"), expires_in: p.get("expires_in") };
      try {
        const user = await call("/auth/v1/user", { token: tmp.access_token });
        tmp.user = user; setSession(tmp); setStatus("idle");
        return { type: p.get("type") || "signin", session };
      } catch (e) { return { error: e.message }; }
    }

    /* ---------------------------------------------------------------- sync */
    function setStatus(s, err) { st.status = s; st.error = err || null; if (hooks.onStatus) hooks.onStatus(info()); }
    function info() {
      const known = ls.get(LS_KNOWN) || {};
      let pending = 0; try { pending = hooks.getLocal ? C.pendingPush(hooks.getLocal(), known).length : 0; } catch (e) { pending = 0; }
      return { status: st.status, error: st.error, lastSync: st.lastSync, pending, email: session && session.user && session.user.email, configured, signedIn: !!session };
    }
    const online = () => !(root.navigator && root.navigator.onLine === false);
    function syncNow(opts) {
      const pull = !opts || opts.pull !== false;
      if (!configured || !session) return Promise.resolve(false);
      if (st.busy) { st.again = pull || st.again === true ? true : "push"; return st.busy; }
      if (!online()) { setStatus("offline"); return Promise.resolve(false); }
      st.busy = (async () => {
        await null;   // let st.busy be assigned first: a run with nothing to do finishes without any other await
        setStatus("syncing");
        try {
          const uid = session.user.id;
          if (pull) {
            st.lastPull = Date.now();
            const rows = await authed(`/rest/v1/lists?select=id,data,updated_at,deleted&user_id=eq.${encodeURIComponent(uid)}`, {}) || [];
            const res = C.mergeLists(hooks.getLocal(), rows);
            ls.set(LS_KNOWN, res.known);
            if (hooks.apply) hooks.apply(res);
          }
          const known = ls.get(LS_KNOWN) || {};
          const local = hooks.getLocal();
          const ids = C.pendingPush(local, known);
          if (ids.length) {
            const rows = ids.map((id) => C.syncRow(local, id, uid)).filter((r) => r.updated_at);
            await authed("/rest/v1/lists?on_conflict=user_id,id", { method: "POST", body: rows, headers: { Prefer: "resolution=merge-duplicates,return=minimal" } });
            for (const r of rows) known[r.id] = r.updated_at;
            ls.set(LS_KNOWN, known);
          }
          await colorsStep(pull);
          st.lastSync = new Date().toISOString();
          setStatus("synced");
          return true;
        } catch (e) {
          if (e.kind === "offline") setStatus("offline");
          else if (!session) setStatus("signedout");
          else setStatus("error", e.message);
          return false;
        } finally {
          st.busy = null;
          if (st.again) { const p = st.again === true; st.again = null; syncNow({ pull: p }); }
        }
      })();
      return st.busy;
    }
    /* Colors across devices: whole bundle, newest updatedAt wins. Pull (GET /auth/v1/user) on sign-in/start/focus/
       refresh; push (PUT /auth/v1/user {data:{musterColors}}) when this device changed since the last sync.
       A colors failure never fails the list sync. */
    async function colorsStep(pull) {
      if (!hooks.getColors) return;
      try {
        const local = hooks.getColors(); const lt = Number(local && local.updatedAt) || 0;
        let rt = Number(ls.get(LS_CSYNC)) || 0, push = lt > rt;
        if (pull) {
          const u = await authed("/auth/v1/user", {});
          const r = u && u.user_metadata && u.user_metadata.musterColors;
          rt = r && typeof r === "object" ? Number(r.updatedAt) || 0 : 0;
          if (rt && rt > lt) { if (hooks.applyColors) hooks.applyColors(r); ls.set(LS_CSYNC, rt); push = false; }
          else { push = lt > rt; if (!push) ls.set(LS_CSYNC, rt); }
        }
        if (!push) return;
        const b = hooks.getColors(); const txt = JSON.stringify(b);
        if (txt.length > COLORS_MAX) { st.colorsError = "Colors too large to sync"; return; }
        await authed("/auth/v1/user", { method: "PUT", body: { data: { musterColors: b } } });
        ls.set(LS_CSYNC, Number(b.updatedAt) || 0); st.colorsError = null;
      } catch (e) {
        st.colorsError = e.message;
        if (e.kind === "offline") throw e;
      }
    }
    /* debounced push after a local change (create / edit / rename / delete / import) */
    function schedulePush(ms) {
      if (!configured || !session) return;
      clearTimeout(st.debounce);
      if (st.status !== "syncing") setStatus(online() ? "syncing" : "offline");
      st.debounce = setTimeout(() => syncNow({ pull: false }), ms === undefined ? 1000 : ms);
    }
    /* owner-only Postgres functions (supabase/page_views.sql): POST /rest/v1/rpc/<fn> with the signed-in token */
    async function rpc(fn, args) {
      if (!configured || !session) throw new SyncError("Not signed in", "auth");
      return authed(`/rest/v1/rpc/${encodeURIComponent(fn)}`, { method: "POST", body: args || {} });
    }
    async function flush() { clearTimeout(st.debounce); await syncNow({ pull: false }); if (st.busy) await st.busy; return info(); }

    return { configured, info, session: () => session, user: () => session && session.user, signUp, signIn, recover, updatePassword, signOut,
      consumeRedirect, refresh, token, rpc, syncNow, schedulePush, flush, lastPull: () => st.lastPull, LS_KNOWN, LS_CSYNC,
      colorsError: () => st.colorsError || null };
  }
  root.MusterSync = { create };
})(typeof self !== "undefined" ? self : this);
