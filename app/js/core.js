/* Muster core: pure list/points logic. No DOM. Works in the browser (window.MusterCore) and Node (require). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MusterCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ROLE_ORDER = ["Epic Hero", "Character", "Battleline", "Dedicated Transport", "Infantry", "Mounted",
    "Beast", "Swarm", "Monster", "Vehicle", "Fortification", "Other"];

  /* local date/time, same format as the site footer, e.g. "Oct 7, 2026, 9:48 PM" */
  function fmtLocal(iso) {
    if (!iso) return "";
    const d = new Date(iso); if (isNaN(d)) return String(iso);
    try { return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }); } catch (e) { return d.toString(); }
  }
  const norm = (s) => String(s || "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9]/g, "");
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  /* ---------------------------------------------------------------- data indexing */
  function indexData(data) {
    const factions = {};
    for (const f of data.factions || []) {
      const units = {}, dets = {};
      for (const u of f.units) units[u.n] = u;
      for (const d of f.dets) dets[d.n] = d;
      factions[f.id] = { f, units, dets };
    }
    const subs = {};
    for (const g of data.groups || []) for (const s of g.factions) subs[s.id] = { ...s, group: g.name };
    const sizes = {};
    for (const s of data.battle_sizes || []) sizes[s.id] = s;
    return { data, factions, subs, sizes };
  }


  /* ---------------------------------------------------------------- detachment-restricted units */
  /* u.req = detachments that unlock the unit (derived at build time, e.g. World Eaters Blood Legions daemons ->
     Khorne Daemonkin). Allowed when any of them is selected. */
  function unitAllowed(u, list) {
    if (!u || !u.req || !u.req.length) return { ok: true, reason: "" };
    const ok = u.req.some((d) => (list.dets || []).includes(d));
    return { ok, reason: ok ? "" : `Only with the ${u.req.join(" or ")} detachment` };
  }

  /* ---------------------------------------------------------------- leaders / support attachment */
  const unitKey = (n) => norm(String(n || "").replace(/\s*\[Legends\]\s*$/i, ""));
  /* "leader" | "support" | null: can `who` be attached to a `body` unit (MFM Leader / Support lists) */
  function attachKind(who, body) {
    if (!who || !body) return null;
    const k = unitKey(body.n);
    if ((who.ldr || []).some((x) => unitKey(x) === k)) return "leader";
    if ((who.sup || []).some((x) => unitKey(x) === k)) return "support";
    return null;
  }
  const canAttach = (u) => !!(u && ((u.ldr && u.ldr.length) || (u.sup && u.sup.length)));
  /* bodyguard units in the list `entry` could join, with free/occupied state (one Leader + one Support each) */
  function attachTargets(list, idx, uid) {
    const F = getFaction(idx, list); if (!F) return [];
    const me = list.entries.find((e) => e.uid === uid); const mu = me && findUnit(F, me.unit);
    if (!mu || !canAttach(mu)) return [];
    const out = [];
    for (const e of list.entries) {
      if (e.uid === uid || e.attach) continue;
      const bu = findUnit(F, e.unit); const kind = attachKind(mu, bu);
      if (!kind) continue;
      const others = list.entries.filter((x) => x.uid !== uid && x.attach === e.uid && attachKind(findUnit(F, x.unit), bu) === kind);
      out.push({ entry: e, unit: bu, kind, taken: others.length > 0, by: others.map((x) => x.unit) });
    }
    return out;
  }

  /* ---------------------------------------------------------------- enhancement eligibility */
  const stripMd = (t) => String(t || "").replace(/\^\^|\*\*|__/g, "").replace(/[’‘]/g, "'").replace(/\u00a0/g, " ");
  const kwNorm = (t) => String(t || "").toUpperCase().replace(/[’‘]/g, "'").replace(/[^A-Z0-9' -]/g, " ").replace(/\s+/g, " ").trim();
  const _enhRx = new Map();
  /* parse "WORLD EATERS INFANTRY model only (excluding EPIC HERO units)." -> {alts:[...], excl:[...], text} */
  function enhRestriction(en) {
    const key = en[0] + "|" + (en[2] || "");
    if (_enhRx.has(key)) return _enhRx.get(key);
    let res = null;
    const t = stripMd(en[2]);
    const m = t.match(/(?:^|[.!?:]\s+|\n)\s*([A-Za-z][^.!?\n:]*?)\s+(?:models?|units?)\s+only\b\s*(?:\(\s*excluding\s+([^)]*)\))?/i);
    if (m) {
      const alts = m[1].split(/\s*,\s*|\s*\/\s*|\s+or\s+|\s+and\/or\s+/i).map((x) => kwNorm(x.replace(/^(a|an|the)\s+/i, ""))).filter(Boolean);
      const excl = m[2] ? m[2].split(/\s*,\s*|\s*\/\s*|\s+or\s+|\s+and\s+/i).map((x) => kwNorm(x.replace(/\b(units?|models?)\b/gi, ""))).filter(Boolean) : [];
      res = { alts, excl, text: m[0].replace(/^[.!?:\s]+/, "").trim().replace(/\.?$/, ".") };
    }
    _enhRx.set(key, res);
    return res;
  }
  /* can `text` (e.g. "WORLD EATERS DAEMON PRINCE") be written as a sequence of phrases from `set`? */
  function coveredBy(text, set) {
    const w = text.split(" "); const ok = new Array(w.length + 1).fill(false); ok[0] = true;
    for (let i = 0; i < w.length; i++) if (ok[i]) for (let j = i + 1; j <= w.length; j++) if (set.has(w.slice(i, j).join(" "))) ok[j] = true;
    return ok[w.length];
  }
  function unitKwSet(u, F) {
    // the army's name counts as a keyword for its own units (a Captain in a Space Wolves list is SPACE WOLVES), not
    // for units from a separate group (World Eaters' Blood Legions daemons are not WORLD EATERS)
    const s = new Set([...(u.kw || []), u.n, u.fk || (F && F.mainFk) || "", F && !u.grp && !u.req ? F.f.name : ""].filter(Boolean).map(kwNorm));
    for (const x of [...s]) { if (x.endsWith("S")) s.add(x.slice(0, -1)); else s.add(x + "S"); }
    return s;
  }
  function factionVocab(F) {
    if (F._vocab) return F._vocab;
    const v = new Set([kwNorm(F.f.name)]);
    for (const u of F.f.units) for (const x of unitKwSet(u, F)) v.add(x);
    return (F._vocab = v);
  }
  /* {ok, reason} - keyword/unit restriction written in the enhancement text. Unparseable restrictions allow. */
  function enhEligible(u, en, F) {
    if (!u) return { ok: false, reason: "" };
    const baseOf = (x) => isEpicHero(x) ? "Epic Heroes cannot take enhancements" : !en[3] && !isCharacter(x) ? "Characters only" : "";
    const base = baseOf(u);
    const r = enhRestriction(en);
    if (!r) return base ? { ok: false, reason: base } : { ok: true, reason: "" };
    if (!F.mainFk) { const c = {}; for (const x of F.f.units) if (x.fk && !x.grp) c[x.fk] = (c[x.fk] || 0) + 1; F.mainFk = Object.keys(c).sort((a, b) => c[b] - c[a])[0] || ""; }
    const vocab = factionVocab(F);
    if (r.alts.some((a) => !coveredBy(a, vocab))) return base ? { ok: false, reason: base } : { ok: true, reason: "" };   // wording we can't map -> only the base rules
    const matches = (x) => { const k = unitKwSet(x, F); return !r.excl.some((e) => coveredBy(e, k)) && r.alts.some((a) => coveredBy(a, k)); };
    if (!matches(u)) return { ok: false, reason: r.text };
    if (!base) return { ok: true, reason: "" };
    // The text targets units that normally can't take enhancements (Headhunter vehicle enhancements, C'tan Shards in
    // Pantheon of Woe): allowed only when no ordinary eligible unit in the faction matches the text.
    F._enhOrdinary = F._enhOrdinary || new Map();
    const key = en[0] + "|" + en[2];
    if (!F._enhOrdinary.has(key)) F._enhOrdinary.set(key, F.f.units.some((x) => !baseOf(x) && matches(x)));
    return F._enhOrdinary.get(key) ? { ok: false, reason: base } : { ok: true, reason: "" };
  }
  /* the attached group a unit belongs to: bodyguard uid (itself when it is the bodyguard) */
  function groupOf(list, e) { return e.attach && list.entries.some((x) => x.uid === e.attach) ? e.attach : e.uid; }
  /* state of each enhancement for one entry: {d, en, ok, reason, taken} (for the options panel) */
  function enhancementChoices(list, idx, uid) {
    const F = getFaction(idx, list); const e = list.entries.find((x) => x.uid === uid); if (!F || !e) return [];
    const u = findUnit(F, e.unit); if (!u) return [];
    const dets = (list.dets || []).map((n) => F.dets[n]).filter(Boolean);
    const c = calcList(list, idx);
    const used = {}; for (const x of list.entries) if (x.uid !== uid && x.enh) used[x.enh.name] = (used[x.enh.name] || 0) + 1;
    const g = groupOf(list, e);
    const groupHas = list.entries.find((x) => x.uid !== uid && x.enh && groupOf(list, x) === g);
    const atLimit = c.enhLimit != null && !e.enh && c.enhCount >= c.enhLimit;
    return dets.flatMap((d) => d.enh.map((en) => {
      const el = enhEligible(u, en, F);
      let ok = el.ok, reason = el.reason, taken = false;
      if (ok && !en[3] && used[en[0]]) { ok = false; taken = true; reason = `Already taken by ${list.entries.find((x) => x.uid !== uid && x.enh && x.enh.name === en[0]).unit}`; }
      else if (ok && en[3] && used[en[0]] >= 3) { ok = false; taken = true; reason = "Already taken 3 times"; }
      if (ok && groupHas) { ok = false; reason = `${groupHas.unit} in the same attached unit already has ${groupHas.enh.name} (one enhancement per unit)`; }
      if (ok && atLimit && !(e.enh && e.enh.name === en[0])) { ok = false; reason = `Enhancement limit reached (${c.enhCount}/${c.enhLimit})`; }
      return { d, en, ok, reason, taken };
    }));
  }
  /* tolerant lookup for saved lists: exact name, then normalised name (case/punctuation changes between data versions) */
  function findUnit(F, name) {
    if (!F) return null;
    if (F.units[name]) return F.units[name];
    if (!F._byNorm) { F._byNorm = {}; for (const u of F.f.units) if (!F._byNorm[norm(u.n)]) F._byNorm[norm(u.n)] = u; }
    return F._byNorm[norm(name)] || null;
  }
  function getFaction(idx, list) { return idx.factions[list.faction] || null; }
  function getSize(idx, list) {
    return idx.sizes[list.size] || (idx.data.battle_sizes || []).find((s) => s.points === 2000) || idx.data.battle_sizes[0];
  }

  const isKw = (u, k) => (u.kw || []).some((x) => x.toLowerCase() === k.toLowerCase());
  const isCharacter = (u) => u.r === "Character" || u.r === "Epic Hero" || isKw(u, "Character");
  const isEpicHero = (u) => u.r === "Epic Hero" || isKw(u, "Epic Hero");
  const isBattleline = (u) => u.r === "Battleline" || isKw(u, "Battleline");
  const isTransport = (u) => u.r === "Dedicated Transport" || isKw(u, "Dedicated Transport");

  /* ---------------------------------------------------------------- unit costs */
  function tierFor(unit, copy) {
    const tiers = unit.t || [];
    return tiers.find((t) => copy >= t[0] && (t[1] === null || t[1] === undefined || copy <= t[1])) || tiers[tiers.length - 1];
  }
  /* model options (rows with a model count) and add-ons (rows like "+ 1 Tidewall Defence Platform") */
  function modelOptions(unit, copy) {
    const t = tierFor(unit, copy || 1);
    if (!t) return [];
    return t[2].filter((r) => !(r[0] === null && String(r[2] || "").trim().startsWith("+")))
      .map((r) => ({ models: r[0], points: r[1], label: r[2] || (r[0] === 1 ? "1 model" : `${r[0]} models`) }));
  }
  /* the size option an entry picked: by model count, and by label when two sizes share a count
     (e.g. Wolf Guard Headtakers "6 Wolf Guard Headtakers" vs "3 Wolf Guard Headtakers, 3 Hunting Wolves") */
  function pickModelOption(opts, e) {
    const same = opts.filter((o) => o.models === (e ? e.models : undefined));
    return (e && e.ml != null && same.find((o) => o.label === e.ml)) || same[0] || null;
  }
  function addonOptions(unit, copy) {
    const t = tierFor(unit, copy || 1);
    if (!t) return [];
    return t[2].filter((r) => r[0] === null && String(r[2] || "").trim().startsWith("+"))
      .map((r) => ({ label: r[2], points: r[1] }));
  }
  function defaultModels(unit) {
    const o = modelOptions(unit, 1);
    return o.length ? o[0].models : 1;
  }
  function minCost(unit, copy) {
    const o = modelOptions(unit, copy || 1);
    return o.length ? Math.min(...o.map((x) => x.points)) : 0;
  }
  function unitLimit(unit, size) {
    if (isEpicHero(unit)) return 1;
    if (!size || size.unit_limit == null) return null;
    return (isBattleline(unit) || isTransport(unit)) ? size.unit_limit * 2 : size.unit_limit;
  }

  /* ---------------------------------------------------------------- list model */
  function newList({ name, faction, sub, size }) {
    const now = new Date().toISOString();
    return { id: uid(), name: name || "Unnamed list", faction, sub: sub || faction, size: size || "strikeforce",
      dets: [], entries: [], showLegends: false, created: now, updated: now, app: "muster", schema: 1 };
  }
  function newEntry(unit) {
    return { uid: uid(), unit: unit.n, models: defaultModels(unit), wargear: {}, addons: [], enh: null, warlord: false };
  }


  /* ---------------------------------------------------------------- loadouts (GrimSlate composition; points stay MFM-only)
     unit.lo = { m: [[name, min, max, fixed[], slots[], upgradesFrom, maxAtSize[[size,max]], addOn]], u: slots[], mn, mx }
     slot    = [name, opts[[name, max, text, wargearIdx, maxAtSize, wargearCount?]], defaults[], minTotal, maxTotal, optional]
               wargearCount: copies of the MFM per-item priced wargear one pick gives (e.g. "2 ectoplasma cannons" = 2)
     entry.lo = { c: {modelName: count}, p: {"model|slot": {option: count}} }   ("*|slot" = unit-level) */
  const _lom = new WeakMap();
  function loModel(u) {
    if (!u || !u.lo || !u.lo.m || !u.lo.m.length) return null;
    if (_lom.has(u)) return _lom.get(u);
    const slot = (s) => ({ name: s[0], opts: s[1].map((o) => ({ name: o[0], max: o[1], text: o[2], w: o[3], mas: o[4], wn: o[5] || 1 })),
      defaults: s[2] || [], minT: s[3], maxT: s[4], optional: !!s[5] });
    const M = { types: u.lo.m.map((m) => ({ name: m[0], min: m[1] || 0, max: m[2], fixed: m[3] || [], slots: (m[4] || []).map(slot),
      up: m[5] || null, mas: m[6] || null, addOn: !!m[7] })), unit: (u.lo.u || []).map(slot), mn: u.lo.mn, mx: u.lo.mx };
    _lom.set(u, M); return M;
  }
  const hasLoadout = (u) => !!loModel(u);
  function atSize(base, mas, N) {
    let v = base;
    for (const [size, mx] of [...(mas || [])].sort((a, b) => a[0] - b[0])) if (N >= size) v = mx;
    return v;
  }
  /* a base model's minimum is shared with the models upgraded from it (e.g. 4 Intercessors incl. grenade launchers) */
  const effMin = (M, t, c) => Math.max(0, t.min - M.types.filter((x) => x.up === t.name).reduce((n, x) => n + (c[x.name] || 0), 0));
  const typeMax = (t, N) => Math.min(atSize(t.max, t.mas, N), t.addOn ? Infinity : N);
  /* option max is per unit; when the option is the slot's default for every model, GrimSlate's max is per model */
  const optMax = (o, N, s, k) => o.max === null || o.max === undefined ? Infinity :
    atSize(o.max, o.mas, N) * (s && k > 1 && s.defaults.includes(o.name) ? k : 1);
  /* MFM and GrimSlate sometimes count models differently (e.g. Marneus Calgar = 1 model in MFM, 3 in GrimSlate) */
  const loN = (M, N) => (M.mn != null && N < M.mn ? M.mn : M.mx != null && N > M.mx ? M.mx : N);
  function slotRange(s, k) {
    const perMin = s.minT !== null && s.minT !== undefined ? s.minT : (s.optional ? 0 : 1);
    const perMax = s.maxT !== null && s.maxT !== undefined ? s.maxT : Math.max(1, perMin);
    return [k * perMin, k * perMax];
  }
  /* "3 Headtakers, 3 Hunting Wolves" -> counts by model type */
  function countsFromLabel(M, label) {
    if (!label) return null;
    const parts = String(label).split(/,|\band\b|\+/).map((x) => x.trim()).filter(Boolean);
    const out = {}; let hits = 0;
    for (const p of parts) {
      const m = p.match(/^(\d+)\s+(.+)$/); if (!m) continue;
      const pn = norm(m[2]).replace(/s$/, "");
      const t = M.types.find((t) => { const tn = norm(t.name).replace(/s$/, ""); return tn === pn || tn.startsWith(pn) || pn.startsWith(tn); });
      if (t) { out[t.name] = (out[t.name] || 0) + +m[1]; hits++; }
    }
    return hits ? out : null;
  }
  function fillerType(M, N) {
    const base = M.types.filter((t) => !t.up && !t.addOn);
    return base.sort((a, b) => (typeMax(b, N) - b.min) - (typeMax(a, N) - a.min))[0] || null;
  }
  function defaultCounts(M, N, label) {
    const c = {};
    for (const t of M.types) c[t.name] = t.min;
    const fromLabel = countsFromLabel(M, label);
    if (fromLabel) { for (const t of M.types) if (fromLabel[t.name] !== undefined) c[t.name] = fromLabel[t.name]; }
    let rem = N - M.types.filter((t) => !t.addOn).reduce((n, t) => n + c[t.name], 0);
    const base = M.types.filter((t) => !t.up && !t.addOn).sort((a, b) => (typeMax(b, N) - b.min) - (typeMax(a, N) - a.min));
    for (const t of base) { if (rem <= 0) break; const add = Math.min(rem, typeMax(t, N) - c[t.name]); if (add > 0) { c[t.name] += add; rem -= add; } }
    return c;
  }
  function defaultPicks(s, k) {
    const p = {};
    if (k <= 0) return p;
    const [lo] = slotRange(s, k);
    if (s.defaults.length) for (const d of s.defaults) { if (s.opts.some((o) => o.name === d)) p[d] = (p[d] || 0) + k; }
    let sum = Object.values(p).reduce((a, b) => a + b, 0);
    for (const o of [...s.opts].sort((a, b) => (s.defaults.includes(b.name) ? 1 : 0) - (s.defaults.includes(a.name) ? 1 : 0))) {  // top up (e.g. 2 heavy weapons per model)
      if (sum >= lo) break; const room = optMax(o, Infinity, s, k) - (p[o.name] || 0); const add = Math.min(room, lo - sum);
      if (add > 0) { p[o.name] = (p[o.name] || 0) + add; sum += add; }
    }
    return p;
  }
  function normPicks(s, k, cur, N) {
    const p = {};
    for (const o of s.opts) { const v = cur && cur[o.name]; if (v > 0) p[o.name] = Math.min(v, optMax(o, N, s, k)); }
    const [lo, hi] = slotRange(s, k);
    let sum = Object.values(p).reduce((a, b) => a + b, 0);
    if (!cur) return defaultPicks(s, k);
    const order = [...s.opts].sort((a, b) => (s.defaults.includes(a.name) ? 1 : 0) - (s.defaults.includes(b.name) ? 1 : 0)).reverse();
    for (const o of order) { if (sum <= hi) break; const take = Math.min(p[o.name] || 0, sum - hi); if (take) { p[o.name] -= take; sum -= take; if (!p[o.name]) delete p[o.name]; } }
    for (const o of order) { if (sum >= lo) break; const room = optMax(o, N, s, k) - (p[o.name] || 0); const add = Math.min(room, lo - sum); if (add > 0) { p[o.name] = (p[o.name] || 0) + add; sum += add; } }
    return p;
  }
  /* full, normalised loadout for an entry at unit size N (does not mutate the entry) */
  function getLoadout(u, e, N, label) {
    const M = loModel(u); if (!M) return null;
    N = loN(M, N);
    const src = e && e.lo;
    let c = src && src.c ? { ...src.c } : null;
    const total = (cc) => M.types.filter((t) => !t.addOn).reduce((n, t) => n + (cc[t.name] || 0), 0);
    if (c) {
      for (const t of M.types.filter((x) => x.up || x.addOn)) c[t.name] = Math.max(t.min, Math.min(c[t.name] || 0, typeMax(t, N)));
      for (const t of M.types.filter((x) => !x.up && !x.addOn)) c[t.name] = Math.max(effMin(M, t, c), Math.min(c[t.name] || 0, typeMax(t, N)));
      if (total(c) !== N) {
        const f = fillerType(M, N);
        if (f) c[f.name] = Math.max(effMin(M, f, c), Math.min(typeMax(f, N), c[f.name] + (N - total(c))));
        if (total(c) !== N) { // shrink upgrades back into their base, then fall back to defaults
          for (const t of M.types.filter((x) => x.up)) while (total(c) > N && c[t.name] > t.min) c[t.name]--;
          if (total(c) !== N) c = defaultCounts(M, N, label);
        }
      }
    } else c = defaultCounts(M, N, label);
    const p = {};
    for (const t of M.types) for (const s of t.slots) { const k = `${t.name}|${s.name}`; p[k] = normPicks(s, c[t.name] || 0, src && src.p ? src.p[k] : null, N); }
    for (const s of M.unit) { const k = `*|${s.name}`; p[k] = normPicks(s, 1, src && src.p ? src.p[k] : null, N); }
    return { c, p };
  }
  /* change the count of one model type (upgrades trade with the model they upgrade from) */
  function setModelCount(u, lo, typeName, value, N) {
    const M = loModel(u); const t = M.types.find((x) => x.name === typeName); if (!t) return lo;
    N = loN(M, N);
    const c = { ...lo.c };
    const v = Math.max(t.min, Math.min(typeMax(t, N), value));
    const d = v - (c[t.name] || 0); if (!d) return lo;
    if (t.addOn) { c[t.name] = v; return { c, p: lo.p }; }
    const src = M.types.find((x) => x.name === t.up) || fillerType(M, N);
    if (!src || src === t) return lo;
    const sv = (c[src.name] || 0) - d;
    c[t.name] = v;
    if (sv < effMin(M, src, c) || sv > typeMax(src, N)) return lo;
    c[src.name] = sv;
    return { c, p: lo.p };
  }
  function loadoutIssues(u, lo, N) {
    const M = loModel(u); if (!M || !lo) return [];
    N = loN(M, N);
    const out = [];
    const sumOf = (c) => M.types.filter((t) => !t.addOn).reduce((n, t) => n + (c[t.name] || 0), 0);
    const tot = sumOf(lo.c);
    // a mismatch that the default composition also has is a model-counting difference between MFM and GrimSlate, not a user error
    if (tot !== N && tot !== sumOf(defaultCounts(M, N, null))) out.push(`models add up to ${tot}, unit size is ${N}`);
    for (const t of M.types) { const k = lo.c[t.name] || 0; const mn = t.up || t.addOn ? t.min : effMin(M, t, lo.c); if (k < mn || k > typeMax(t, N)) out.push(`${t.name}: ${k} (allowed ${mn}–${typeMax(t, N)})`);
      for (const s of t.slots) { const sum = Object.values(lo.p[`${t.name}|${s.name}`] || {}).reduce((a, b) => a + b, 0); const [a, b] = slotRange(s, k);
        if (sum < a || sum > b) out.push(`${t.name} – ${s.name}: ${sum} selected (needs ${a === b ? a : `${a}–${b}`})`);
        for (const o of s.opts) { const v = (lo.p[`${t.name}|${s.name}`] || {})[o.name] || 0; if (v > optMax(o, N, s, k)) out.push(`${o.name}: max ${optMax(o, N, s, k)}`); } } }
    return out;
  }
  /* priced-wargear counts implied by the loadout (MFM wargear index -> count) */
  function loadoutWargear(u, lo) {
    const M = loModel(u); const out = {}; if (!M || !lo) return out;
    const add = (s, key) => { for (const o of s.opts) if (o.w !== null && o.w !== undefined) { const v = ((lo.p[key] || {})[o.name] || 0) * o.wn; if (v) out[o.w] = (out[o.w] || 0) + v; } };
    for (const t of M.types) for (const s of t.slots) add(s, `${t.name}|${s.name}`);
    for (const s of M.unit) add(s, `*|${s.name}`);
    return out;
  }
  function linkedWargear(u) {
    const M = loModel(u); const set = new Set(); if (!M) return set;
    for (const s of [...M.types.flatMap((t) => t.slots), ...M.unit]) for (const o of s.opts) if (o.w !== null && o.w !== undefined) set.add(o.w);
    return set;
  }
  /* loadout lines: [{count, name, gear:[{name, count}]}]; gear counts are per model-type totals */
  function loadoutLines(u, lo) {
    const M = loModel(u); if (!M || !lo) return [];
    const lines = [];
    for (const t of M.types) {
      const k = lo.c[t.name] || 0; if (!k) continue;
      const gear = t.fixed.map((w) => ({ name: w, count: k }));
      for (const s of t.slots) for (const [n, v] of Object.entries(lo.p[`${t.name}|${s.name}`] || {})) if (v > 0) gear.push({ name: n, count: v });
      lines.push({ count: k, name: t.name, gear });
    }
    const ug = []; for (const s of M.unit) for (const [n, v] of Object.entries(lo.p[`*|${s.name}`] || {})) if (v > 0) ug.push({ name: n, count: v });
    if (ug.length) { if (lines.length === 1) lines[0].gear.push(...ug); else lines.push({ count: 0, name: null, gear: ug }); }
    for (const l of lines) { const m = new Map(); for (const g of l.gear) m.set(g.name, (m.get(g.name) || 0) + g.count); l.gear = [...m].map(([name, count]) => ({ name, count })); }
    return lines;
  }
  /* "1x Intercessor Sergeant: Bolt pistol, Bolt Rifle" (counts shown only when not every model has it) */
  function loadoutText(line) {
    const g = line.gear.map((x) => (line.count > 1 && x.count !== line.count) || (!line.count && x.count > 1) ? `${x.count}x ${x.name}` : x.name).join(", ");
    return line.name ? `${line.count}x ${line.name}${g ? ": " + g : ""}` : g;
  }

  /* ---------------------------------------------------------------- calculation + validation */
  function calcList(list, idx) {
    const F = getFaction(idx, list);
    const size = getSize(idx, list);
    const res = { total: 0, units: 0, enhancements: 0, dp: 0, dpLimit: size ? size.dp : null, size,
      enhCount: 0, enhLimit: size ? size.enh : null, entries: [], byRole: {}, errors: [], warnings: [] };
    const err = (msg, uidRef) => res.errors.push({ msg, uid: uidRef || null });
    const warn = (msg, uidRef) => res.warnings.push({ msg, uid: uidRef || null });
    if (!F) { err(`Faction "${list.faction}" is not in the current data`); return res; }

    // detachments
    const dets = [];
    for (const dn of list.dets || []) {
      const d = F.dets[dn];
      if (!d) { err(`Detachment "${dn}" is no longer listed`); continue; }
      dets.push(d);
      res.dp += d.dp || 0;
      if (d.src === "gs") warn(`${d.n} is not in the current Munitorum Field Manual (data from GrimSlate)`);
    }
    if (!dets.length) err("Select a detachment");
    const fds = [...new Set(dets.flatMap((d) => d.fd || []))];
    res.dispositions = fds;
    if (list.disposition && dets.length && !fds.includes(list.disposition)) err(`Force Disposition ${list.disposition} is not offered by your detachments`);
    else if (!list.disposition && fds.length) warn("Select a Force Disposition");
    if (res.dpLimit != null) {
      const single3 = size.single3dp && dets.length === 1 && res.dp === 3;
      if (res.dp > res.dpLimit && !single3) err(`Detachment Points: ${res.dp} / ${res.dpLimit}`);
    }
    // detachment-level restrictions (e.g. UNIQUE: DYNASTY) - only one detachment with the same unique tag
    const tags = {};
    for (const d of dets) for (const r of d.rs || []) if (/^UNIQUE/i.test(r)) (tags[r] = tags[r] || []).push(d.n);
    for (const [t, ns] of Object.entries(tags)) if (ns.length > 1) err(`${t}: only one of ${ns.join(", ")}`);

    // entries
    const copies = {}, enhUse = {};
    let warlords = 0;
    for (const e of list.entries) {
      const u = F.units[e.unit] || findUnit(F, e.unit);
      const row = { uid: e.uid, entry: e, unit: u, name: e.unit, role: u ? u.r : "Other", copy: 0, base: 0,
        wargear: 0, addons: 0, enh: 0, enhName: null, total: 0, missing: !u, modelsLabel: "" };
      if (!u) {
        err(`${e.unit} is no longer in the Munitorum Field Manual`, e.uid);
        res.entries.push(row); continue;
      }
      copies[u.n] = (copies[u.n] || 0) + 1;
      row.copy = copies[u.n];
      const opts = modelOptions(u, row.copy);
      let opt = pickModelOption(opts, e);
      if (!opt && opts.length) {
        opt = opts[0];
        if (e.models != null) warn(`${u.n}: ${e.models} models is no longer a valid size; using ${opt.label}`, e.uid);
      }
      row.base = opt ? opt.points : 0;
      row.modelsLabel = opt ? opt.label : "";
      const linked = linkedWargear(u);
      for (const [wn, cnt] of Object.entries(e.wargear || {})) {
        const wi = (u.w || []).findIndex((x) => x[0] === wn);
        if (wi >= 0 && !linked.has(wi) && cnt > 0) row.wargear += u.w[wi][1] * cnt;
      }
      if (hasLoadout(u)) {
        row.lo = getLoadout(u, e, opt ? opt.models : (e.models || 1), opt ? opt.label : null);
        const lw = loadoutWargear(u, row.lo);
        for (const [wi, cnt] of Object.entries(lw)) if (u.w && u.w[wi]) row.wargear += u.w[wi][1] * cnt;
        row.loLines = loadoutLines(u, row.lo);
        for (const msg of loadoutIssues(u, row.lo, opt ? opt.models : (e.models || 1))) warn(`${u.n} loadout: ${msg}`, e.uid);
      }
      for (const a of addonOptions(u, row.copy)) if ((e.addons || []).includes(a.label)) row.addons += a.points;
      const al = unitAllowed(u, list);
      if (!al.ok) err(`${u.n}: ${al.reason.replace(/^Only/, "only available")}`, e.uid);
      if (e.enh) {
        const d = dets.find((x) => x.n === e.enh.det);
        const en = d && d.enh.find((x) => x[0] === e.enh.name);
        if (!d) err(`${e.enh.name} needs detachment ${e.enh.det}`, e.uid);
        else if (!en) err(`${e.enh.name} is no longer in ${d.n}`, e.uid);
        else {
          row.enh = en[1] || 0; row.enhName = en[0];
          const upgrade = !!en[3];
          const el = enhEligible(u, en, F);
          if (!el.ok) err(el.reason === "Epic Heroes cannot take enhancements" ? `${u.n}: Epic Heroes cannot take enhancements`
            : el.reason === "Characters only" ? `${u.n}: only Characters can take ${en[0]}` : `${u.n} cannot take ${en[0]}: ${el.reason}`, e.uid);
          const k = en[0];
          enhUse[k] = enhUse[k] || { n: 0, upgrade };
          enhUse[k].n += 1;
        }
      }
      if (e.warlord) {
        if (!isCharacter(u)) err(`${u.n} cannot be the Warlord (not a Character)`, e.uid);
        warlords += 1;
      }
      if (u.lg) warn(`${u.n} is a Legends unit`, e.uid);
      row.total = row.base + row.wargear + row.addons + row.enh;
      res.units += row.base + row.wargear + row.addons;
      res.enhancements += row.enh;
      res.entries.push(row);
      const r = (res.byRole[row.role] = res.byRole[row.role] || { points: 0, entries: [] });
      r.points += row.total; r.entries.push(row);
    }
    // leader / support attachments
    const byUid = {}; for (const r of res.entries) byUid[r.uid] = r;
    const slots = {};
    for (const r of res.entries) {
      const e = r.entry; if (!r.unit) continue;
      if (e.attach) {
        const t = byUid[e.attach];
        if (!t || !t.unit) { warn(`${r.unit.n}: the unit it was attached to is no longer in the list`, e.uid); continue; }
        if (t.entry.attach) { err(`${r.unit.n} cannot join ${t.unit.n}: that unit is itself attached to another unit`, e.uid); continue; }
        const kind = attachKind(r.unit, t.unit);
        if (!kind) { warn(`${r.unit.n} cannot be attached to ${t.unit.n} (not in its Leader/Support list)`, e.uid); continue; }
        r.attachedTo = t; r.attachKind = kind; (t.attached = t.attached || []).push(r);
        const k = t.uid + "|" + kind; (slots[k] = slots[k] || []).push(r);
      } else if (r.unit.sup && r.unit.sup.length && !(r.unit.ldr && r.unit.ldr.length)) {
        warn(`${r.unit.n} is a Support unit and must be attached to a bodyguard unit`, e.uid);
      }
    }
    for (const [k, rs] of Object.entries(slots)) if (rs.length > 1) {
      const t = byUid[k.split("|")[0]];
      err(`${t.unit.n} has ${rs.length} ${rs[0].attachKind === "leader" ? "Leaders" : "Support units"} attached (${rs.map((x) => x.unit.n).join(", ")}) - max 1`, t.uid);
    }
    const enhByGroup = {};
    for (const r of res.entries) if (r.entry.enh && r.unit) { const g = r.attachedTo ? r.attachedTo.uid : r.uid; (enhByGroup[g] = enhByGroup[g] || []).push(r); }
    for (const rs of Object.values(enhByGroup)) if (rs.length > 1)
      err(`No unit (including attached units) can have more than one enhancement: ${rs.map((x) => `${x.unit.n} (${x.entry.enh.name})`).join(", ")}`, rs[1].uid);
    for (const [n, c] of Object.entries(copies)) {
      const u = F.units[n]; const lim = unitLimit(u, size);
      if (lim != null && c > lim) err(`${n}: ${c} / ${lim} units`);
    }
    for (const [k, v] of Object.entries(enhUse)) {
      if (!v.upgrade && v.n > 1) err(`${k} taken ${v.n} times (max 1)`);
      if (v.upgrade && v.n > 3) err(`${k} taken ${v.n} times (max 3)`);
      res.enhCount += v.upgrade ? 1 : v.n;
    }
    if (res.enhLimit != null && res.enhCount > res.enhLimit) err(`Enhancements: ${res.enhCount} / ${res.enhLimit}`);
    if (warlords > 1) err(`${warlords} Warlords selected (max 1)`);
    if (!warlords && list.entries.length) err("Select a Warlord");
    res.total = res.units + res.enhancements;
    if (size && res.total > size.points) err(`Points: ${res.total} / ${size.points}`);
    return res;
  }

  /* ---------------------------------------------------------------- search */
  function searchUnits(units, q) {
    q = String(q || "").trim().toLowerCase();
    if (!q) return units;
    const terms = q.split(/\s+/);
    return units.filter((u) => {
      const hay = [u.n, u.r, ...(u.kw || []), u.lg ? "legends" : "", ...(u.t || []).flatMap((t) => t[2].map((r) => `${r[1]}`))]
        .join(" | ").toLowerCase();
      return terms.every((t) => {
        const m = t.match(/^([<>]=?)(\d+)$/);
        if (m) {
          const c = minCost(u, 1), n = +m[2];
          return m[1] === "<" ? c < n : m[1] === "<=" ? c <= n : m[1] === ">" ? c > n : c >= n;
        }
        return hay.includes(t);
      });
    });
  }

  /* ---------------------------------------------------------------- diffs between data versions */
  const tierSig = (u) => JSON.stringify((u.t || []).map((t) => [t[0], t[1], t[2].map((r) => [r[0], r[1]])]));
  function costSummary(u) {
    return (u.t || []).map((t) => {
      const lbl = t.length && (t[0] !== 1 || t[1] !== null) ? `${ord(t[0])}${t[1] === null ? "+" : t[1] === t[0] ? "" : "–" + ord(t[1])}: ` : "";
      return lbl + t[2].map((r) => `${r[0] == null ? (r[2] || "") : r[0]}=${r[1]}`).join(", ");
    }).join(" | ");
  }
  function ord(n) { return n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"); }

  /* Points-only diff between two data versions. Rule text, keywords, loadouts and display-name tweaks are ignored;
     a unit only counts as changed when no old datasheet of the same name has the same costs. */
  function diffData(oldData, newData) {
    const out = { units: [], enhancements: [], detachments: [] };
    const oldF = {}; for (const f of oldData.factions || []) oldF[f.id] = f;
    const base = (n) => norm(String(n).replace(/\s*\[Legends\]\s*$/i, "").replace(/\s*\(\d+\)$/, ""));
    const sig = (u) => tierSig(u) + "|" + JSON.stringify((u.w || []).map((w) => [norm(w[0]), w[1]]));
    for (const nf of newData.factions || []) {
      const of = oldF[nf.id]; if (!of) continue;
      const byName = {}, byBase = {};
      for (const u of of.units) { (byName[norm(u.n)] = byName[norm(u.n)] || []).push(u); (byBase[base(u.n)] = byBase[base(u.n)] || []).push(u); }
      const newBase = new Set(nf.units.map((u) => base(u.n)));
      for (const u of nf.units) {
        const cands = byName[norm(u.n)] || byBase[base(u.n)];
        if (!cands) { out.units.push({ faction: nf.id, name: u.n, old: null, new: costSummary(u), added: true }); continue; }
        if (cands.some((o) => sig(o) === sig(u)) || (byBase[base(u.n)] || []).some((o) => sig(o) === sig(u))) continue;
        const o = cands[0];
        out.units.push({ faction: nf.id, name: u.n, old: costSummary(o), new: costSummary(u), oldMin: minCost(o, 1), newMin: minCost(u, 1) });
      }
      for (const u of of.units) if (!newBase.has(base(u.n))) out.units.push({ faction: nf.id, name: u.n, old: costSummary(u), new: null, removed: true });
      const od = {}; for (const d of of.dets) od[d.n] = d;
      for (const d of nf.dets) {
        const o = od[d.n]; if (!o) { out.detachments.push({ faction: nf.id, name: d.n, old: null, new: d.dp, added: true }); continue; }
        if (o.dp !== d.dp) out.detachments.push({ faction: nf.id, name: d.n, old: o.dp, new: d.dp });
        const oe = {}; for (const e of o.enh) oe[e[0]] = e;
        for (const e of d.enh) {
          if (oe[e[0]] && oe[e[0]][1] !== e[1]) out.enhancements.push({ faction: nf.id, detachment: d.n, name: e[0], old: oe[e[0]][1], new: e[1] });
          else if (!oe[e[0]]) out.enhancements.push({ faction: nf.id, detachment: d.n, name: e[0], old: null, new: e[1], added: true });
        }
      }
    }
    return out;
  }

  /* how each saved list changes when moving from oldIdx to newIdx */
  function diffLists(lists, oldIdx, newIdx) {
    const out = [];
    for (const l of lists) {
      const a = calcList(l, oldIdx), b = calcList(l, newIdx);
      const items = [];
      const am = {}; for (const r of a.entries) am[r.uid] = r;
      for (const r of b.entries) {
        const o = am[r.uid]; if (!o) continue;
        const oUnit = o.base + o.wargear + o.addons, nUnit = r.base + r.wargear + r.addons;
        if (r.missing && !o.missing) items.push({ kind: "unit", name: r.name, old: oUnit, new: null, note: "removed from MFM" });
        else if (oUnit !== nUnit) {
          const multi = r.unit && modelOptions(r.unit, r.copy).length > 1;
          items.push({ kind: "unit", name: `${r.name}${multi && r.modelsLabel ? ` (${r.modelsLabel})` : ""}`, old: oUnit, new: nUnit });
        }
        if (o.enh !== r.enh && r.entry.enh) items.push({ kind: "enhancement", name: r.entry.enh.name, old: o.enh, new: r.enh });
      }
      const oF = getFaction(oldIdx, l), nF = getFaction(newIdx, l);
      for (const dn of l.dets || []) {
        const od = oF && oF.dets[dn], nd = nF && nF.dets[dn];
        if (od && nd && od.dp !== nd.dp) items.push({ kind: "detachment", name: dn, old: od.dp, new: nd.dp, unit: "DP" });
        if (od && !nd) items.push({ kind: "detachment", name: dn, old: od.dp, new: null, note: "no longer listed" });
      }
      if (a.total !== b.total || items.length) out.push({ id: l.id, name: l.name, oldTotal: a.total, newTotal: b.total, items });
    }
    return out;
  }

  /* ---------------------------------------------------------------- plain-text export */
  function listToText(list, idx, meta) {
    const c = calcList(list, idx);
    const F = getFaction(idx, list);
    const sub = idx.subs[list.sub];
    const size = c.size;
    const L = [];
    L.push(`${list.name} (${c.total} / ${size ? size.points : "?"} pts)`);
    L.push(`Faction: ${sub ? sub.name : F ? F.f.name : list.faction}${sub && F && sub.name !== F.f.name ? ` (${F.f.name})` : ""}`);
    if (size) L.push(`Battle Size: ${size.name} (${size.points} pts)`);
    const dets = (list.dets || []).map((d) => F && F.dets[d]).filter(Boolean);
    L.push(`Detachments: ${dets.map((d) => `${d.n} (${d.dp} DP)`).join(", ") || "none"}` +
      (c.dpLimit != null ? `  [${c.dp}/${c.dpLimit} DP]` : `  [${c.dp} DP]`));
    if (list.disposition) L.push(`Force Disposition: ${list.disposition}`);
    L.push(`Enhancements: ${c.enhCount}${c.enhLimit != null ? "/" + c.enhLimit : ""}`);
    L.push("");
    for (const role of ROLE_ORDER) {
      const r = c.byRole[role]; if (!r) continue;
      L.push(`${role.toUpperCase()} [${r.points} pts]`);
      for (const row of r.entries) {
        const e = row.entry;
        const multi = row.unit && modelOptions(row.unit, row.copy).length > 1;
        L.push(`${multi ? row.modelsLabel.replace(/ models?$/, "x") + " " : ""}${row.name} (${row.total} pts)${e.warlord ? " [Warlord]" : ""}`);
        for (const l of row.loLines || []) L.push(`  • ${loadoutText(l)}`);
        if (row.attachedTo) L.push(`  • ${attachText(row, c)}`);
        if (row.enhName) L.push(`  • Enhancement: ${row.enhName} (+${row.enh} pts)`);
        for (const g of gearList(row)) L.push(`  • ${g}`);
        if (e.note) L.push(`  • ${e.note}`);
      }
      L.push("");
    }
    const missing = c.entries.filter((r) => r.missing);
    if (missing.length) { L.push("NOT IN CURRENT DATA"); for (const r of missing) L.push(`${r.name}`); L.push(""); }
    L.push(`TOTAL: ${c.total} pts${size ? ` / ${size.points}` : ""}`);
    if (c.errors.length) L.push(`Validation: ${c.errors.map((x) => x.msg).join("; ")}`);
    L.push("");
    L.push(footer(meta));
    return L.join("\n");
  }


  /* ---------------------------------------------------------------- export formats (mirroring New Recruit) */
  const fmtPts = (n) => Number(n || 0).toLocaleString("en-US");
  function exportContext(list, idx) {
    const c = calcList(list, idx);
    const F = getFaction(idx, list);
    const sub = idx.subs[list.sub];
    const dets = (list.dets || []).map((d) => F && F.dets[d]).filter(Boolean);
    const rows = [];
    for (const role of ROLE_ORDER) for (const r of (c.byRole[role] || { entries: [] }).entries) rows.push(r);
    let charN = 0;
    for (const r of rows) r.charSlot = r.unit && isCharacter(r.unit) ? ++charN : null;
    return { c, F, sub, dets, rows, size: c.size,
      factionName: F ? F.f.name : list.faction, subName: sub ? sub.name : (F ? F.f.name : list.faction) };
  }
  const modelCount = (r) => (r.entry && r.entry.models) || 1;
  /* loadout lines for exports; a single model named like the unit lists its gear directly */
  function loLinesFor(r) {
    const ls = r.loLines || [];
    const single = ls.length === 1 && ls[0].count === 1 && r.unit && norm(ls[0].name) === norm(r.unit.n);
    return { ls, single };
  }
  function loadoutSummary(r) {
    const { ls, single } = loLinesFor(r);
    if (single) return ls[0].gear.map((g) => (g.count > 1 ? `${g.count}x ${g.name}` : g.name)).join(", ");
    return ls.map(loadoutText).join("; ");
  }
  function gearList(r) {
    const out = [];
    const linked = r.unit ? linkedWargear(r.unit) : new Set();
    for (const [wn, cnt] of Object.entries(r.entry.wargear || {})) {
      const wi = r.unit && r.unit.w ? r.unit.w.findIndex((x) => x[0] === wn) : -1;
      if (cnt > 0 && !linked.has(wi)) out.push(cnt > 1 ? `${cnt}x ${wn}` : wn);
    }
    for (const a of r.entry.addons || []) out.push(a.replace(/^\+\s*/, ""));
    return out;
  }
  /* "Attached to: Khorne Berzerkers" (+ "#2" when the list has several units of that name) */
  function attachText(r, c) {
    const t = r.attachedTo; if (!t) return "";
    const same = c.entries.filter((x) => x.name === t.name).length;
    return `Attached to: ${t.name}${same > 1 ? ` #${t.copy}` : ""}${r.attachKind === "support" ? " (support)" : ""}`;
  }
  function footer(meta) {
    return `Exported with Muster (unofficial) – points: Munitorum Field Manual ${meta && meta.mfm_version || ""}` +
      (meta && meta.fetched_at ? ` (fetched ${fmtLocal(meta.fetched_at)})` : "");
  }

  /* "GW" – layout of the official Warhammer 40,000 app export (New Recruit's default format) */
  function exportGW(list, idx, meta) {
    const X = exportContext(list, idx); const L = [];
    L.push(`${list.name} (${fmtPts(X.c.total)} Points)`, "");
    L.push(X.factionName);
    if (X.subName !== X.factionName) L.push(X.subName);
    if (X.size) L.push(`${X.size.name} (${fmtPts(X.size.points)} Points)`);
    for (const d of X.dets) L.push(`${d.n} (${d.dp} DP)`);
    if (list.disposition) L.push(`Force Disposition: ${list.disposition}`);
    L.push("");
    const sections = [["CHARACTERS", (r) => r.unit && isCharacter(r.unit)], ["BATTLELINE", (r) => r.unit && !isCharacter(r.unit) && isBattleline(r.unit)],
      ["DEDICATED TRANSPORTS", (r) => r.unit && !isCharacter(r.unit) && !isBattleline(r.unit) && isTransport(r.unit)],
      ["OTHER DATASHEETS", (r) => !r.unit || (!isCharacter(r.unit) && !isBattleline(r.unit) && !isTransport(r.unit))]];
    for (const [title, pred] of sections) {
      const rs = X.rows.filter(pred).concat(title === "OTHER DATASHEETS" ? X.c.entries.filter((r) => r.missing) : []);
      if (!rs.length) continue;
      L.push(title, "");
      for (const r of rs) {
        L.push(`${r.name} (${fmtPts(r.total)} Points)`);
        if (r.entry.warlord) L.push("  • Warlord");
        if (r.attachedTo) L.push(`  • ${attachText(r, X.c)}`);
        const { ls, single } = loLinesFor(r);
        if (!ls.length && r.unit && modelOptions(r.unit, r.copy).length > 1) L.push(`  • ${r.modelsLabel}`);
        if (single) for (const g of ls[0].gear) L.push(`  • ${g.count}x ${g.name}`);
        else for (const l of ls) {
          if (l.name) { L.push(`  • ${l.count}x ${l.name}`); for (const g of l.gear) L.push(`    ◦ ${g.count}x ${g.name}`); }
          else for (const g of l.gear) L.push(`  • ${g.count}x ${g.name}`);
        }
        for (const g of gearList(r)) L.push(`  • ${/^\d+x /.test(g) ? g : "1x " + g}`);
        if (r.enhName) L.push(`  • Enhancement: ${r.enhName}`);
        if (r.entry.note) L.push(`  • ${r.entry.note}`);
        L.push("");
      }
    }
    L.push(footer(meta));
    return L.join("\n");
  }

  /* "Tournament" – WTC-style header block + one line per unit (New Recruit 'Tournament'/'WTC-Compact') */
  function wtcHeader(list, X) {
    const FENCE = "+++++++++++++++++++++++++++++++++++++++++++++++";
    const wl = X.rows.find((r) => r.entry.warlord);
    const enh = X.rows.filter((r) => r.enhName);
    const L = [FENCE, `+ LIST NAME: ${list.name}`, `+ FACTION KEYWORD: ${X.factionName}${X.subName !== X.factionName ? ` – ${X.subName}` : ""}`];
    if (X.dets.length) for (const d of X.dets) L.push(`+ DETACHMENT: ${d.n} (${d.dp} DP)`); else L.push("+ DETACHMENT: —");
    if (list.disposition) L.push(`+ FORCE DISPOSITION: ${list.disposition}`);
    L.push(`+ TOTAL ARMY POINTS: ${X.c.total}pts`, `+ POINTS LIMIT: ${X.size ? X.size.points : X.c.total}pts`, "+",
      `+ WARLORD: ${wl ? `Char${wl.charSlot || ""}: ${wl.name}` : "—"}`,
      `+ ENHANCEMENT: ${enh.length ? enh.map((r) => `${r.enhName} (on Char${r.charSlot || ""}: ${r.name})`).join("; ") : "—"}`,
      `+ NUMBER OF UNITS: ${X.c.entries.length}`, FENCE);
    return L;
  }
  function exportWTC(list, idx, meta) {
    const X = exportContext(list, idx); const L = wtcHeader(list, X); L.push("");
    for (const r of X.rows) {
      const gear = []; if (r.entry.warlord) gear.push("Warlord");
      const lsum = loadoutSummary(r); if (lsum) gear.push(lsum);
      gear.push(...gearList(r));
      L.push(`${r.charSlot ? `Char${r.charSlot}: ` : ""}${modelCount(r)}x ${r.name} (${r.base + r.wargear + r.addons} pts): ${gear.join(", ")}`.replace(/: $/, ""));
      if (r.attachedTo) L.push(attachText(r, X.c));
      if (r.enhName) L.push(`Enhancement: ${r.enhName} (+${r.enh} pts)`);
    }
    for (const r of X.c.entries.filter((x) => x.missing)) L.push(`${r.name} (not in current MFM)`);
    return L.join("\n") + "\n";
  }
  /* "Tournament (full)" – WTC full: header + BATTLELINE section with two-line unit blocks */
  function exportWTCFull(list, idx, meta) {
    const X = exportContext(list, idx); const L = wtcHeader(list, X); L.push("", "BATTLELINE", "");
    for (const r of X.rows) {
      L.push(`${r.charSlot ? `Char${r.charSlot}: ` : ""}${modelCount(r)}x ${r.name} (${r.base + r.wargear + r.addons} pts)`);
      if (r.entry.warlord) L.push("• Warlord");
      if (r.attachedTo) L.push(`• ${attachText(r, X.c)}`);
      for (const l of r.loLines || []) { const g = l.gear.map((x) => (l.count > 1 && x.count !== l.count ? `${x.count}x ${x.name}` : x.name)).join(", ");
        L.push(l.name ? `${l.count} with ${g}${(r.loLines.length > 1) ? ` (${l.name})` : ""}` : `• ${g}`); }
      const gear = gearList(r); if (gear.length) L.push(`• ${gear.join(", ")}`);
      if (r.entry.note) L.push(`• ${r.entry.note}`);
      if (r.enhName) L.push(`Enhancement: ${r.enhName} (+${r.enh} pts)`);
      L.push("");
    }
    return L.join("\n");
  }
  /* "Simple" – compact plain list grouped by battlefield role */
  function exportSimple(list, idx, meta) { return listToText(list, idx, meta); }
  /* "Stratagems" – every stratagem from the selected detachments (New Recruit's stratagems export) */
  function exportStratagems(list, idx, meta) {
    const X = exportContext(list, idx); const L = [`${list.name} – Stratagems`, ""];
    for (const d of X.dets) {
      L.push(`== ${d.n.toUpperCase()} (${d.dp} DP) ==`);
      if (d.rule && d.rule[0]) L.push(`Detachment rule – ${d.rule[0]}: ${String(d.rule[1] || "").replace(/\*\*|\^\^/g, "")}`, "");
      if (!d.st.length) L.push("(no stratagem data available)", "");
      for (const s of d.st) {
        L.push(`${s[0]} – ${s[1]}CP${s[3] ? ` – ${s[3]}` : ""}${s[2] ? ` – ${s[2]}` : ""}${s[4] ? ` (${s[4]})` : ""}`);
        L.push(String(s[5] || "").replace(/\*\*|\^\^/g, ""), "");
      }
    }
    L.push(footer(meta));
    return L.join("\n");
  }
  const EXPORT_FORMATS = [
    { id: "gw", name: "GW", desc: "Official Warhammer 40,000 app layout", fn: exportGW },
    { id: "wtc", name: "Tournament", desc: "WTC compact: header block + one line per unit", fn: exportWTC },
    { id: "wtc-full", name: "Tournament (full)", desc: "WTC full: header block + unit blocks", fn: exportWTCFull },
    { id: "simple", name: "Simple", desc: "Plain list grouped by battlefield role", fn: exportSimple },
    { id: "stratagems", name: "Stratagems", desc: "Stratagems + detachment rules of the selected detachments", fn: exportStratagems },
  ];
  function exportText(list, idx, meta, format, opts) {
    const f = EXPORT_FORMATS.find((x) => x.id === format) || EXPORT_FORMATS[0];
    let t = f.fn(list, idx, meta);
    if (opts && opts.markdown) t = toMarkdown(t);
    return t;
  }
  function toMarkdown(t) {
    return t.split("\n").map((l) => /^[A-Z][A-Z0-9 '’\-+()]+$/.test(l.trim()) && l.trim().length > 3 ? `**${l.trim()}**` :
      /^== (.*) ==$/.test(l) ? `### ${l.slice(3, -3)}` : l.replace(/^  • /, "- ").replace(/^• /, "- ")).join("\n");
  }
  /* Discord: code blocks no longer than Discord's 2000-char message limit (one copy button per block) */
  function discordBlocks(text, limit) {
    limit = (limit || 2000) - 8;
    const blocks = []; let cur = "";
    for (const para of text.split(/\n(?=\n)/)) {
      if ((cur + para).length > limit && cur) { blocks.push(cur); cur = ""; }
      if (para.length > limit) { for (const line of para.split("\n")) { if ((cur + "\n" + line).length > limit) { blocks.push(cur); cur = ""; } cur += (cur ? "\n" : "") + line; } }
      else cur += para;
    }
    if (cur.trim()) blocks.push(cur);
    return blocks.map((b) => "```\n" + b.replace(/^\n+|\n+$/g, "") + "\n```");
  }

  /* ---------------------------------------------------------------- Yellowscribe / Tabletop Simulator export
     Yellowscribe (yellowscribe.link) turns a BattleScribe/New Recruit roster (.rosz = zipped .ros XML) into a
     Tabletop Simulator army. Its parser (github.com/ThePants999/Yellowscribe, bin/roszParser.js) reads only what is
     inside the roster: unit/model selections, their profiles (Unit / Abilities / Ranged Weapons / Melee Weapons),
     rules and categories, plus the game-system id for the edition. No catalogue ids are looked up, so Muster writes
     a self-contained roster from its own data (GrimSlate profiles + the list's loadouts). */
  const YS_SYSTEM = { id: "sys-352e-adc2-7639-d610", name: "Warhammer 40,000 11th Edition" };
  const YS_PTS = "51b2-306e-1021-d207";
  const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const xmlEsc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  const ysText = (t) => stripMd(t).replace(/\r/g, "").trim();
  const plurEq = (a, b) => a === b || a + "s" === b || a + "es" === b || b + "s" === a || b + "es" === a;
  /* gear option name -> {weapons:[[wp, mult]], abilities:[wa]} or null.
     Handles exact names and compound options ("2 Heavy Bolters", "Bolt Pistol and Boltgun", "Two rocket pods and hellstrike rack"). */
  function ysResolveGear(ds, name) {
    if (!ds) return null;
    const wpBy = (n) => ds.wp.find((w) => norm(w[0]) === n) || ds.wp.find((w) => plurEq(norm(w[0]), n));
    const waBy = (n) => (ds.wa || []).filter((a) => norm(a[0]) === n || norm(a[1]) === n || plurEq(norm(a[0]), n));
    const one = (part) => {
      let mult = 1; let p = String(part).trim();
      const m = p.match(/^(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:x\s+|×\s*)?(.+)$/i);
      const tryName = (s, k) => { const n = norm(s); const w = wpBy(n); const a = waBy(n); return w || a.length ? { weapons: w ? [[w, k]] : [], abilities: a } : null; };
      const direct = tryName(p, 1); if (direct) return direct;
      if (m) { mult = /^\d+$/.test(m[1]) ? +m[1] : NUM_WORDS[m[1].toLowerCase()]; p = m[2]; }
      return tryName(p, mult);
    };
    const whole = one(name); if (whole) return whole;
    const parts = String(name).split(/\s*(?:,|&|\+|\bw\/|\band\b|\bwith\b)\s*/i).filter(Boolean);
    if (parts.length < 2) return null;
    const out = { weapons: [], abilities: [], unmatched: [] };
    for (const p of parts) { const r = one(p); if (!r) { out.unmatched.push(p); continue; } out.weapons.push(...r.weapons); out.abilities.push(...r.abilities); }
    return out.weapons.length || out.abilities.length ? out : null;   // partial match: e.g. "Thunder Hammer & Storm Shield"
  }
  /* the models of one list row: [{type, n, gear:[{name, q}]}] (q = per model), grouped by identical loadout */
  function ysModels(r, ds) {
    const total = modelCount(r);
    let stacks = (r.loLines || []).filter((l) => l.name && l.count > 0).map((l) => ({ type: l.name, count: l.count, gear: l.gear }));
    const unitGear = (r.loLines || []).filter((l) => !l.name).flatMap((l) => l.gear);
    const linked = r.unit ? linkedWargear(r.unit) : new Set();   // MFM-priced wargear picked outside the loadout editor
    for (const [wn, cnt] of Object.entries((r.entry && r.entry.wargear) || {})) {
      const wi = r.unit && r.unit.w ? r.unit.w.findIndex((x) => x[0] === wn) : -1;
      if (cnt > 0 && !linked.has(wi)) unitGear.push({ name: wn, count: cnt });
    }
    if (!stacks.length) {
      const ml = (ds && ds.ml) || [];
      stacks = [{ type: ml.length === 1 ? ml[0][0] : r.name, count: total, gear: (ml[0] ? ml[0][1] : []).map((g) => ({ name: g, count: total })) }];
    }
    const models = [];
    for (const s of stacks) {
      const ms = Array.from({ length: s.count }, () => ({ type: s.type, gear: new Map() }));
      let cur = 0;
      const give = (list, g) => {
        const k = list.length; if (!k) return;
        const per = Math.floor(g.count / k), rem = g.count % k;
        for (const m of list) if (per) m.gear.set(g.name, (m.gear.get(g.name) || 0) + per);
        for (let i = 0; i < rem; i++) { const m = list[(cur + i) % k]; m.gear.set(g.name, (m.gear.get(g.name) || 0) + 1); }
        cur = (cur + rem) % k;
      };
      for (const g of s.gear) give(ms, g);
      s.models = ms; s.give = give;
      models.push(...ms);
    }
    if (unitGear.length) { const big = stacks.slice().sort((a, b) => b.count - a.count)[0]; for (const g of unitGear) big.give(big.models, g); }
    // GrimSlate's composition sometimes falls short of the MFM unit size (e.g. 9 of 10 Grenadiers): pad with the commonest model
    const M = r.unit && loModel(r.unit);
    if (M && r.lo) {
      const addOns = new Set(M.types.filter((t) => t.addOn).map((t) => t.name));
      const base = stacks.filter((s) => !addOns.has(s.type)).sort((a, b) => b.count - a.count)[0];
      const want = loN(M, total), have = stacks.filter((s) => !addOns.has(s.type)).reduce((n, s) => n + s.count, 0);
      if (base && have < want) { for (let i = have; i < want; i++) models.push({ type: base.type, gear: new Map(base.models[0].gear) }); models.padded = { n: want - have, type: base.type }; }
    }
    const groups = new Map();
    for (const m of models) {
      const sig = m.type + "|" + [...m.gear].sort((a, b) => a[0].localeCompare(b[0])).map((x) => x.join("=")).join(",");
      if (!groups.has(sig)) groups.set(sig, { type: m.type, n: 0, gear: [...m.gear].map(([name, q]) => ({ name, q })) });
      groups.get(sig).n++;
    }
    const out = [...groups.values()];
    for (const type of new Set(out.map((g) => g.type))) {   // name split-off groups "<type> w/ <extra gear>"
      const gs = out.filter((g) => g.type === type); if (gs.length < 2) continue;
      const base = gs.slice().sort((a, b) => b.n - a.n)[0];
      const bq = new Map(base.gear.map((g) => [g.name, g.q]));
      for (const g of gs) if (g !== base) {
        const extra = g.gear.filter((x) => bq.get(x.name) !== x.q).map((x) => x.name);
        g.label = `${type} w/ ${extra.join(", ") || "alternate loadout"}`;
      }
    }
    out.padded = models.padded || null;
    return out;
  }
  /* Muster list -> BattleScribe roster XML (.ros) for Yellowscribe. ds = datasheets.json. Returns {xml, issues[]} */
  function exportYellowscribe(list, idx, ds, meta) {
    const X = exportContext(list, idx);
    const fds = (ds && ds.factions && X.F && ds.factions[X.F.f.id]) || null;
    const issues = [];
    let idN = 0;
    const id = () => { const h = (++idN).toString(16).padStart(12, "0"); return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${"m57r"}`; };
    const coreText = (n) => { const g = (ds && ds.weapon_keywords) || {}; return ysText(g[n] || g[String(n).replace(/\s+[\dD+\-"*]+$/, "")] || ""); };
    const facText = (n) => { const x = ((fds && fds.rules) || []).find((y) => norm(y[0]) === norm(n)); return x ? ysText(x[1]) : ""; };
    const ch = (name, v) => `<characteristic name="${xmlEsc(name)}" typeId="${xmlEsc(norm(name))}">${xmlEsc(v)}</characteristic>`;
    const abilityProfile = (name, text) => `<profile id="${id()}" name="${xmlEsc(name)}" hidden="false" typeId="abilities" typeName="Abilities"><characteristics>${ch("Description", ysText(text))}</characteristics></profile>`;
    const unitProfile = (name, s, inv) => `<profile id="${id()}" name="${xmlEsc(name)}" hidden="false" typeId="unit" typeName="Unit"><characteristics>` +
      [["M", s.M], ["T", s.T], ["SV", s.SV || s.Sv], ["W", s.W], ["LD", s.LD || s.Ld], ["OC", s.OC], ["InSv", inv]].map(([k, v]) => ch(k, v || "-")).join("") + `</characteristics></profile>`;
    const weaponProfiles = (w) => w[2].map((p) => {
      const melee = w[1] === "m" || String(p[1]).toLowerCase() === "melee";
      const nm = w[2].length > 1 || p[0] ? `➤ ${w[0]}${p[0] ? " - " + p[0] : ""}` : w[0];
      return `<profile id="${id()}" name="${xmlEsc(nm)}" hidden="false" typeId="${melee ? "melee" : "ranged"}" typeName="${melee ? "Melee Weapons" : "Ranged Weapons"}"><characteristics>` +
        [["Range", melee ? "Melee" : p[1]], ["A", p[2]], [melee ? "WS" : "BS", p[3]], ["S", p[4]], ["AP", p[5]], ["D", p[6]], ["Keywords", (p[7] || []).join(", ") || "-"]].map(([k, v]) => ch(k, v == null || v === "" ? "-" : v)).join("") +
        `</characteristics></profile>`;
    }).join("");
    const sel = (o) => `<selection id="${id()}" name="${xmlEsc(o.name)}" entryId="${xmlEsc(o.entryId || "muster::" + norm(o.name))}" number="${o.number || 1}" type="${o.type}"${o.from ? ` from="${o.from}"` : ""}>` +
      (o.rules ? `<rules>${o.rules}</rules>` : "") + (o.profiles ? `<profiles>${o.profiles}</profiles>` : "") +
      (o.children && o.children.length ? `<selections>${o.children.join("")}</selections>` : "") +
      (o.pts != null ? `<costs><cost name="pts" typeId="${YS_PTS}" value="${o.pts}"/></costs>` : "") +
      (o.cats && o.cats.length ? `<categories>${o.cats.map((c, i) => `<category id="${id()}" name="${xmlEsc(c)}" entryId="muster::cat::${xmlEsc(norm(c))}" primary="${i === 0}"/>`).join("")}</categories>` : "") + `</selection>`;
    const rule = (name, text) => `<rule id="${id()}" name="${xmlEsc(name)}" hidden="false"><description>${xmlEsc(text)}</description></rule>`;

    // each bodyguard preceded by the characters attached to it (character above its unit, together in Yellowscribe)
    const rows = X.rows.filter((r) => !r.attachedTo);
    const ordered = []; for (const r of rows) { for (const a of X.rows.filter((x) => x.attachedTo === r)) ordered.push(a); ordered.push(r); }
    for (const r of X.rows) if (!ordered.includes(r)) ordered.push(r);
    for (const r of X.c.entries.filter((x) => x.missing)) ordered.push(r);

    const unitSels = [];
    for (const r of ordered) {
      const u = r.unit; const dsu = fds && u ? fds.units[u.n] : null;
      const role = u ? u.r : "Other";
      const cats = [role, ...((u && u.kw) || []).filter((k) => k !== role)];
      cats.push(`Faction: ${(u && u.fk) || X.factionName}`);
      if (r.entry.warlord) cats.push("Warlord");
      if (!u || !dsu) issues.push(`${r.name}: no datasheet in Muster's data – exported by name only (no stats/weapons)`);
      const extras = [];   // abilities that belong to the unit's first model (enhancement, warlord, attachment)
      if (r.enhName) { const d = X.dets.find((x) => x.n === r.entry.enh.det); const en = d && d.enh.find((x) => x[0] === r.enhName);
        extras.push(sel({ name: r.enhName, type: "upgrade", pts: r.enh, profiles: abilityProfile(`Enhancement: ${r.enhName}`, en ? en[2] : ""), cats: ["Enhancements"] })); }
      if (r.entry.warlord) extras.push(sel({ name: "Warlord", type: "upgrade", profiles: abilityProfile("Warlord", "This model is your WARLORD."), cats: ["Warlord"] }));
      if (r.attachedTo) extras.push(sel({ name: "Attached", type: "upgrade", profiles: abilityProfile(r.attachKind === "support" ? "Attached (Support)" : "Attached (Leader)",
        `${attachText(r, X.c).replace(/^Attached to: /, "Attached to ")}. Move and fight as one unit with it.`) }));
      const joined = (r.attached || []).map((a) => `${a.name}${a.attachKind === "support" ? " (Support)" : " (Leader)"}`);
      if (joined.length) extras.push(sel({ name: "Joined by", type: "upgrade", profiles: abilityProfile("Joined by", `${joined.join(", ")} – attached to this unit.`) }));

      const groups = ysModels(r, dsu);
      if (groups.padded) issues.push(`${r.name}: Muster's loadout data lists fewer models than the unit size – added ${groups.padded.n} × ${groups.padded.type}`);
      const modelSels = groups.map((g, gi) => {
        const children = [];
        for (const it of g.gear) {
          const res = ysResolveGear(dsu, it.name);
          if (!res) { if (dsu) issues.push(`${r.name}: "${it.name}" has no profile (exported by name only)`); children.push(sel({ name: it.name, type: "upgrade", number: g.n * it.q })); continue; }
          for (const p of res.unmatched || []) { issues.push(`${r.name}: "${p}" has no profile (exported by name only)`); children.push(sel({ name: p, type: "upgrade", number: g.n * it.q })); }
          for (const [w, mult] of res.weapons) {
            const wa = res.abilities.filter((a) => norm(a[0]) === norm(w[0]));
            children.push(sel({ name: w[0], type: "upgrade", number: g.n * it.q * mult, profiles: weaponProfiles(w) + wa.map((a) => abilityProfile(a[1], a[2])).join("") }));
          }
          for (const a of res.abilities.filter((a) => !res.weapons.some(([w]) => norm(w[0]) === norm(a[0]))))
            children.push(sel({ name: it.name, type: "upgrade", number: g.n * it.q, profiles: abilityProfile(a[1], a[2]) }));
        }
        if (gi === 0) children.push(...extras);
        return { name: g.label || g.type, n: g.n, children };
      });
      if (!modelSels.length) modelSels.push({ name: r.name, n: modelCount(r), children: extras });
      const unitProfiles = dsu ? unitProfile(u.n, dsu.s || {}, dsu.inv) + (dsu.ab || []).map((a) => abilityProfile(a[0], a[1])).join("") : "";
      const rules = dsu ? [...(dsu.cr || []).map((n) => rule(n, coreText(n))), ...(dsu.fa || []).map((n) => rule(n, facText(n)))].join("") : "";
      const pts = r.base + r.wargear + r.addons + r.enh;
      const single = modelSels.length === 1 && modelSels[0].n === 1;
      if (single) unitSels.push(sel({ name: r.name, type: "model", pts, rules, profiles: unitProfiles, children: modelSels[0].children, cats }));
      else unitSels.push(sel({ name: r.name, type: "unit", pts, rules, profiles: unitProfiles, cats,
        children: modelSels.map((m) => sel({ name: m.name, type: "model", number: m.n, children: m.children })) }));
      for (const a of r.entry.addons || []) issues.push(`${r.name}: add-on "${a.replace(/^\+\s*/, "")}" is listed by name only`);
    }

    const config = [
      sel({ name: "Battle Size", type: "upgrade", children: X.size ? [sel({ name: `${X.size.name} (${X.size.points} Point limit)`, type: "upgrade" })] : [], cats: ["Configuration"] }),
      sel({ name: "Detachment", type: "upgrade", cats: ["Configuration"], children: X.dets.map((d) => sel({ name: d.n, type: "upgrade",
        rules: d.rule && d.rule[0] ? rule(d.rule[0], ysText(d.rule[1])) : "" })) }),
    ];
    const total = X.c.total;
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<roster id="${id()}" name="${xmlEsc(list.name)}" battleScribeVersion="2.03" generatedBy="Muster" gameSystemId="${YS_SYSTEM.id}" gameSystemName="${YS_SYSTEM.name}" gameSystemRevision="1" xmlns="http://www.battlescribe.net/schema/rosterSchema">\n` +
      `<costs><cost name="pts" typeId="${YS_PTS}" value="${total}"/></costs>` +
      (X.size ? `<costLimits><costLimit name="pts" typeId="${YS_PTS}" value="${X.size.points}"/></costLimits>` : "") + "\n" +
      `<forces><force id="${id()}" name="Army Roster" entryId="muster::army-roster" catalogueId="muster::${xmlEsc(X.F ? X.F.f.id : list.faction)}" catalogueRevision="1" catalogueName="${xmlEsc(X.subName)}">\n` +
      `<selections>\n${config.join("\n")}\n${unitSels.join("\n")}\n</selections>\n` +
      `<categories><category id="${id()}" name="Configuration" entryId="muster::cat::configuration" primary="false"/></categories>\n` +
      `</force></forces>\n` +
      `<customNotes>${xmlEsc(footer(meta))}</customNotes>\n</roster>\n`;
    return { xml, issues: [...new Set(issues)] };
  }

  /* minimal ZIP writer (stored, no compression) – a .rosz is a zip holding one .ros */
  let _crcT = null;
  function crc32(bytes) {
    if (!_crcT) { _crcT = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; _crcT[n] = c >>> 0; } }
    let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = _crcT[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const utf8 = (s) => (typeof TextEncoder === "function" ? new TextEncoder().encode(s) : Uint8Array.from(Buffer.from(s, "utf8")));
  function zipStore(files) {
    const parts = [], central = []; let off = 0;
    const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff], u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    for (const f of files) {
      const name = utf8(f.name), data = typeof f.data === "string" ? utf8(f.data) : f.data, crc = crc32(data);
      const common = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
      const local = Uint8Array.from([...u32(0x04034b50), ...common]);
      parts.push(local, name, data);
      central.push(Uint8Array.from([...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), name);
      off += local.length + name.length + data.length;
    }
    const cdSize = central.reduce((n, b) => n + b.length, 0);
    const end = Uint8Array.from([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(off), ...u16(0)]);
    const all = [...parts, ...central, end]; const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
    let p = 0; for (const b of all) { out.set(b, p); p += b.length; }
    return out;
  }
  /* .rosz bytes for Yellowscribe: {bytes, xml, issues, filename} */
  function exportYellowscribeRosz(list, idx, ds, meta) {
    const r = exportYellowscribe(list, idx, ds, meta);
    const base = String(list.name || "list").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "list";
    return { ...r, filename: `${base}.rosz`, bytes: zipStore([{ name: `${base}.ros`, data: r.xml }]) };
  }

  /* share links: list JSON -> base64url (optionally deflated by the caller) */
  function b64urlEncode(bytes) {
    let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return (typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64urlDecode(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
    const bin = typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("binary");
    const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
  }
  function shareableList(l) {
    return { n: l.name, f: l.faction, s: l.sub, z: l.size, d: l.dets, p: l.disposition || undefined,
      e: l.entries.map((e) => [e.unit, e.models, e.wargear && Object.keys(e.wargear).length ? e.wargear : 0, e.addons && e.addons.length ? e.addons : 0,
        e.enh ? [e.enh.det, e.enh.name] : 0, e.warlord ? 1 : 0, e.note || 0, e.lo || 0,
        e.attach ? l.entries.findIndex((x) => x.uid === e.attach) : -1].concat(e.ml != null ? [e.ml] : [])) };
  }
  function listFromShareable(o) {
    const l = newList({ name: o.n, faction: o.f, sub: o.s, size: o.z });
    l.dets = o.d || []; if (o.p) l.disposition = o.p;
    l.entries = (o.e || []).map((a) => ({ uid: uid(), unit: a[0], models: a[1], wargear: a[2] || {}, addons: a[3] || [],
      enh: a[4] ? { det: a[4][0], name: a[4][1] } : null, warlord: !!a[5], ...(a[6] ? { note: a[6] } : {}), ...(a[7] ? { lo: a[7] } : {}), ...(a[9] != null ? { ml: a[9] } : {}) }));
    (o.e || []).forEach((a, i) => { if (a[8] != null && a[8] >= 0 && l.entries[a[8]]) l.entries[i].attach = l.entries[a[8]].uid; });
    return l;
  }

  /* ---------------------------------------------------------------- import/export */
  function exportLists(lists) { return JSON.stringify({ app: "muster", schema: 1, exported: new Date().toISOString(), lists }, null, 1); }
  function importLists(text) {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : Array.isArray(j.lists) ? j.lists : j.entries ? [j] : null;
    if (!arr) throw new Error("No lists found in file");
    return arr.filter((l) => l && l.faction && Array.isArray(l.entries)).map((l) => ({
      ...l, id: uid(), entries: l.entries.map((e) => ({ wargear: {}, addons: [], enh: null, warlord: false, ...e, uid: e.uid || uid() })),
      dets: Array.isArray(l.dets) ? l.dets : [], updated: new Date().toISOString() }));
  }
  function duplicateList(l) {
    const c = JSON.parse(JSON.stringify(l));
    c.id = uid(); c.name = `${l.name} (copy)`; c.created = c.updated = new Date().toISOString();
    c.entries.forEach((e) => (e.uid = uid()));
    return c;
  }


  /* ---------------------------------------------------------------- meta win rates (listhammer) */
  /* stable sort of table rows by key; nulls always last; strings case-insensitive */
  function sortRows(rows, key, dir) {
    const m = dir === "asc" ? 1 : -1;
    return rows.map((r, i) => [r, i]).sort((A, B) => {
      const a = typeof key === "function" ? key(A[0]) : A[0][key], b = typeof key === "function" ? key(B[0]) : B[0][key];
      const an = a === null || a === undefined || a === "", bn = b === null || b === undefined || b === "";
      if (an || bn) return an && bn ? A[1] - B[1] : an ? 1 : -1;
      const c = typeof a === "string" || typeof b === "string" ? String(a).localeCompare(String(b), undefined, { sensitivity: "base" }) : a - b;
      return c ? c * m : A[1] - B[1];
    }).map((x) => x[0]);
  }
  /* listhammer faction record for a list's faction / sub-faction id */
  function metaFaction(wr, factionId, subId) {
    if (!wr || !wr.factions) return null;
    return wr.factions.find((f) => f.mfm_id && (f.mfm_id === subId)) || wr.factions.find((f) => f.mfm_id === factionId) || null;
  }
  /* win rate of a single detachment (summed over every combination that includes it) */
  function metaDetachment(mf, detName) {
    if (!mf) return null;
    const k = norm(detName);
    return (mf.detachments_single || []).find((d) => norm(d.name) === k || (d.mfm && norm(d.mfm.name) === k)) || null;
  }
  /* listhammer views: time window (weekend | 4weeks | dataslate) x Include RTTs. Older winrates.json (no datasets) is still read. */
  const META_RANGES = ["weekend", "4weeks", "dataslate"];
  const META_RANGE_LABEL = { weekend: "This Weekend", "4weeks": "Last 4 Weeks", dataslate: "Since Dataslate" };
  function metaRanges(wr) {
    const ds = (wr && wr.datasets) || null;
    if (!ds) return [{ key: "weekend", label: "This Weekend" }].concat(wr && wr.factions && wr.factions.some((f) => f.last_4_weeks) ? [{ key: "4weeks", label: "Last 4 Weeks" }] : []);
    return META_RANGES.filter((r) => ds[r] || ds[r + "_rtt"]).map((r) => ({ key: r, label: (ds[r] || ds[r + "_rtt"]).label || META_RANGE_LABEL[r] }));
  }
  function metaHasRtt(wr) { return !!(wr && wr.datasets && Object.keys(wr.datasets).some((k) => /_rtt$/.test(k))); }
  /* the dataset actually shown for a requested range / RTT choice (falls back to what exists) */
  function metaView(wr, range, rtt) {
    const rs = metaRanges(wr).map((r) => r.key);
    const r = rs.includes(range) ? range : "weekend";
    const ds = (wr && wr.datasets) || null;
    if (!ds) {
      const rows = ((wr && wr.factions) || []).map((f) => { const src = r === "4weeks" ? (f.last_4_weeks || {}) : f;
        return { slug: f.slug, name: f.name, mfm_id: f.mfm_id, win_rate: src.win_rate, players: src.players, games: src.games, x0: src.x0, x1: src.x1, event_wins: src.event_wins, overrep: src.overrep }; });
      const R = (wr && wr.ranges && wr.ranges[r]) || (wr && wr.date_range) || {};
      return { key: r, range: r, rtt: false, label: R.label || META_RANGE_LABEL[r], dates: R.dates, criteria: null, rows, events: [], dispositions: r === "4weeks" ? ((wr && wr.dispositions_4weeks) || []) : [], disposition_matchups: [] };
    }
    const key = rtt && ds[r + "_rtt"] ? r + "_rtt" : ds[r] ? r : r + "_rtt";
    const d = ds[key] || {};
    const byName = {}; for (const f of wr.factions || []) byName[f.name] = f;
    const rows = (d.table || []).map((t) => { const f = byName[t.name] || {}; return { ...t, slug: f.slug || t.name.toLowerCase().replace(/\s*\(.*?\)/g, "").replace(/[’']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), mfm_id: f.mfm_id || null }; });
    return { key, range: r, rtt: /_rtt$/.test(key), label: d.label || META_RANGE_LABEL[r], dates: d.dates, criteria: d.criteria, rows,
      events: d.events || [], event_count: d.event_count, event_players: d.event_players, dispositions: d.dispositions || [], disposition_matchups: d.disposition_matchups || [] };
  }
  /* faction detail (detachments, matchups, ... are This Weekend only) with or without RTTs */
  function metaDetail(f, rtt) {
    if (!f) return null;
    if (rtt && f.rtt) return { ...f, ...f.rtt, rtt_view: true };
    return { ...f, rtt_view: false };
  }
  const fmtPct = (v) => v === null || v === undefined || v === "" || isNaN(v) ? "—" : `${Number(v).toFixed(1)}%`;

  /* ---------------------------------------------------------------- cloud sync (Supabase) merge – pure, last write wins per list
     local  = { lists: [list], tombs: { id: deletedAtISO } }   (tombstone = list deleted on this device)
     rows   = [{ id, data, updated_at, deleted }]               (the account's rows from /rest/v1/lists)
     known  = { id: updated_at }                                (what the server is known to hold, per id) */
  function syncTime(s) {
    if (s === null || s === undefined || s === "") return null;
    const m = String(s).trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1").replace(/([+-]\d\d)$/, "$1:00");
    const t = Date.parse(m); return isNaN(t) ? null : t;
  }
  /* ids whose local state (edit or deletion) is newer than what the server holds -> need pushing */
  function pendingPush(local, known) {
    known = known || {}; const out = [];
    const newer = (id, iso) => { const lt = syncTime(iso) || 0, k = syncTime(known[id]); return k === null || lt > k; };
    for (const l of local.lists || []) if (newer(l.id, l.updated)) out.push(l.id);
    for (const [id, iso] of Object.entries(local.tombs || {})) if (!(local.lists || []).some((l) => l.id === id) && newer(id, iso)) out.push(id);
    return out;
  }
  /* row to upsert for one id (live list or tombstone) */
  function syncRow(local, id, userId) {
    const l = (local.lists || []).find((x) => x.id === id);
    const r = l ? { id, data: l, updated_at: l.updated, deleted: false } : { id, data: null, updated_at: (local.tombs || {})[id], deleted: true };
    if (userId) r.user_id = userId;
    return r;
  }
  function mergeLists(local, rows) {
    const lists = new Map((local.lists || []).map((l) => [l.id, l]));
    const tombs = { ...(local.tombs || {}) };
    const known = {}; let changed = false; const added = [], replaced = [], removed = [];
    for (const r of rows || []) {
      if (!r || !r.id) continue;
      known[r.id] = r.updated_at;
      const l = lists.get(r.id), t = tombs[r.id];
      const rt = syncTime(r.updated_at) || 0;
      const lt = l ? (syncTime(l.updated) || 0) : t ? (syncTime(t) || 0) : null;
      const adopt = () => ({ ...r.data, id: r.id, updated: r.updated_at });
      if (lt === null) {                                   // only on the server
        if (!r.deleted && r.data) { lists.set(r.id, adopt()); added.push(r.id); changed = true; }
        continue;
      }
      if (rt > lt || (rt === lt && r.deleted && l)) {      // server copy is newer (deletion wins a tie)
        if (r.deleted) { if (l) { lists.delete(r.id); removed.push(r.id); changed = true; } delete tombs[r.id]; }
        else if (r.data) { lists.set(r.id, adopt()); delete tombs[r.id]; (l ? replaced : added).push(r.id); changed = true; }
      } else if (rt === lt && r.deleted && !l) delete tombs[r.id];   // our deletion already on the server
    }
    const merged = { lists: [...lists.values()], tombs };
    return { ...merged, known, changed, added, replaced, removed, push: pendingPush(merged, known) };
  }

  return { syncTime, pendingPush, syncRow, mergeLists, attachText, unitAllowed, attachKind, canAttach, attachTargets, enhRestriction, enhEligible, enhancementChoices, groupOf, findUnit, loadoutSummary, fmtLocal, loModel, hasLoadout, getLoadout, setModelCount, loadoutIssues, loadoutWargear, linkedWargear, loadoutLines, loadoutText, defaultCounts, effMin, loN, slotRange, typeMax, optMax, sortRows, metaFaction, metaDetachment, metaRanges, metaHasRtt, metaView, metaDetail, fmtPct, ROLE_ORDER, norm, uid, indexData, getFaction, getSize, tierFor, modelOptions, pickModelOption, addonOptions, defaultModels,
    minCost, unitLimit, isCharacter, isEpicHero, isBattleline, isTransport, newList, newEntry, calcList, searchUnits,
    diffData, diffLists, costSummary, listToText, exportLists, importLists, duplicateList,
    EXPORT_FORMATS, exportText, exportYellowscribe, exportYellowscribeRosz, ysResolveGear, zipStore, crc32, discordBlocks, toMarkdown, b64urlEncode, b64urlDecode, shareableList, listFromShareable };
});
