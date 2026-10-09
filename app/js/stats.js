/* Muster owner-only traffic counting (cookieless). Each app load / main view change sends ONE anonymous row to the
   Supabase table page_views (supabase/page_views.sql) with the public anon key: view, device class, referrer host and a
   random visitor id that is replaced every day. No IP, user id, e-mail, list data or user agent is sent. Skipped on
   localhost / previews, with Do Not Track / Global Privacy Control, and when "Don't count my visits" is on. Any failure
   (table not created yet, offline, blocked) is silent. */
(function (root) {
  "use strict";
  const LS_VID = "muster.stats.vid", LS_NOCOUNT = "muster.stats.noCount", LS_OWNER = "muster.stats.owner";
  const VIEWS = ["signin", "lists", "editor", "meta", "share", "other"];
  const PC_MQ = "(min-width: 761px) and (hover: hover) and (pointer: fine)";
  const mm = (win, q) => { try { return !!(win.matchMedia && win.matchMedia(q).matches); } catch (e) { return false; } };
  /* same breakpoints as the app layout: phone = narrow (tabs), pc = wide + mouse, tablet = wide + touch */
  function deviceClass(win) {
    win = win || root;
    if (mm(win, "(max-width: 760px)")) return "phone";
    return mm(win, PC_MQ) ? "pc" : "tablet";
  }
  /* referrer -> bare host name of another site (never path / query); same site or junk -> null */
  function refHost(referrer, ownHost) {
    if (!referrer) return null;
    let h;
    try { h = new URL(referrer).hostname.toLowerCase(); } catch (e) { return null; }
    h = h.replace(/^www\./, "");
    if (!h || !/^[a-z0-9.-]{1,100}$/.test(h)) return null;
    if (ownHost && h === String(ownHost).toLowerCase().replace(/^www\./, "")) return null;
    return h;
  }
  /* route hash -> coarse view name (no list ids, no faction names) */
  function viewOf(hash) {
    const p = String(hash || "").replace(/^#\/?/, "").split(/[/?]/)[0];
    if (p === "stats") return null;                // the owner's own Stats page is never counted
    if (!p || p === "lists") return "lists";
    if (p === "list") return "editor";
    if (p === "meta" || p === "share" || p === "signin") return p;
    return "other";
  }
  const localDay = (d) => { d = d || new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  function randHex(win) {
    const b = new Uint8Array(8);
    try { (win.crypto || root.crypto).getRandomValues(b); } catch (e) { for (let i = 0; i < 8; i++) b[i] = Math.floor(Math.random() * 256); }
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  /* a fresh random id per device per local day (yesterday's id is thrown away, so days can't be linked) */
  function visitorId(win, now) {
    const today = localDay(now);
    try {
      const o = JSON.parse(win.localStorage.getItem(LS_VID) || "null");
      if (o && o.d === today && /^[0-9a-f]{16}$/.test(o.id)) return o.id;
      const id = randHex(win); win.localStorage.setItem(LS_VID, JSON.stringify({ d: today, id })); return id;
    } catch (e) { return randHex(win); }
  }
  function isPreviewHost(loc) {
    const h = String((loc && loc.hostname) || "").toLowerCase();
    return !loc || loc.protocol === "file:" || !h || h === "localhost" || h === "0.0.0.0" || h === "[::1]" || h === "::1" ||
      /^127\./.test(h) || /\.local$/.test(h) || /^(10|192\.168)\./.test(h);
  }
  const lsGet = (win, k) => { try { return win.localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (win, k, v) => { try { if (v === null) win.localStorage.removeItem(k); else win.localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
  function noCount(win) { return lsGet(win, LS_NOCOUNT) === "1"; }
  function shouldCount(win) {
    const nav = win.navigator || {};
    if (isPreviewHost(win.location)) return false;
    if (nav.webdriver) return false;
    if (nav.doNotTrack === "1" || win.doNotTrack === "1" || nav.globalPrivacyControl === true) return false;
    return !noCount(win);
  }

  function create(cfg, opts) {
    opts = opts || {};
    const win = opts.win || root;
    const base = String((cfg && cfg.SUPABASE_URL) || "").trim().replace(/\/+$/, "");
    const key = String((cfg && cfg.SUPABASE_ANON_KEY) || "").trim();
    let dead = !(base && key), last = null, loaded = false;
    /* the exact row sent (exported for tests) */
    function payload(view, kind) {
      const row = { kind, view: VIEWS.includes(view) ? view : "other", device: deviceClass(win), ref_host: null, visitor: visitorId(win) };
      if (kind === "load") row.ref_host = refHost(win.document && win.document.referrer, win.location && win.location.hostname);
      return row;
    }
    function send(row) {
      try {
        const p = win.fetch(`${base}/rest/v1/page_views`, {
          method: "POST", keepalive: true, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
          // anon key only, even when signed in: rows can't be tied to an account
          headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify(row),
        });
        if (p && p.then) p.then((r) => { if (r && !r.ok && (r.status === 404 || r.status === 400 || r.status === 401 || r.status === 403)) dead = true; }, () => {});
      } catch (e) { /* never surfaces */ }
    }
    /* call on every route; counts the first load and each change of main view */
    function track(hash) {
      try {
        if (dead || !shouldCount(win)) return null;
        const view = viewOf(hash);
        if (!view) return null;
        const kind = loaded ? "view" : "load";
        if (loaded && view === last) return null;
        loaded = true; last = view;
        const row = payload(view, kind); send(row); return row;
      } catch (e) { return null; }
    }
    return { track, payload, disabled: () => dead };
  }
  root.MusterStats = { create, deviceClass, refHost, viewOf, visitorId, shouldCount, isPreviewHost, localDay, LS_VID, LS_NOCOUNT, LS_OWNER,
    noCount: (win) => noCount(win || root), setNoCount: (on, win) => lsSet(win || root, LS_NOCOUNT, on ? "1" : "0"),
    owner: (win) => lsGet(win || root, LS_OWNER), setOwner: (uid, win) => lsSet(win || root, LS_OWNER, uid || null) };
})(typeof self !== "undefined" ? self : this);
