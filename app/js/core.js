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
    // every faction keyword / faction name in the data (stratagem targets naming another faction's keyword)
    const fall = new Set();
    for (const f of data.factions || []) { fall.add(stNorm(f.name)); for (const u of f.units) if (u.fk) fall.add(stNorm(u.fk)); }
    for (const k in factions) Object.defineProperty(factions[k], "_fall", { value: fall, enumerable: false });
    // datasheet keywords per faction: a stratagem target keyword that only other factions' datasheets carry (e.g. the
    // Deathwatch KILL TEAM in a Space Wolves Deathwatch Support detachment) is not "granted by rules" here
    const kwOf = (f) => { const s = new Set(); for (const u of f.units) for (const x of u.kw || []) s.add(stNorm(x)); return s; };
    const own = {}, kwall = new Set();
    for (const f of data.factions || []) { own[f.id] = kwOf(f); for (const x of own[f.id]) kwall.add(x); }
    for (const k in factions) {
      const mine = own[k], other = new Set([...kwall].filter((x) => !mine.has(x)));
      Object.defineProperty(factions[k], "_kwother", { value: other, enumerable: false });
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
  /* detachment rules that swap an allied rule (Reaper's Wager: "You can include HARLEQUINS units in your army ...
     Incursion: Up to 500 pts / Strike Force: Up to 1000 pts / Onslaught: Up to 1500 pts ... you cannot use the Corsairs
     and Travelling Players army rule") -> [{kw, caps, swap, label, text, nw}] */
  const _detAlly = new Map();
  function detAllyRules(d) {
    if (!d) return null;
    if (_detAlly.has(d)) return _detAlly.get(d);
    const t = stripMd((d.rule || []).join("\n")); let r = null;
    const m = t.match(/You can include ([A-Z][A-Z' -]*?) units in your army[^\n]*\n?[^]*?Incursion:\s*Up to (\d+)[^]*?Strike Force:\s*Up to (\d+)[^]*?Onslaught:\s*Up to (\d+)/);
    if (m) {
      const sw = (t.match(/you cannot use the ([^.]*?) army rule/i) || [])[1] || null;
      const nw = new RegExp(`No ${m[1]} models? from your army can be your WARLORD`, "i").test(t);
      r = { kw: kwNorm(m[1]), caps: { incursion: +m[2], strikeforce: +m[3], onslaught: +m[4] }, swap: sw, label: `${m[1].charAt(0) + m[1].slice(1).toLowerCase()} (${d.n})`,
        text: `${d.n}: you can include ${m[1]} units in your army. Combined points: Incursion up to ${m[2]}, Strike Force up to ${m[3]}, Onslaught up to ${m[4]}.${nw ? ` No ${m[1]} model can be your WARLORD.` : ""}${sw ? ` You cannot use the ${sw} army rule.` : ""}`, nw: nw ? 1 : 0 };
    }
    _detAlly.set(d, r);
    return r;
  }
  const allyKwHas = (u, kw) => [u.fk, ...(u.kw || [])].filter(Boolean).some((k) => { const x = kwNorm(k); return x === kw || x === kw.replace(/S$/, "") || x.startsWith(kw.replace(/S$/, "") + " "); });
  /* the unit as seen by a list: an allied unit whose rule a detachment replaces gets that detachment's rule, or is
     blocked (blk) when the detachment switches the allied rule off and the unit lacks the detachment's keyword */
  function allyView(u, list, idx) {
    if (!u || !u.ally || !list || !(list.dets || []).length) return u;
    const F = idx && idx.factions ? getFaction(idx, list) : idx; if (!F || !F.dets) return u;
    for (const dn of list.dets) {
      const r = detAllyRules(F.dets[dn]); if (!r) continue;
      if (allyKwHas(u, r.kw)) return Object.assign({}, u, { ally: { label: r.label, caps: r.caps, text: r.text, nw: r.nw } });
      if (r.swap && norm(u.ally.label) === norm(r.swap)) return Object.assign({}, u, { blk: `${dn}: you cannot use the ${r.swap} army rule (only ${r.kw} units can be included)` });
    }
    return u;
  }
  function unitAllowed(u, list) {
    if (u && u.blk) return { ok: false, reason: u.blk };
    if (!u || !u.req || !u.req.length) return { ok: true, reason: "" };
    const ok = u.req.some((d) => (list.dets || []).includes(d));
    return { ok, reason: ok ? "" : `Only with the ${u.req.join(" or ")} detachment` };
  }

  /* ---------------------------------------------------------------- leaders / support attachment */
  const unitKey = (n) => norm(String(n || "").replace(/\s*\[Legends\]\s*$/i, ""));
  /* "leader" | "support" | null: can `who` be attached to a `body` unit (MFM Leader / Support lists) */
  function attachKind(who, body, grant) {
    if (!who || !body) return null;
    const k = unitKey(body.n);
    // retinue units that JOIN another unit (Loyal Protector, Attachés, Servitor Retinue, Court of the Archon)
    if (who.jn && (who.jn === "*" ? unitKey(body.n) !== unitKey(who.n) && !body.jn : who.jn.some((x) => unitKey(x) === k))) return "join";
    if ((who.ldr || []).some((x) => unitKey(x) === k)) return "leader";
    if ((who.sup || []).some((x) => unitKey(x) === k)) return "support";
    // an enhancement that lets the bearer join extra units (MFM 'LEADER:' / 'SUPPORT:' line under the enhancement)
    if (grant && (grant.u || []).some((x) => unitKey(x) === k)) return grant.k === "support" ? "support" : "leader";
    return null;
  }
  /* the attach grant of the enhancement an entry carries ({k, u}) or null */
  function enhAttach(F, e) {
    if (!F || !e || !e.enh) return null;
    const d = F.dets && F.dets[e.enh.det]; const en = d && d.enh.find((x) => x[0] === e.enh.name);
    return (en && en[4]) || null;
  }
  const _hasKw = (u, w) => { const k = norm(w); return norm(u.n) === k || (u.kw || []).some((x) => norm(x) === k) || norm(u.n).includes(k) && /squad$/i.test(w); };
  /* is this set of Leaders on one bodyguard legal? (one Leader; or two where a datasheet allows it) */
  function leadersOk(body, leaders, models) {
    if (leaders.length <= 1) return true;
    if (leaders.length > 2) return false;
    const [a, b] = leaders; const dup = unitKey(a.n) === unitKey(b.n);
    const ml = body && body.ml;
    if (ml && leaders.length <= ml.n && !(ml.nodup && dup) && !(ml.ss && (models || 0) < ml.ss) &&
        !(ml.max1 && leaders.filter((x) => _hasKw(x, ml.max1)).length > 1)) return true;
    const pairOk = (x, y) => x.xl && !(x.xl.nodup && dup) && !dup && (x.xl.with === "any" || (x.xl.with || []).some((w) => _hasKw(y, w)));
    return pairOk(a, b) || pairOk(b, a);
  }
  const canAttach = (u) => !!(u && ((u.ldr && u.ldr.length) || (u.sup && u.sup.length) || u.jn));
  /* bodyguard units in the list `entry` could join, with free/occupied state (one Leader + one Support each) */
  function attachTargets(list, idx, uid) {
    const F = getFaction(idx, list); if (!F) return [];
    const me = list.entries.find((e) => e.uid === uid); const mu = me && findUnit(F, me.unit);
    const grant = enhAttach(F, me);
    if (!mu || !(canAttach(mu) || grant)) return [];
    const out = [];
    for (const e of list.entries) {
      if (e.uid === uid || (e.attach && !mu.jn)) continue;
      const bu = findUnit(F, e.unit); const kind = attachKind(mu, bu, grant);
      if (!kind) continue;
      if (kind === "join") {   // one unit of each retinue group per target; jl: target must be led by that unit
        if (mu.jl && !list.entries.some((x) => x.attach === e.uid && unitKey(x.unit) === unitKey(mu.jl))) continue;
        const by = list.entries.filter((x) => x.uid !== uid && x.attach === e.uid && (findUnit(F, x.unit) || {}).jg === mu.jg);
        out.push({ entry: e, unit: bu, kind, taken: by.length > 0, extra: false, by: by.map((x) => x.unit) }); continue;
      }
      const othersE = list.entries.filter((x) => x.uid !== uid && x.attach === e.uid && attachKind(findUnit(F, x.unit), bu, enhAttach(F, x)) === kind);
      const others = othersE.map((x) => findUnit(F, x.unit)).filter(Boolean);
      const taken = kind === "leader" ? !leadersOk(bu, others.concat([mu]), e.models) : others.length > 0;
      // Pactbound Zealots: a CHARACTER can only be attached to a unit with the same mark
      let markBad = null;
      if (markRuleActive(list, F)) { const a = unitMark(list, F, mu, me), b = unitMark(list, F, bu, e); if (a && b && a !== b) markBad = `${a} vs ${b}`; }
      out.push({ entry: e, unit: bu, kind, taken, markBad, extra: kind === "leader" && others.length > 0 && !taken, by: othersE.map((x) => x.unit) });
    }
    return out;
  }

  /* allied unit-count rules (Assigned Agents: per-category caps by battle size; Freeblades/Dreadblades: 1 Titanic OR up to 3 Armigers) */
  const allyCatHas = (u, ct) => (ct.units || []).includes(u.n) || (ct.kw && (u.kw || []).some((k) => norm(k) === norm(ct.kw)));
  const allyCatMax = (ct, size) => (ct.caps ? (size ? ct.caps[size.id] : null) : ct.max);
  function allyCountIssues(a, size) {
    const uc = a.al.uc; if (!uc) return [];
    const out = [];
    uc.cats.forEach((ct, i) => { const n = a.n[i] || 0, mx = allyCatMax(ct, size); if (mx != null && n > mx) out.push(`${n} / ${mx} ${ct.name} units`); });
    if (uc.xor && uc.cats.filter((ct, i) => a.n[i] > 0).length > 1) out.push(`either ${uc.cats.map((ct) => `${ct.max} ${ct.name}`).join(" or up to ")} - not both`);
    return out;
  }
  /* Daemonic Pact: per god keyword, non-BATTLELINE units included this way <= BATTLELINE units with that keyword */
  const allyKw = (u, k) => (u.kw || []).some((x) => norm(x) === norm(k));
  function allyGodCounts(al, us) {
    const out = {};
    for (const g of al.gr || []) {
      const w = (us || []).filter((u) => allyKw(u, g));
      out[g] = { bl: w.filter((u) => allyKw(u, "Battleline")).length, nbl: w.filter((u) => !allyKw(u, "Battleline")).length };
    }
    return out;
  }
  function allyRatioIssues(a) {
    if (!a.al.gr) return [];
    return Object.entries(allyGodCounts(a.al, a.us)).filter(([, c]) => c.nbl > c.bl)
      .map(([g, c]) => `${c.nbl} non-Battleline ${g.toUpperCase()} unit${c.nbl === 1 ? "" : "s"} but only ${c.bl} ${g.toUpperCase()} BATTLELINE unit${c.bl === 1 ? "" : "s"} – each non-BATTLELINE ${g.toUpperCase()} unit needs a BATTLELINE ${g.toUpperCase()} unit`);
  }
  /* would adding one more `u` (costing `cost`) break its allied rule's points cap or god ratio? (ally picker greying) */
  function allyAddCheck(u, allies, size, cost) {
    if (!u || !u.ally) return { ok: true, reason: "" };
    const al = u.ally, A = (allies && allies[al.label]) || { pts: 0, us: [] };
    const cap = size && al.caps ? al.caps[size.id] : null;
    if (cap != null && A.pts + (cost || 0) > cap) return { ok: false, reason: `Would exceed the ${al.label} cap (${A.pts} + ${cost} > ${cap} pts)` };
    if (al.gr && !allyKw(u, "Battleline")) {
      // gods it can have: its keywords, or any of its datasheet 'Allegiance' choices (Daemon Prince of Chaos, Furies, Chaos Spawn)
      const lo = u.lo || {}, alg = (lo.u || []).concat(...(lo.m || []).map((m) => m[4] || [])).filter((sl) => /^(Allegiance|Mark of Chaos)$/i.test(sl[0]));
      const cands = alg.length ? alg[0][1].map((o) => o[0]).filter((g) => al.gr.includes(g)) : al.gr.filter((g) => allyKw(u, g));
      const room = (g) => { const c = allyGodCounts(al, (A.us || []).concat([Object.assign({}, u, { kw: (u.kw || []).concat([g]) })]))[g]; return c.nbl <= c.bl; };
      if (cands.length && !cands.some(room)) {
        const c = allyGodCounts(al, A.us || []), g = cands.length === 1 ? cands[0] : null;
        return { ok: false, reason: g ? `Add a ${g.toUpperCase()} BATTLELINE unit first (${al.label}: ${c[g].bl} Battleline, ${c[g].nbl} non-Battleline ${g})`
          : `Add a BATTLELINE unit of its god first (${al.label}: each non-BATTLELINE ${cands.join("/").toUpperCase()} unit needs a BATTLELINE unit with that keyword)` };
      }
    }
    return { ok: true, reason: "" };
  }
  /* "1/2 Retinue · 0/2 Character" style summary of an allied rule's caps */
  function allyCapText(al, A, size) {
    if (!al.uc) return null;
    return al.uc.cats.map((ct, i) => `${(A && A.n[i]) || 0}/${allyCatMax(ct, size) ?? "?"} ${ct.name}`).join(al.uc.xor ? " or " : " · ");
  }

  /* ---------------------------------------------------------------- enhancement eligibility */
  const stripMd = (t) => String(t || "").replace(/\^\^|\*\*|__/g, "").replace(/[’‘]/g, "'").replace(/\u00a0/g, " ");
  const kwNorm = (t) => String(t || "").toUpperCase().replace(/[’‘]/g, "'").replace(/[^A-Z0-9' -]/g, " ").replace(/\s+/g, " ").trim();
  const _enhRx = new Map();
  /* parse "WORLD EATERS INFANTRY model only (excluding EPIC HERO units)." -> {alts:[...], excl:[...], text} */
  /* copies of an Upgrade an army may include: 3 (core rules 25.03), 1 when the name/text says "one per army" */
  function upgradeMax(en) { return /\bone per army\b/i.test(`${en[0]} ${String(en[2] || "").slice(0, 160)}`) ? 1 : 3; }
  function enhRestriction(en) {
    const key = en[0] + "|" + (en[2] || "");
    if (_enhRx.has(key)) return _enhRx.get(key);
    let res = null;
    const t = stripMd(en[2]);
    const m = t.match(/(?:^|[.!?:]\s+|\n)\s*([A-Za-z][^.!?\n:]*?)\s+(?:models?|units?)\s+only\b\s*(?:\(\s*excluding\s+([^)]*)\))?/i);
    if (m) {
      const alts = m[1].split(/\s*,\s*|\s*\/\s*|\s+or\s+|\s+and\/or\s+/i).map((x) => kwNorm(x.replace(/^(friendly\s+)?(a|an|the)\s+/i, "").replace(/^friendly\s+/i, ""))).filter(Boolean);
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
    const s = new Set([...(u.kw || []), u.n, u.fk || (F && F.mainFk) || "", F && !u.grp && !u.req && !u.ally ? F.f.name : ""].filter(Boolean).map(kwNorm));
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
  /* datasheet abilities per unit (core + unit abilities), registered by the app once datasheets are loaded:
     'HERETIC ASTARTES model with the Deep Strike ability only' (Warpstrike Champions) needs them */
  let _unitAb = null, _unitDs = null;
  function setUnitAbilities(ds) {
    _unitAb = new Map(); _unitDs = new Map();
    for (const [fid, f] of Object.entries((ds && ds.factions) || {})) for (const [n, d] of Object.entries(f.units || {})) _unitDs.set(fid + "|" + n, d);
    for (const [fid, f] of Object.entries((ds && ds.factions) || {})) for (const [n, d] of Object.entries(f.units || {}))
      _unitAb.set(fid + "|" + n, new Set([...(d.cr || []), ...(d.ab || []).map((a) => a[0])].map((x) => norm(String(x).replace(/\s*\(aura\)/i, "")))));
  }
  function abilityGate(u, en, F) {
    const a = (stripMd(en[2] || "").match(/\bwith the ([A-Z][\w'’ -]*?) ability only\b/) || [])[1];
    if (!a || !_unitAb || !F) return null;
    const have = _unitAb.get(F.f.id + "|" + u.n); if (!have) return null;   // no datasheet: unknown, allowed
    return [...have].some((x) => x === norm(a) || x.startsWith(norm(a))) ? null : `${a} ability only (this unit's datasheet has no ${a}).`;
  }
  const _detGr = new Map();
  function detGrants(d) {
    if (!d) return [];
    if (_detGr.has(d)) return _detGr.get(d);
    const out = []; const t = stripMd((d.rule || []).join("\n"));
    for (const m of t.matchAll(/Friendly ([A-Z][A-Z0-9' \/-]*?) units have ([A-Z][A-Z' -]*?[A-Z])\.(?=\s|$)/g))
      out.push({ kw: kwNorm(m[2]), alts: m[1].split(/\s*\/\s*/).map(kwNorm).filter(Boolean) });
    _detGr.set(d, out); return out;
  }
  function enhEligible(u, en, F) {
    if (!u) return { ok: false, reason: "" };
    const gate = abilityGate(u, en, F);
    if (gate) return { ok: false, reason: gate };
    if (u.ally && u.ally.ne) return { ok: false, reason: `${u.ally.label} units cannot be given Enhancements` };
    const baseOf = (x) => isEpicHero(x) ? "Epic Heroes cannot take enhancements" : !en[3] && !isCharacter(x) ? "Characters only" : "";
    const base = baseOf(u);
    const r = enhRestriction(en);
    if (!r) return base ? { ok: false, reason: base } : { ok: true, reason: "" };
    if (!F.mainFk) { const c = {}; for (const x of F.f.units) if (x.fk && !x.grp) c[x.fk] = (c[x.fk] || 0) + 1; F.mainFk = Object.keys(c).sort((a, b) => c[b] - c[a])[0] || ""; }
    // keywords the enhancement's own detachment gives ("Friendly FOETID BLOAT-DRONE/.../MYPHITIC BLIGHT-HAULER units have
    // CONTAGION ENGINE" -> Parasitic Woe-reaper's "CONTAGION ENGINE unit only")
    const grants = detGrants(Object.values(F.dets || {}).find((d) => (d.enh || []).includes(en)));
    const vocab = grants.length ? new Set([...factionVocab(F), ...grants.map((g) => g.kw)]) : factionVocab(F);
    if (r.alts.some((a) => !coveredBy(a, vocab))) return base ? { ok: false, reason: base } : { ok: true, reason: "" };   // wording we can't map -> only the base rules
    const kwsOf = (x) => { const k = unitKwSet(x, F); for (const g of grants) if (g.alts.some((a) => coveredBy(a, k))) k.add(g.kw); return k; };
    const matches = (x) => { const k = kwsOf(x); return !r.excl.some((e) => coveredBy(e, k)) && r.alts.some((a) => coveredBy(a, k)); };
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
    const u = allyView(findUnit(F, e.unit), list, F); if (!u) return [];
    const dets = (list.dets || []).map((n) => F.dets[n]).filter(Boolean);
    const c = calcList(list, idx);
    const used = {}; for (const x of list.entries) if (x.uid !== uid && x.enh) used[x.enh.name] = (used[x.enh.name] || 0) + 1;
    const g = groupOf(list, e);
    const groupHas = list.entries.find((x) => x.uid !== uid && x.enh && groupOf(list, x) === g);
    // count the army would have with `en` on this entry (11e 25.03: every Character enhancement counts 1; each
    // different Upgrade counts 1 however many units (max 3) take it, so a 2nd/3rd copy of a taken Upgrade is free)
    const upg = {}; for (const x of list.entries) if (x.uid !== uid && x.enh) { const xd = F.dets[x.enh.det]; const xe = xd && xd.enh.find((y) => y[0] === x.enh.name); upg[x.enh.name] = !!(xe && xe[3]); }
    const countWith = (name, isUp) => { const m = { ...used }; if (name) m[name] = (m[name] || 0) + 1; const up = { ...upg }; if (name) up[name] = isUp;
      return Object.entries(m).reduce((n, [k, v]) => n + (up[k] ? 1 : v), 0); };
    return dets.flatMap((d) => d.enh.map((en) => {
      const el = enhEligible(u, en, F);
      let ok = el.ok, reason = el.reason, taken = false;
      if (ok && !en[3] && used[en[0]]) { ok = false; taken = true; reason = `Already taken by ${list.entries.find((x) => x.uid !== uid && x.enh && x.enh.name === en[0]).unit}`; }
      else if (ok && en[3] && used[en[0]] >= upgradeMax(en)) { ok = false; taken = true; reason = upgradeMax(en) === 1 ? "Already taken (one per army)" : "Already taken by 3 units (an Upgrade can be taken up to 3 times)"; }
      if (ok && groupHas) { ok = false; reason = `${groupHas.unit} in the same attached unit already has ${groupHas.enh.name} (one enhancement per unit)`; }
      if (ok && c.enhLimit != null && !(e.enh && e.enh.name === en[0]) && countWith(en[0], !!en[3]) > c.enhLimit)
        { ok = false; reason = `Enhancement limit reached (${countWith(null)}/${c.enhLimit}): each Character enhancement counts 1, each different Upgrade counts 1 (up to 3 units can share it)`; }
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
    if (_lom.has(u.lo)) return _lom.get(u.lo);   // keyed on the data itself: refreshed data -> recomputed model
    const slot = (s) => ({ name: s[0], opts: s[1].map((o) => ({ name: o[0], max: o[1], text: o[2], w: o[3], mas: o[4], wn: o[5] || 1 })),
      defaults: s[2] || [], minT: s[3], maxT: s[4], optional: !!s[5] });
    const M = { types: u.lo.m.map((m) => ({ name: m[0], min: m[1] || 0, max: m[2], fixed: m[3] || [], slots: (m[4] || []).map(slot),
      up: m[5] || null, mas: m[6] || null, addOn: !!m[7] })), unit: (u.lo.u || []).map(slot), mn: u.lo.mn, mx: u.lo.mx };
    _lom.set(u.lo, M); return M;
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
  function slotRange(s, k, N) {
    const perMin = s.minT !== null && s.minT !== undefined ? s.minT : (s.optional ? 0 : 1);
    const perMax = s.maxT !== null && s.maxT !== undefined ? s.maxT : Math.max(1, perMin);
    // options whose limit scales with unit size ("For every 3 models ... 1 Plasmacyte"): the slot can't hold more than they allow
    if (N != null && s.opts.some((o) => o.mas)) { const cap = s.opts.reduce((t, o) => t + optMax(o, N, s, k), 0); return [Math.min(k * perMin, cap), Math.min(k * perMax, cap)]; }
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
  /* map a loadout gear name ("Two excruciator cannons", "Bolt pistol and chainsword", "2x Plasma gun") to datasheet
     weapon names with counts: [[weaponName, n], ...]; [] when nothing matches (non-weapon wargear) */
  const NUMW = { one: 1, a: 1, an: 1, two: 2, pair: 2, paired: 0, twin: 0, three: 3, four: 4, five: 5, six: 6 };
  const sing = (x) => x.replace(/(ies)$/, "y").replace(/(ches|shes|sses|xes)$/, (m) => m.slice(0, -2)).replace(/([^s])s$/, "$1");
  const GEAR_ALIAS = { "gun drone": "Twin pulse carbine", "missile drone": "Missile pod", "black knight combat weapon": "Corvus Hammers", "wolf guard headtaker w/ paired weapons": "Paired Master-crafted Power Weapons", "wolf guard headtaker w/ storm shield": "Master-crafted Power Weapon" };
  const gnorm = (t) => norm(String(t).toLowerCase().replace(/-linked/g, "").replace(/is(er|ers)\b/g, "iz$1"));
  function gearWeapons(name, wpNames) {
    const al = GEAR_ALIAS[String(name).toLowerCase()]; if (al && (wpNames || []).includes(al)) return [[al, 1]];
    const W = (wpNames || []).map((w) => [w, gnorm(w), gnorm(sing(String(w).toLowerCase()))]);
    const exact = (t) => { const n = gnorm(t), sn = gnorm(sing(t.toLowerCase())); const hit = W.find((w) => w[1] === n) || W.find((w) => w[2] === sn || w[1] === sn || w[2] === n); return hit && hit[0]; };
    const whole = exact(String(name)); if (whole) return [[whole, 1]];
    const out = [];
    for (let part of String(name).split(/\s*(?:\+|,|&|\band\b|\bwith\b|\bw\/)\s*/i)) {
      part = part.trim(); if (!part) continue;
      let n = 1; const m = part.match(/^(\d+)\s*[x×]?\s+(.*)$/i) || part.match(/^(one|a|an|two|three|four|five|six|pair of)\s+(.*)$/i);
      if (m) { n = /^\d/.test(m[1]) ? +m[1] : m[1].toLowerCase() === "pair of" ? 2 : NUMW[m[1].toLowerCase()]; part = m[2]; }
      let hit = exact(part);
      if (!hit) {
        // partial name: a profile that starts with the part beats a longer one that merely contains it
        // ('Axe and flail': 'Axe' -> Axe of Khorne, not Great axe of Khorne; 'flail' -> Bloodflail)
        const np = gnorm(sing(part.toLowerCase()));
        const c = W.filter((w) => w[2].length > 3 && (np.includes(w[2]) || w[2].includes(np)))
          .sort((a, b) => (b[2].startsWith(np) - a[2].startsWith(np)) || (b[2].length - a[2].length));
        hit = c[0] && c[0][0];
      }
      if (hit) out.push([hit, n]);
    }
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
    const g = line.gear.map((x) => (line.count > 1 && x.count !== line.count) || (line.count <= 1 && x.count > 1) ? `${x.count}x ${x.name}` : x.name).join(", ");
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
      if (d.src === "gs") warn(`${d.n} is not in the current Munitorum Field Manual`);
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
    let warlords = 0; const allySum = {};
    for (const e of list.entries) {
      const u = allyView(F.units[e.unit] || findUnit(F, e.unit), list, F);
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
          enhUse[k] = enhUse[k] || { n: 0, upgrade, max: upgradeMax(en) };
          enhUse[k].n += 1;
        }
      }
      if (e.warlord) {
        if (!isCharacter(u)) err(`${u.n} cannot be the Warlord (not a Character)`, e.uid);
        if (u.ally && u.ally.nw) err(`${u.n} cannot be the Warlord (${u.ally.label})`, e.uid);
        if (u.wr && !u.wr.some((d) => (list.dets || []).includes(d))) err(`${u.n} cannot be the Warlord (only with the ${u.wr.join(" or ")} detachment)`, e.uid);
        warlords += 1;
      }
      if (u.ally) { const A = allySum[u.ally.label] = allySum[u.ally.label] || { pts: 0, al: u.ally, n: [], units: 0, us: [] }; A.pts += row.base + row.wargear + row.addons + row.enh; A.units++;
        // a god picked on the datasheet (Daemon Prince of Chaos 'Allegiance') gives that keyword for the Daemonic Pact ratio
        const gk = row.lo ? Object.entries(row.lo.p || {}).filter(([k]) => /\|(Allegiance|Mark of Chaos)$/i.test(k)).flatMap(([, o]) => Object.keys(o).filter((x) => o[x] > 0)) : [];
        A.us.push(gk.length ? Object.assign({}, u, { kw: (u.kw || []).concat(gk) }) : u);
        if (u.ally.uc) u.ally.uc.cats.forEach((ct, i) => { if (allyCatHas(u, ct)) A.n[i] = (A.n[i] || 0) + 1; }); }
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
        const kind = attachKind(r.unit, t.unit, enhAttach(F, e));
        if (t.entry.attach && kind !== "join") { err(`${r.unit.n} cannot join ${t.unit.n}: that unit is itself attached to another unit`, e.uid); continue; }
        if (!kind) { warn(`${r.unit.n} cannot be attached to ${t.unit.n} (not in its Leader/Support list)`, e.uid); continue; }
        r.attachedTo = t; r.attachKind = kind; (t.attached = t.attached || []).push(r);
        const k = t.uid + "|" + kind + (kind === "join" ? "|" + r.unit.jg : ""); (slots[k] = slots[k] || []).push(r);
      } else if (r.unit.jm) {
        err(`${r.unit.n} must join a ${r.unit.jn === "*" ? "unit" : r.unit.jn.map((x) => x.replace(/\w\S*/g, (w) => w[0] + w.slice(1).toLowerCase())).join(" / ")} from your army`, e.uid);
      } else if (r.unit.sup && r.unit.sup.length && !(r.unit.ldr && r.unit.ldr.length)) {
        warn(`${r.unit.n} is a Support unit and must be attached to a bodyguard unit`, e.uid);
      }
    }
    for (const r of res.entries) if (r.attachKind === "join" && r.unit.jl && !(r.attachedTo.attached || []).some((x) => x.attachKind !== "join" && unitKey(x.unit.n) === unitKey(r.unit.jl)))
      err(`${r.unit.n} can only join a unit that is being led by a ${r.unit.jl}`, r.uid);
    for (const [k, rs] of Object.entries(slots)) if (rs.length > 1) {
      const t = byUid[k.split("|")[0]];
      if (rs[0].attachKind === "join") { err(`${t.unit.n} cannot have more than one ${rs[0].unit.jg} unit joined to it (${rs.map((x) => x.unit.n).join(", ")})`, t.uid); continue; }
      if (rs[0].attachKind === "leader" && leadersOk(t.unit, rs.map((x) => x.unit), t.entry.models)) continue;
      err(`${t.unit.n} has ${rs.length} ${rs[0].attachKind === "leader" ? "Leaders" : "Support units"} attached (${rs.map((x) => x.unit.n).join(", ")}) - max 1`, t.uid);
    }
    // Marks of Chaos (Pactbound Zealots): every eligible unit needs one; attached units must share it
    if (markRuleActive(list, F)) {
      const markOf = (r) => unitMark(list, F, r.unit, r.entry, r.lo);
      for (const r of res.entries) {
        if (!r.unit) continue; const ch = markChoices(list, F, r.unit);
        if (ch && !ch.includes(r.entry.mark)) err(`${r.unit.n}: select a Mark of Chaos (Pactbound Zealots – Marks of Chaos)`, r.uid);
        if (r.attachedTo && r.attachedTo.unit) { const a = markOf(r), b = markOf(r.attachedTo); if (a && b && a !== b) err(`${r.unit.n} (${a}) cannot join ${r.attachedTo.unit.n} (${b}): attached units must share the same Mark of Chaos`, r.uid); }
      }
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
      if (!v.upgrade && v.n > 1) err(`${k} taken ${v.n} times (an enhancement can be taken only once per army)`);
      if (v.upgrade && v.n > v.max) err(v.max === 1 ? `${k} taken ${v.n} times (one per army)` : `${k} taken ${v.n} times (an Upgrade can be given to at most 3 units)`);
      res.enhCount += v.upgrade ? 1 : v.n;
      if (v.upgrade) res.upgCount = (res.upgCount || 0) + v.n; else res.charEnh = (res.charEnh || 0) + v.n;
    }
    if (res.enhLimit != null && res.enhCount > res.enhLimit) {
      const nUp = Object.values(enhUse).filter((v) => v.upgrade).length;
      err(`Enhancements: ${res.enhCount} / ${res.enhLimit} – ${res.charEnh || 0} Character enhancement${res.charEnh === 1 ? "" : "s"} (1 each)` +
        (nUp ? ` + ${nUp} different Upgrade${nUp === 1 ? "" : "s"} on ${res.upgCount} unit${res.upgCount === 1 ? "" : "s"} (each different Upgrade counts 1; up to 3 units can share one)` : ""));
    }
    for (const [lab, a] of Object.entries(allySum)) {
      const cap = size && a.al.caps ? a.al.caps[size.id] : null;
      if (cap != null && a.pts > cap) err(`${lab}: ${a.pts} / ${cap} pts of allied units`);
      for (const m of allyCountIssues(a, size)) err(`${lab}: ${m}`);
      for (const m of allyRatioIssues(a)) err(`${lab}: ${m}`);
      if (a.al.rk) { const opp = norm(a.al.rk) === "imperium" ? "chaos" : "imperium";   // own-faction keyword data is patchy: only flag allied copies or units of the other allegiance
        const bad = res.entries.find((r) => r.unit && !(r.unit.kw || []).some((k) => norm(k) === norm(a.al.rk)) && (r.unit.af || (r.unit.kw || []).some((k) => norm(k) === opp)));
        if (bad) err(`${lab}: every model in your army must have the ${a.al.rk.toUpperCase()} keyword (${bad.unit.n} does not)`, bad.uid); }
    }
    res.allies = allySum;
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
        if (ledText(row)) L.push(`  • ${ledText(row)}`);
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
    for (const r of c.entries) { const ch = F && markChoices(list, F, r.unit); r.markTxt = ch && ch.includes(r.entry.mark) ? `Mark of Chaos: ${r.entry.mark}` : ""; }   // Daemon Prince marks are in its loadout line
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
    if (r.markTxt) out.push(r.markTxt);
    return out;
  }
  /* "Attached to: Khorne Berzerkers" (+ "#2" when the list has several units of that name) */
  function attachText(r, c) {
    const t = r.attachedTo; if (!t) return "";
    const same = c.entries.filter((x) => x.name === t.name).length;
    return `Attached to: ${t.name}${same > 1 ? ` #${t.copy}` : ""}${r.attachKind === "support" ? " (support)" : r.attachKind === "join" ? " (joined)" : ""}`;
  }
  /* bodyguard side of an attachment: "Led by: Shield-Captain + Blade Champion" */
  function ledText(r) {
    const a = (r.attached || []); if (!a.length) return "";
    return `Led by: ${a.map((x) => x.name + (x.attachKind === "support" ? " (support)" : "")).join(" + ")}`;
  }
  /* optional appendix: detachment rules + stratagems of the selected detachments */
  function rulesAppendix(X) {
    const one = (x) => String(x || "").replace(/\*\*|\^\^/g, "").replace(/\s*\n+\s*/g, " ").trim();
    const L = ["", "DETACHMENT RULES & STRATAGEMS"];
    // one line per entry, a blank line between entries
    for (const d of X.dets) L.push(`Detachment rule (${d.n}) – ${d.rule && d.rule[0] ? `${d.rule[0]}: ${one(d.rule[1])}` : "(no rule data available)"}`, "");
    for (const d of X.dets) for (const s of d.st) L.push(`Stratagem: ${s[0]} – ${s[1]}CP – ${one(s[5])}`, "");
    if (L[L.length - 1] === "") L.pop();
    return L;
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
    const own = (r) => !(r.unit && r.unit.af);
    const sections = [["CHARACTERS", (r) => own(r) && r.unit && isCharacter(r.unit)], ["BATTLELINE", (r) => own(r) && r.unit && !isCharacter(r.unit) && isBattleline(r.unit)],
      ["DEDICATED TRANSPORTS", (r) => own(r) && r.unit && !isCharacter(r.unit) && !isBattleline(r.unit) && isTransport(r.unit)],
      ["OTHER DATASHEETS", (r) => own(r) && (!r.unit || (!isCharacter(r.unit) && !isBattleline(r.unit) && !isTransport(r.unit)))],
      ["ALLIED UNITS", (r) => !own(r)]];
    for (const [title, pred] of sections) {
      const rs = X.rows.filter(pred).concat(title === "OTHER DATASHEETS" ? X.c.entries.filter((r) => r.missing) : []);
      if (!rs.length) continue;
      L.push(title, "");
      for (const r of rs) {
        L.push(`${r.name} (${fmtPts(r.total)} Points)`);
        if (r.entry.warlord) L.push("  • Warlord");
        if (r.attachedTo) L.push(`  • ${attachText(r, X.c)}`);
        if (ledText(r)) L.push(`  • ${ledText(r)}`);
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
      if (ledText(r)) L.push(ledText(r));
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
      if (ledText(r)) L.push(`• ${ledText(r)}`);
      for (const l of r.loLines || []) { const g = l.gear.map((x) => ((l.count > 1 && x.count !== l.count) || (l.count <= 1 && x.count > 1) ? `${x.count}x ${x.name}` : x.name)).join(", ");
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
    if (opts && opts.rules && f.id !== "stratagems") {
      const X = exportContext(list, idx);
      if (X.dets.length) { const ls = t.split("\n"); const fi = ls.findIndex((x) => /^Exported with Muster/.test(x));
        const app = rulesAppendix(X); if (fi >= 0) ls.splice(fi, 0, ...app, ""); else ls.push(...app); t = ls.join("\n"); }
    }
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
    scrubList(l);
    return l;
  }


  /* ---------------------------------------------------------------- stratagems a unit can be targeted by */
  /* Reads a stratagem's TARGET text ("One WORLD EATERS INFANTRY unit from your army that ...") and checks it against
     the unit's keywords (GrimSlate keywords + faction keyword + unit name + role). Conditions after the subject
     ("that has not been selected to fight", "within 6\"") are game-state and ignored; exclusions ("excluding X",
     "that is not X", "other than X", "non-X", "you can only select a X unit if it is a Y") are applied.
     -> { ok, any, why }: any = the target names no keyword (any unit / "That unit"). */
  const ST_KW = ["infantry", "vehicle", "monster", "mounted", "character", "epic hero", "battleline", "transport", "dedicated transport",
    "fly", "walker", "titanic", "towering", "aircraft", "psyker", "grenades", "smoke", "explosives", "daemon", "beast", "swarm",
    "fortification", "terminator", "jump pack", "leader", "imperium", "chaos"];
  const ST_STOP = new Set(["one", "two", "three", "four", "up", "to", "friendly", "unengaged", "engaged", "other", "another", "the", "a", "an",
    "your", "unit", "units", "model", "models", "that", "this", "those", "these", "each", "any", "battleshocked", "battle", "shocked",
    "selected", "destroyed", "just", "attached", "of", "same", "eligible", "visible", "more", "number", "army", "armys", "least", "at", "s", "it", "its", "by", "hit", "affected", "from", "attacks", "shot", "just"]);
  const stNorm = (x) => String(x || "").toLowerCase().replace(/[’‘]/g, "'").replace(/'s\b/g, "s").replace(/[^a-z0-9]+/g, " ").trim();
  const stSing = (w) => (/(ss|us|is)$/.test(w) ? w : w.replace(/ies$/, "y").replace(/(ch|sh|x)es$/, "$1").replace(/s$/, ""));
  function stratTargetText(s) {
    const m = /TARGET:\s*([^\n]*)/i.exec((s && s[5]) || "");
    return m ? m[1].trim() : "";
  }
  function unitKeywords(u, F) {
    const k = new Set();
    const add = (x) => { const n = stNorm(x); if (n) { k.add(n); k.add(n.split(" ").map(stSing).join(" ")); } };
    for (const x of u.kw || []) add(x);
    add(u.fk); add(u.n); add(String(u.n).replace(/\s*\[Legends\]$/i, ""));
    if (u.r === "Battleline") add("Battleline");
    if (u.r === "Character" || u.r === "Epic Hero") add("Character");
    if (u.r === "Epic Hero") add("Epic Hero");
    if (u.r === "Dedicated Transport") { add("Dedicated Transport"); add("Transport"); }
    // Space Marine chapters: units on a chapter page carry the chapter keyword (BLOOD ANGELS, SPACE WOLVES...)
    if (F && u.fk === "Adeptus Astartes" && !u.sg) add(F.f.name);
    return k;
  }
  function stratVocab(F) {
    if (F && F._stv) return F._stv;
    const v = new Set();
    const add = (x) => { const n = stNorm(x); if (n) { v.add(n); v.add(n.split(" ").map(stSing).join(" ")); } };
    ST_KW.forEach(add);
    if (F) { add(F.f.name); for (const u of F.f.units) { (u.kw || []).forEach(add); add(u.fk); add(u.n); } }
    if (F) Object.defineProperty(F, "_stv", { value: v, enumerable: false });
    return v;
  }
  /* "World Eaters Infantry" -> { kws: ["world eaters", "infantry"], unknown: [] } (longest keyword match first) */
  function kwPhrase(text, V) {
    const toks = stNorm(text).split(" ").filter(Boolean);
    const kws = [], unknown = [];
    for (let i = 0; i < toks.length;) {
      let hit = null;
      for (let n = Math.min(6, toks.length - i); n >= 1 && !hit; n--) {
        const g = toks.slice(i, i + n).join(" "), gs = toks.slice(i, i + n).map(stSing).join(" ");
        if (V.has(g)) hit = [g, n]; else if (V.has(gs)) hit = [gs, n];
      }
      if (hit) { kws.push(hit[0]); i += hit[1]; continue; }
      if (!ST_STOP.has(toks[i]) && !/^\d+(cp)?$/.test(toks[i])) unknown.push(toks[i]);
      i++;
    }
    return { kws, unknown };
  }
  const stHas = (K, k) => K.has(k) || K.has(k.split(" ").map(stSing).join(" "));
  function unitStratMatch(u, F, s) {
    const t0 = stratTargetText(s);
    if (!t0) return { ok: true, any: true, unsure: false, why: "no target text" };
    let t = t0.replace(/[’‘]/g, "'").replace(/\s+/g, " ");
    // targets that aren't one of your units (an enemy unit, an objective, a marker)
    if (/^\s*(?:that|one|the)\s+enemy\b/i.test(t) || (!/\b(?:units?|models?|warlord)\b/i.test(t) && /\b(?:markers?|objectives?)\b/i.test(t))) return { ok: false, any: false, unsure: false, why: "does not target your units", target: t0 };
    const V = stratVocab(F), K = unitKeywords(u, F), FALL = (F && F._fall) || new Set();
    const excl = [];
    // "You can only select a VEHICLE unit if it is a CHARACTER/WALKER unit."
    const only = /only select (?:an? )?([^.]*?) units? if (?:it|that unit) (?:is|has) (?:an? )?([^.]*?) units?\b/i.exec(t);
    if (only) t = t.replace(only[0], "");
    t = t.replace(/\((?:excluding|except) ([^)]*)\)/gi, (m, x) => { excl.push(x); return " "; })
      .replace(/\b(?:excluding|except(?: for)?|other than) ([^.,;()]*)/gi, (m, x) => { excl.push(x); return " "; })
      .replace(/\bthat (?:is|are) not (?:an? |part of an? )?([^.,;()]*)/gi, (m, x) => { excl.push(x); return " "; })
      .replace(/\bnon-([a-z]+(?: [a-z]+)?)/gi, (m, x) => { excl.push(x); return " "; });
    t = t.split(/\.\s/)[0];
    // several targets ("One X unit ... and up to one Y unit"): any of them may be this unit
    const clauses = t.split(/,?\s+and (?:up to |any )?(?:one|two|three)\b/i);
    const alts = [];
    for (let c of clauses) {
      if (/\benemy\b|\bobjective\b|\bmarkers?\b/i.test(c.split(/\b(?:that|which|within|from)\b/i)[0])) continue;   // the enemy / a marker, not your unit
      c = c.replace(/^\s*(?:that|those|the|this|your)\b\s*/i, "");
      const subj = c.split(/\.|;|\b(?:from your army|from your|that|which|who|whose|within|wholly|if|in|on|with|while|whilst|is|was|has|have|can|eligible|equipped|embarked)\b/i)[0];
      // "ADEPTUS ASTARTES INFANTRY/MOUNTED", "HERETIC ASTARTES PSYKER/DAEMON": a lone keyword after the first
      // alternative shares its leading keywords
      let prefix = null;
      for (const a of subj.split(/\s*(?:,|\/|\bor\b|\band\/or\b)\s*/i)) {
        const p = kwPhrase(a, V);
        if (!p.kws.length && !p.unknown.length) continue;
        if (prefix === null) prefix = p.kws.slice(0, -1);
        else if (p.kws.length === 1 && !p.unknown.length && prefix.length && !prefix.includes(p.kws[0]) && !FALL.has(p.kws[0])) p.kws = prefix.concat(p.kws);
        alts.push(p);
      }
    }
    const why = [];
    let ok = false, any = false, unsure = false;
    if (!alts.length) { ok = true; any = true; why.push("any unit"); }
    else {
      for (const a of alts) {
        let kws = a.kws, unk = a.unknown;
        if (unk.includes("warlord")) { unk = unk.filter((x) => x !== "warlord"); kws = kws.concat(["character"]); }
        if (!kws.every((k) => stHas(K, k))) continue;
        if (!unk.length) { ok = true; unsure = a.unknown.includes("warlord"); why.push(a.kws.join(" ").toUpperCase() + (unsure ? " WARLORD" : "")); break; }
        // a keyword no datasheet in this faction carries: another faction's keyword -> no; else most likely granted by
        // the detachment/army rules (TANK ACE, KILLER, SOUL FORGE...) -> shown as "check"
        const u2 = unk.join(" ");
        if (FALL.has(u2) || unk.some((x) => FALL.has(x))) continue;
        if (F && F._kwother && F._kwother.has(u2)) continue;
        ok = true; unsure = true; why.push(`${u2.toUpperCase()} (keyword from rules, check)`);
      }
    }
    if (ok) for (const x of excl) {
      for (const part of x.split(/\s*(?:,|\/|\bor\b|\band\b)\s*/i)) {
        const p = kwPhrase(part, V);
        if (p.kws.length && !p.unknown.length && p.kws.every((k) => stHas(K, k))) { ok = false; why.push(`excluded: ${p.kws.join(" ").toUpperCase()}`); break; }
      }
      if (!ok) break;
    }
    if (ok && only) {
      const a = kwPhrase(only[1], V), b = only[2].split(/\s*(?:\/|\bor\b|,)\s*/i).map((x) => kwPhrase(x, V));
      if (a.kws.length && a.kws.every((k) => stHas(K, k)) && !b.some((x) => x.kws.length && x.kws.every((k) => stHas(K, k)))) { ok = false; why.push(`only ${only[2].toUpperCase()} ${only[1].toUpperCase()}`); }
    }
    return { ok, any: ok && any, unsure: ok && unsure, why: why.join("; "), target: t0 };
  }
  /* the list's detachment stratagems (detachments first, in list order) then the Core stratagems, filtered for one unit */
  function unitStratagems(u, F, dets, core) {
    const pick = (st) => st.map((s) => ({ s, m: unitStratMatch(u, F, s) })).filter((x) => x.m.ok);
    const groups = (dets || []).map((d) => ({ det: d, items: pick(d.st || []), total: (d.st || []).length }));
    return { groups, core: { items: pick(core || []), total: (core || []).length } };
  }
  /* strip the secondary data source's name from saved / imported / synced / shared lists (e.g. "Loadout (GrimSlate)"
     copied into a note or name). Mutates in place; returns true when anything changed. */
  const SRC_RX = /\s*[([]\s*grimslate\s*[)\]]|\bgrimslate\b[ \t]*/gi;
  function scrubSourceName(s) { return typeof s === "string" && /grimslate/i.test(s) ? s.replace(SRC_RX, "").replace(/[ \t]{2,}/g, " ").trim() : s; }
  function scrubList(l) {
    let changed = false;
    const walk = (o) => {
      if (!o || typeof o !== "object") return;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === "string") { const n = scrubSourceName(v); if (n !== v) { o[k] = n; changed = true; } }
        else if (v && typeof v === "object") walk(v);
        if (/grimslate/i.test(k)) { const nk = scrubSourceName(k); if (nk && !(nk in o)) { o[nk] = o[k]; } delete o[k]; changed = true; }
      }
    };
    walk(l);
    return changed;
  }

  /* ---------------------------------------------------------------- Core Rules search (app/data/core_rules.json) */
  const RULE_ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
  const ruleText = (h) => String(h || "").replace(/<br>|<\/(p|li|tr|div)>/g, "\n").replace(/<\/t[hd]>/g, " ").replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => RULE_ENT[e.toLowerCase()] !== undefined ? RULE_ENT[e.toLowerCase()] : e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : m)
    .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  /* matching form: lower case, curly quotes straight, hyphens / brackets / punctuation as spaces ("battle-shock" = "battle shock") */
  const ruleNorm = (t) => String(t || "").toLowerCase().replace(/[’‘`]/g, "'").replace(/[\u2010-\u2015\-_/\[\](){}:;,.!?"“”+*]/g, " ").replace(/\s+/g, " ").trim();
  function rulesIndex(doc) {
    const S = (doc && doc.sections) || [];
    const items = S.map((s, i) => {
      const text = ruleText(s.h);
      return { i, id: s.id, t: s.t, n: s.n || "", l: s.l, p: s.p, text, nt: " " + ruleNorm(s.t) + " ", nb: " " + ruleNorm(text) + " " };
    });
    for (const it of items) {
      const path = []; let p = it.p;
      while (p !== null && p !== undefined && items[p]) { path.unshift(items[p].t); p = items[p].p; }
      it.path = path;
    }
    return { items, byId: Object.fromEntries(items.map((x) => [x.id, x])) };
  }
  const countIn = (hay, needle) => { let n = 0, k = hay.indexOf(needle); while (k >= 0 && n < 20) { n++; k = hay.indexOf(needle, k + needle.length); } return n; };
  /* ranked matches: heading matches first (exact, prefix, phrase, all words), then body phrase, then all words anywhere */
  function rulesSearch(ix, q, limit) {
    const nq = ruleNorm(q); if (!ix || nq.length < 2) return [];
    const terms = [...new Set(nq.split(" ").filter((t) => t.length > 1 || /\d/.test(t)))];
    if (!terms.length) return [];
    const numQ = /^\d\d(\.\d\d)*$/.test(String(q).trim()) ? String(q).trim() : null;
    const out = [];
    for (const it of ix.items) {
      if (it.l === 0) continue;
      const tt = it.nt, bb = it.nb; let score = 0, where = "";
      if (numQ && it.n && it.n.split(" / ").some((n) => n === numQ || n.startsWith(numQ + "."))) { score = it.n === numQ ? 950 : 500; where = "n"; }
      else if (tt.trim() === nq) { score = 1000; where = "t"; }
      else if (tt.startsWith(" " + nq + " ")) { score = 850; where = "t"; }
      else if (tt.includes(" " + nq + " ")) { score = 760; where = "t"; }
      else if (tt.includes(nq)) { score = 700; where = "t"; }
      else if (terms.every((t) => tt.includes(" " + t))) { score = 600; where = "t"; }
      if (!score || where === "t") {
        const ph = countIn(bb, " " + nq);
        if (!score && ph) score = 300 + Math.min(ph, 10) * 12;
        else if (!score && terms.every((t) => bb.includes(" " + t) || tt.includes(" " + t))) score = 100 + Math.min(terms.reduce((a, t) => a + countIn(bb, " " + t), 0), 20) * 3;
        else if (score) score += Math.min(ph, 10) * 2;
      }
      if (!score) continue;
      if (it.l >= 4) score += 4;                       // a specific rule beats its chapter on ties
      if (it.path[0] && /appendix/i.test(it.path[0])) score -= 5;
      out.push({ it, score });
    }
    out.sort((a, b) => b.score - a.score || a.it.i - b.it.i);
    return out.slice(0, limit || 60).map(({ it, score }) => ({ id: it.id, t: it.t, n: it.n, path: it.path, score, snippet: rulesSnippet(it.text, terms, nq) }));
  }
  /* ~180 characters around the first match (phrase first, else the rarest term) */
  function rulesSnippet(text, terms, nq) {
    const low = text.toLowerCase().replace(/[’‘]/g, "'").replace(/[\u2010-\u2015\-\[\]]/g, " ");
    let k = low.indexOf(nq);
    if (k < 0) for (const t of terms.slice().sort((a, b) => b.length - a.length)) { k = low.indexOf(t); if (k >= 0) break; }
    const flat = (x) => x.replace(/\s*\n\s*/g, " · ");
    if (k < 0) return flat(text.slice(0, 180)) + (text.length > 180 ? "…" : "");
    const a = Math.max(0, k - 70), b = Math.min(text.length, k + 110);
    let st = a; if (a > 0) { const sp = text.indexOf(" ", a); if (sp > 0 && sp < k) st = sp + 1; }
    return (st > 0 ? "…" : "") + flat(text.slice(st, b)) + (b < text.length ? "…" : "");
  }
  /* split a plain string into [text, isMatch] parts for highlighting (hyphens / brackets in the text still match) */
  function rulesMarks(str, q) {
    const terms = [...new Set(ruleNorm(q).split(" ").filter((t) => t.length > 1))].sort((a, b) => b.length - a.length);
    if (!terms.length) return [[str, false]];
    const rx = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['’‘]").replace(/ /g, "[\\s\\-\u2010-\u2015]+")).join("|"), "gi");
    const out = []; let last = 0, m;
    while ((m = rx.exec(str))) { if (m.index > last) out.push([str.slice(last, m.index), false]); out.push([m[0], true]); last = m.index + m[0].length; if (!m[0].length) rx.lastIndex++; }
    if (last < str.length) out.push([str.slice(last), false]);
    return out;
  }
  /* ---------------------------------------------------------------- import/export */
  function exportLists(lists) { return JSON.stringify({ app: "muster", schema: 1, exported: new Date().toISOString(), lists }, null, 1); }
  function importLists(text) {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : Array.isArray(j.lists) ? j.lists : j.entries ? [j] : null;
    if (!arr) throw new Error("No lists found in file");
    arr.forEach((l) => { if (l && typeof l === "object") scrubList(l); });
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
      // a server copy still carrying the source name is cleaned and marked newer, so the clean copy is pushed back
      const adopt = () => { const x = { ...JSON.parse(JSON.stringify(r.data)), id: r.id, updated: r.updated_at }; if (scrubList(x)) x.updated = new Date(Math.max(Date.now(), (syncTime(r.updated_at) || 0) + 1)).toISOString(); return x; };
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

  /* ---------------------------------------------------------------- points left / over */
  /* Marks of Chaos chosen per unit when a detachment rule says so (CSM Pactbound Zealots 'Marks of Chaos') */
  const MARKS = ["Khorne", "Tzeentch", "Nurgle", "Slaanesh", "Chaos Undivided"];
  function markRuleActive(list, F) {
    return !!F && (list.dets || []).some((n) => { const d = F.dets[n]; return d && d.rule && /^Marks of Chaos$/i.test(String(d.rule[0] || "").trim()); });
  }
  /* Pactbound Zealots 'Marks of Chaos' (GW app = Wahapedia 11e, James 18 Oct): null when the unit picks no mark, else
     the allowed marks. Every HERETIC ASTARTES unit (vehicles included) that is not an EPIC HERO and has no mark keyword
     must pick one; Khorne not for PSYKER units. The two Daemon Princes already choose a god as wargear (their Mark of
     Chaos option, which is also their keyword), so they get no second pick. Outside that detachment nobody picks. */
  function markChoices(list, F, u) {
    if (!u || !markRuleActive(list, F)) return null;
    const kw = (u.kw || []).map((x) => x.toLowerCase());
    if (u.fk !== "Heretic Astartes" || isEpicHero(u)) return null;
    if (MARKS.some((m) => kw.includes(m.toLowerCase()))) return null;                     // already has one
    if (u.lo && (u.lo.m || []).some((m) => (m[4] || []).some((sl) => sl[0] === "Mark of Chaos"))) return null;   // Daemon Prince wargear
    return MARKS.filter((m) => !(m === "Khorne" && kw.includes("psyker")));
  }
  /* a unit's mark: its keyword, the Daemon Prince's Mark of Chaos wargear pick, or the Pactbound pick */
  function unitMark(list, F, unit, entry, lo) {
    if (!unit) return null;
    const k = (unit.kw || []).find((x) => MARKS.includes(x)); if (k) return k;
    const l2 = lo || (entry && hasLoadout(unit) ? getLoadout(unit, entry, (pickModelOption(modelOptions(unit, 1), entry) || modelOptions(unit, 1)[0] || { models: 1 }).models) : null);
    if (l2) for (const [key, v] of Object.entries(l2.p || {})) if (/\|Mark of Chaos$/.test(key)) { const m = Object.keys(v).find((x) => v[x] > 0 && MARKS.includes(x)); if (m) return m; }
    const ch = markChoices(list, F, unit);
    return ch && entry && ch.includes(entry.mark) ? entry.mark : null;
  }
  /* the mark effects listed by the detachment rule: {Khorne: [["LETHAL HITS", text]], "Chaos Undivided": [[...], [...]]} */
  function markEffects(list, F) {
    const d = F && (list.dets || []).map((n) => F.dets[n]).find((x) => x && x.rule && /^Marks of Chaos$/i.test(String(x.rule[0] || "").trim()));
    const out = {}; if (!d) return out;
    let gained = null;
    for (const line of String(d.rule[1]).split("\n")) {
      const h = line.match(/Units That Gained \[([^\]]+)\]:?\s*(.*)$/i);
      let rest = line;
      if (h) { gained = h[1].toUpperCase(); rest = h[2]; }
      const m = rest.match(/^\W*(KHORNE|TZEENTCH|NURGLE|SLAANESH|CHAOS UNDIVIDED):\s*(.+)$/i);
      if (m && gained) { const k = MARKS.find((x) => x.toUpperCase() === m[1].toUpperCase()); (out[k] = out[k] || []).push([gained, m[2].trim()]); }
    }
    return out;
  }
  /* Can detachment d still be ticked given the current picks? (1+1+1, 2+1, a single 3; Incursion: <=2 or a lone 3 DP) */
  /* Custodes Favoured Ka'tah: a "Unique: Shield Host" detachment rule names one ka'tah ability and its additional effect
     ("Favoured ka'tah\nCalistus\nAdditional Effect: Your unit has +2\" M.") -> { name, effect } or null */
  function favouredKatah(d) {
    const t = d && d.rule ? String(d.rule[1] || "") : "";
    const m = t.match(/favoured\s+ka.tah\s*\n\s*([A-Za-z]+)\s*\n\s*additional effect:\s*([\s\S]*)$/i);
    return m ? { name: m[1].toUpperCase(), effect: m[2].trim(), det: d.n } : null;
  }
  /* army rule meta [name, text, meta]: the text minus the ka'tah ability paragraphs that meta.ka lists separately */
  function armyRuleBody(r) {
    const ka = (r && r[2] && r[2].ka) || [];
    if (!ka.length) return String((r && r[1]) || "");
    const names = new Set(ka.map((k) => norm(k[0])));
    return String(r[1] || "").split(/\n\n/).filter((p) => !names.has(norm(p.split(/\s+[–-]\s+|\n/)[0]))).join("\n\n");
  }
  function detFits(l, F, d, size) {
    const sel = (l.dets || []).filter((n) => n !== d.n);
    if ((l.dets || []).includes(d.n) || !size || size.dp == null || d.dp == null) return true;
    const used = sel.reduce((a, n) => a + ((F.dets[n] && F.dets[n].dp) || 0), 0);
    if (used + d.dp <= size.dp) return true;
    return !!size.single3dp && !sel.length && d.dp === 3;
  }
  function pointsLeft(total, limit) {
    if (limit == null || !isFinite(limit)) return null;
    const d = limit - total;
    return d >= 0 ? { left: d, over: 0, text: `${d} pts left`, cls: "left" } : { left: 0, over: -d, text: `${-d} pts over`, cls: "over" };
  }

  /* ---------------------------------------------------------------- enhancement stat modifiers
     Reads an enhancement's rules text for characteristic changes to the bearer (or its unit) and its weapons:
     'Add 1 to the Attacks and Strength characteristics of the bearer's melee weapons', 'Improve the Armour
     Penetration characteristic ... by 1', 'The bearer has a Save characteristic of 2+', 'This model's melee attacks
     have +1 S and AP', 'This unit has +2" M', '5+ invulnerable save'. Hit/Wound roll modifiers are not
     characteristics and are ignored; effects on enemy/other friendly units and on attacks made against the bearer
     are ignored. Mods in a sentence with a condition (while/if/each time/once per battle/until/'instead'/'Or:')
     are marked cond (with the sentence as the condition). Display only: points and exports never change. */
  const EM_STAT = { attacks: "A", strength: "S", damage: "D", "armour penetration": "AP", "weapon skill": "WS", "ballistic skill": "BS", range: "RANGE",
    toughness: "T", wounds: "W", move: "M", movement: "M", leadership: "LD", "objective control": "OC", save: "SV" };
  const EM_ABBR = { A: "A", S: "S", D: "D", AP: "AP", WS: "WS", BS: "BS", T: "T", W: "W", M: "M", OC: "OC", LD: "LD", SV: "SV" };
  const EM_WEAPON = new Set(["A", "S", "D", "AP", "WS", "BS", "RANGE"]);
  const EM_LONG = "attacks|strength|damage|armour penetration|weapon skill|ballistic skill|range|toughness|wounds|movement|move|leadership|objective control|save";
  const EM_SHORT = "A|S|AP|D|WS|BS|T|W|M|OC|Ld|Sv";
  const EM_COND = /\b(while|if|each time|once per|until|at the start|at the end|when|in your|in the declare|on a critical|that targets?|for every|for each|select one|instead|or:|discard|spend|roll one)\b/i;
  const EM_SKIP_DET = /\b(enemy|allocated to|targets? (?:the bearer|this unit|this model|your unit)|saving throw|ignore any or all|attacking model|target unit|the target)\b/i;
  const EM_SKIP = /\b(enemy|friendly|allocated to|targets? (?:the bearer|this unit|this model|your unit)|saving throw|ignore any or all|transport|attacking model|target unit|the target)\b/i;
  function emSentences(text) {
    const out = [];
    let head = "", gate = "", other = false, lastKw = "", otherSen = "";
    for (const raw of String(text || "").replace(/\*\*/g, "").split("\n")) {
      const line = raw.trim(); if (!line) continue;
      // sentences; '... of 6+ and, once per battle, ...' starts a separate (conditional) clause
      const parts = line.split(/(?<=\.)\s+(?=[A-Z(])|\s+and,\s+(?=once per|each time|until|at the start)/);
      for (const p of parts) {
        // lines of a 'This unit has:' / 'melee attacks have:' list inherit the header's subject
        if (head && !/model only|unit only/i.test(p) && (p.length < 80 || /^(?:\+|-|\d+\+|or:|\[|have\b|has\b|can\b|add\b|improve\b|subtract\b|worsen\b|each time\b|this\b|that\b|those\b)/i.test(p))) out.push({ s: p, ctx: head + " " + p, gate, other, otherSen, lastKw });
        else { head = /:\s*$/.test(p) ? p : ""; out.push({ s: p, ctx: p, gate, other, otherSen, lastKw }); }
        if (emPhrases(p).length) lastKw = p;
        // once-per / use-this-ability / choose-one texts: everything after is conditional
        if (/\(once per|once per (?:battle|turn|phase|battle round)\b|use this (?:ability|enhancement)|select one of the (?:\w+ )?(?:abilities|bullet points|options)|select which|either select|select one from the list|roll one D6/i.test(p)) gate = gate && !emPhrases(p).length && emPhrases(gate).length ? gate + " " + p : p;
        // effects on another unit the bearer selects ('select one friendly KROOT unit ... that unit has +1 Ld')
        if (/\bselect (?:one|up to \w+|one or more) (?:friendly )?(?:[A-Z][A-Z'’/ -]*\s)?(?:unit|model)s?\b/.test(p) && !/select one of (?:this|the bearer)/i.test(p)) { other = true; otherSen = p; }
      }
    }
    return out;
  }
  function emWeaponFilter(ctx, wp) {
    const f = {};
    if (/\bmelee\b/i.test(ctx) && !/\branged\b/i.test(ctx)) f.kind = "m";
    else if (/\branged\b/i.test(ctx) && !/\bmelee\b/i.test(ctx)) f.kind = "r";
    if (/excluding \[?psychic\]?/i.test(ctx)) f.exkw = "PSYCHIC";
    else if (/\bpsychic weapons?\b|\[psychic\] (?:weapons|attacks)/i.test(ctx)) f.kw = "PSYCHIC";
    if (/excluding extra attacks/i.test(ctx)) f.exkw = "EXTRA ATTACKS";
    if (/\btorrent\b/i.test(ctx)) f.kw = "TORRENT";
    if (/\bpistols?\b/i.test(ctx)) f.kw = "PISTOL";
    const nm = ctx.match(/(?:bearer's|model's|this model's) ((?:[A-Z][\w'’-]*\s+){0,3}[A-Z][\w'’-]*) weapons?\b/);
    if (nm && !/^(?:Psychic|Torrent|Pistol|Melee|Ranged)$/i.test(nm[1])) f.name = nm[1];
    // a datasheet weapon named in lower case ("this model's infernal cannon", "its hellforged weapons")
    if (!f.name && wp && wp.length) {
      const lc = String(ctx).toLowerCase().replace(/’/g, "'");
      const hit = wp.filter((w) => { const n = String(w).toLowerCase(); return n.length > 3 && new RegExp(`(?:model's|bearer's|its|this model's)\\s+${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lc); })
        .sort((a, b) => b.length - a.length)[0];
      if (hit) f.name = hit;
    }
    return f;
  }
  function emScope(ctx, stat) {
    ctx = ctx.replace(/(?:^|:\s*)(?:or:\s*)?(?:if|while|when)\b[^,]*,\s*/gi, " ");      // 'If this unit made a charge move, ...'
    if (/models? in (?:that|the bearer's|this|its) unit|equipped by models|\bthis unit\b|bearer's unit (?:have|has)\b/i.test(ctx)) return "unit";
    return "model";
  }
  function enhStatMods(text, opt) {
    opt = opt || {};
    const mods = [];
    const pick = (String(text || "").match(/select one of this model's ((?:[A-Z][\w'’-]*\s+){0,3}[A-Z][\w'’-]*) weapons/) || [])[1];
    const push = (m, sen, at) => {
      if (opt.det && sen.other && !sen.gate) sen = Object.assign({}, sen, { gate: sen.otherSen || "a selected unit" });
      // condition: a conditional phrase before the change (same sentence or list header), 'instead', or a gate
      const pre = sen.ctx.slice(0, sen.ctx.length - sen.s.length + (at || 0));
      const cond = EM_COND.test(pre) || /\binstead\b|\bfor every\b/i.test(sen.s) || !!sen.gate;
      // a list item ('+2 S.') under a conditional lead-in ('In the Fight phase, when ... makes a Dark Pact, ... have:') names that lead-in
      const head = sen.ctx !== sen.s ? sen.ctx.slice(0, sen.ctx.length - sen.s.length).trim() : "";
      const lead = sen.gate && sen.gate !== sen.s ? sen.gate : (head && EM_COND.test(head) ? head.replace(/:$/, "") : "");
      m.cond = cond ? ((lead ? lead + " … " : "") + sen.s.replace(/^or:\s*/i, "")) : null;
      if (m.stat === "RANGE" && /abilit/i.test(sen.s) && !/weapon/i.test(sen.s)) return;
      if (/\bselect one\b/i.test(sen.ctx)) m.pick = true;
      if (EM_WEAPON.has(m.stat)) { m.filter = emWeaponFilter(sen.ctx, opt.wp); if (pick && !m.filter.name && /that weapon/i.test(sen.ctx)) { m.filter.name = pick; m.pick = true; } }
      m.scope = emScope(sen.ctx, m.stat);
      if (m.stat === "INV" && /against (ranged|melee) attacks/i.test(sen.s)) m.cond = sen.s;
      Object.defineProperty(m, "_ctx", { value: sen.ctx }); Object.defineProperty(m, "_gate", { value: sen.gate || "" }); Object.defineProperty(m, "_last", { value: sen.lastKw || "" });
      if (!mods.some((x) => x.stat === m.stat && x.v === m.v && x.op === m.op && x.cond === m.cond)) mods.push(m);
    };
    for (const sen of emSentences(text)) {
      const s = sen.s;
      // detachment rules: 'Friendly WORLD EATERS units' = your own army (not another unit as for an enhancement);
      // a unit the player selects is conditional, not skipped
      const skip = opt.det ? EM_SKIP_DET : EM_SKIP;
      if ((sen.other && !opt.det) || /\bthe selected (?:[A-Z]+ )?(?:unit|model)\b/i.test(s) && !opt.det || skip.test(s) || /\bhit roll|wound roll|advance roll|charge roll\b/i.test(s) && !/characteristic|\+\d+\s*(?:A|S|AP|D)\b/.test(s)) continue;
      if (/\bfollowing weapon\b/i.test(sen.ctx)) continue;
      let m;
      // 'Add 3 to the Strength and add 1 to the Attacks characteristics' / 'Add 2" to the Move characteristic'
      const reAdd = new RegExp(`\\b(add|subtract)\\s+(\\d+)"?\\s+to\\s+(?:the\\s+)?(?:(?:bearer|this model|this unit|its)(?:['’]s)?\\s+)?((?:${EM_LONG})(?:(?:,\\s*|\\s+and\\s+)(?:${EM_LONG}))*)`, "gi");
      while ((m = reAdd.exec(s))) {
        const n = (+m[2]) * (m[1].toLowerCase() === "subtract" ? -1 : 1);
        for (const w of m[3].toLowerCase().split(/,\s*|\s+and\s+/)) push({ stat: EM_STAT[w], op: "add", v: n }, sen, m.index);
      }
      const reImp = new RegExp(`\\b(improve|worsen|increase)\\s+(?:the\\s+)?(?:bearer's\\s+)?((?:${EM_LONG})(?:(?:,\\s*|\\s+and\\s+)(?:${EM_LONG}))*)\\s+characteristics?\\b[^.;]*?\\bby\\s+(\\d+)`, "gi");
      while ((m = reImp.exec(s))) {
        const n = (+m[3]) * (m[1].toLowerCase() === "worsen" ? -1 : 1);
        for (const w of m[2].toLowerCase().split(/,\s*|\s+and\s+/)) push({ stat: EM_STAT[w], op: "add", v: n }, sen, m.index);
      }
      const reSet = new RegExp(`\\b(${EM_LONG}) characteristic of (\\d+"?\\+?)`, "gi");
      while ((m = reSet.exec(s))) if (!/^\s*or (?:higher|more|less|lower|fewer)/i.test(s.slice(m.index + m[0].length))) push({ stat: EM_STAT[m[1].toLowerCase()], op: "set", v: m[2] }, sen, m.index);
      // 'The bearer has a 3+ Save characteristic' (value before the characteristic name; Tomb Blade Shieldvanes)
      const reSet2 = new RegExp(`\\bhas an? (\\d+"?\\+?) (${EM_LONG}) characteristic\\b`, "gi");
      while ((m = reSet2.exec(s))) push({ stat: EM_STAT[m[2].toLowerCase()], op: "set", v: m[1] }, sen, m.index);
      const reInv = /\b(\d)\+ (?:invulnerable save|InSv)\b/gi;
      while ((m = reInv.exec(s))) push({ stat: "INV", op: "set", v: m[1] + "+" }, sen, m.index);
      const reSv = /(?:^|\s)(\d)\+ Sv\b/g;
      while ((m = reSv.exec(s))) push({ stat: "SV", op: "set", v: m[1] + "+" }, sen, m.index);
      // new style: '+1 S and AP', '+1 A, S, AP and D', '+2" M', '+2W', '+1A', '+1 Ld and OC'
      const reNew = new RegExp(`(?:^|[\\s:(/])([+-]\\d+)"?\\s*((?:${EM_SHORT})(?:(?:,\\s*|\\s+and\\s+)(?:${EM_SHORT}))*)(?![\\w"])`, "g");
      while ((m = reNew.exec(s))) {
        const n = +m[1];
        for (const w of m[2].split(/,\s*|\s+and\s+/)) push({ stat: EM_ABBR[w.toUpperCase()], op: "add", v: n }, sen, m.index);
      }
    }
    // a conditional 'instead' / 'Or:' variant of an unconditional mod is an alternative, not cumulative
    for (const x of mods) { const b = mods.find((y) => !y.cond && y.stat === x.stat); if (x.cond && b) { x.alt = true; x.scope = b.scope; } }
    return mods.filter((x) => x.stat);
  }
  /* apply one mod to a characteristic value string ("3+", "6\"", "-1", "D6+1", "2") -> new string, or null */
  function applyStatMod(stat, val, mod) {
    const v = String(val == null ? "" : val).trim();
    if (mod.op === "set" && (!v || v === "-")) return ["INV", "SV", "LD", "OC", "W", "T", "M"].includes(stat) ? String(mod.v) : null;
    if (!v || v === "-" || /^n\/?a$/i.test(v)) return null;
    if (mod.op === "set") {
      if (stat === "INV" || stat === "SV" || stat === "LD") { const a = parseInt(v), b = parseInt(mod.v); return isNaN(a) || b < a ? String(mod.v) : null; }
      return String(mod.v);
    }
    const n = mod.v;
    if (["SV", "LD", "WS", "BS", "INV"].includes(stat)) {           // X+ : improving lowers the number (not below 2+)
      const a = parseInt(v); if (isNaN(a)) return null;
      return Math.min(6, Math.max(2, a - n)) + "+";
    }
    if (stat === "AP") { const a = parseInt(v); if (isNaN(a)) return null; const r = Math.min(0, a - n); return r === 0 ? "0" : String(r); }
    if (stat === "M" || stat === "RANGE") { const a = v.match(/^(\d+)("?)(.*)$/); if (!a) return null; return (Math.max(0, +a[1] + n)) + (a[2] || '"') + a[3]; }
    if (/^\d+$/.test(v)) return String(Math.max(stat === "OC" ? 0 : 1, +v + n));
    const d = v.match(/^(\d*D\d+)(?:\s*\+\s*(\d+))?$/i);              // D3, D6+1, 2D6
    if (d) { const k = (+(d[2] || 0)) + n; return k > 0 ? `${d[1]}+${k}` : k === 0 ? d[1] : null; }
    return null;
  }
  /* detachment rules: the same parser, plus which units a change applies to (keywords named in the sentence, its
     list header or the choose-one lead-in; 'excluding X' honoured; no keyword named = every unit of the army) */
  const EM_NOTKW = new Set(["A", "S", "AP", "D", "WS", "BS", "T", "W", "M", "OC", "LD", "SV", "INV", "CP", "D3", "D6", "OR", "AND", "VP", "YP"]);
  function emPhrases(text) {
    const t = String(text || "").replace(/\[[^\]]*\]/g, " ");
    const out = [];
    // 'Kroot models from your army' (keyword written in title case)
    const tc = /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?) (?:models?|units?) from your army\b/g; let q;
    while ((q = tc.exec(t))) out.push({ p: q[1].toUpperCase(), excl: false });
    const re = /\b[A-Z][A-Z'’-]*[A-Z](?:\s+[A-Z][A-Z'’-]*[A-Z])*\b/g; let m;
    while ((m = re.exec(t))) {
      if (EM_NOTKW.has(m[0]) || /\b(?:within|your)\s+$/i.test(t.slice(Math.max(0, m.index - 8), m.index))) continue;
      out.push({ p: m[0], excl: /\bexcluding\b[^.)]*$/i.test(t.slice(0, m.index)) && !/\)/.test(t.slice(t.lastIndexOf("excluding", m.index), m.index)) });
    }
    return out;
  }
  function kwMatch(phrase, set) {
    const w = stNorm(phrase).split(" ").map(stSing); const ok = [true];
    for (let j = 1; j <= w.length; j++) { ok[j] = false; for (let i = 0; i < j && !ok[j]; i++) if (ok[i] && (set.has(w.slice(i, j).join(" ")))) ok[j] = true; }
    return ok[w.length];
  }
  function detModEligible(m, u, F) {
    const set = unitKeywords(u, F);
    const grant = m._grant || {};
    // keywords granted by the rule itself ('SOUL FORGE' <- 'HERETIC ASTARTES VEHICLE ... units gain the SOUL FORGE keyword')
    const sub = (ph) => ph.flatMap((x) => (grant[x.p] ? grant[x.p].map((p) => ({ p, excl: x.excl })) : grant[x.p] === null ? [] : [x]));
    let ph = sub(emPhrases(m._ctx));
    if (!ph.some((x) => !x.excl)) ph = ph.concat(sub(emPhrases(m._gate)));
    if (!ph.some((x) => !x.excl)) ph = ph.concat(sub(emPhrases(m._last)));
    if (ph.some((x) => x.excl && kwMatch(x.p, set))) return false;
    const pos = ph.filter((x) => !x.excl);
    return !pos.length || pos.some((x) => kwMatch(x.p, set));
  }
  function detStatMods(d, wp) {
    if (!d || !d.rule || !d.rule[1]) return [];
    const grant = {};
    for (const line of d.rule[1].split(/\n|(?<=\.)\s+/)) {
      const g = line.match(/^(.*?)\b(?:units?|models?)\b[^.]*?\b(?:gains?|have|has) the ([A-Z][A-Z'’ -]*[A-Z]) keyword/);
      if (g && !/BATTLELINE/.test(g[2])) { const subj = emPhrases(g[1]).filter((x) => !x.excl).map((x) => x.p); grant[g[2]] = subj.length ? subj : null; }
    }
    // a Shield Host's Favoured Ka'tah "Additional Effect" only applies while that ka'tah ability is used: not a standing mod
    const always = d.rule[1].replace(/\n\s*favoured\s+ka.tah\s*\n[\s\S]*$/i, "");
    return enhStatMods(always, { det: true, wp }).map((m) => { Object.defineProperty(m, "_grant", { value: grant }); return m; });
  }
  /* picked loadout options whose text changes a characteristic (Daemon Prince Mark of Chaos: 'Add 3 to the Attacks
     characteristic of this model's infernal cannon') -> [{name: 'Mark of Chaos: Tzeentch', text}] */
  /* wargear abilities of a unit: [[gearName, abilityName, text]]. The datasheet's wargear abilities (ds.wa) plus unit
     abilities that are really wargear (Tomb Blades Shieldvanes / Shadowloom / Nebuloscope are listed with the unit
     abilities): an ability whose name is a loadout option, fixed gear or MFM wargear item and not a weapon profile */
  const gkey = (t) => norm(sing(String(t || "").toLowerCase()));
  function wargearAbilities(u, ds) {
    if (!ds) return [];
    const M = loModel(u), gear = new Map();
    // Mark of Chaos cards belong to units that pick a mark as wargear (the Heretic Astartes Daemon Princes); older data
    // copied the Daemon Prince's cards onto every CSM unit
    const markSlot = !!M && M.types.some((t) => t.slots.some((sl) => /^marks? of chaos$/i.test(sl.name)));
    const out = (ds.wa || []).filter((a) => markSlot || !["Khorne", "Nurgle", "Slaanesh", "Tzeentch", "Chaos Undivided"].includes(a[0])).map((a) => [a[0], a[1], a[2]]);
    const addG = (n) => { if (n) for (const part of String(n).split(/\s*(?:\+|,|\band\b)\s*/i)) if (part && !gear.has(gkey(part))) gear.set(gkey(part), part.replace(/^\d+\s*x?\s+|^(?:a|an|one)\s+/i, "").trim()); };
    if (M) for (const t of M.types) { t.fixed.forEach(addG); for (const sl of t.slots) sl.opts.forEach((o) => addG(o.name)); }
    if (M) for (const sl of M.unit) sl.opts.forEach((o) => addG(o.name));
    for (const w of u.w || []) addG(w[0]);
    const weapons = new Set((ds.wp || []).map((w) => gkey(w[0])));
    for (const a of ds.ab || []) {
      const k = gkey(a[0]); if (weapons.has(k) || out.some((x) => gkey(x[1]) === k)) continue;
      if (gear.has(k)) out.push([gear.get(k), a[0], a[1]]);
    }
    return out;
  }
  /* picked loadout options whose text changes a characteristic (Daemon Prince Mark of Chaos: 'Add 3 to the Attacks
     characteristic of this model's infernal cannon'); an option without text uses its wargear ability (Shieldvanes)
     -> [{slot, name, text, n}] (n = models with it) */
  function pickedGearTexts(u, lo, ds) {
    const M = loModel(u); if (!M || !lo || !lo.p) return [];
    const wa = ds ? wargearAbilities(u, ds) : [];
    const textOf = (n) => { const a = wa.find((x) => gkey(x[0]) === gkey(n) || gkey(x[1]) === gkey(n)); return a ? a[2] : ""; };
    const out = [];
    const scan = (owner, slots) => { for (const s of slots) for (const o of s.opts) { const n = (lo.p[`${owner}|${s.name}`] || {})[o.name] || 0; const text = o.text || textOf(o.name); if (text && n > 0) out.push({ slot: s.name, name: o.name, text, n }); } };
    for (const t of M.types) { scan(t.name, t.slots); const k = (lo.c || {})[t.name] || 0;
      if (k && ds) for (const f of t.fixed) { const text = textOf(f); if (text) out.push({ slot: t.name, name: f, text, n: k }); } }
    scan("*", M.unit);
    return out;
  }
  function entryStatMods(F, r, dets, wp) {
    const out = [];
    const of = (x, unitOnly) => {
      const en = x && x.entry && x.entry.enh; if (!en || !F) return;
      const d = F.dets[en.det]; const e = d && d.enh.find((y) => y[0] === en.name); if (!e || !e[2]) return;
      for (const m of enhStatMods(e[2], { wp })) if (!unitOnly || m.scope === "unit") out.push(Object.assign({ enh: e[0], via: unitOnly ? x.name || (x.unit && x.unit.n) : null }, m));
    };
    of(r, false);
    for (const x of (r && r.attached) || []) of(x, true);
    // wargear / Mark of Chaos picks with a characteristic change (stack with the enhancement and the detachment rule)
    const uds = r && r.unit && F && _unitDs ? _unitDs.get(F.f.id + "|" + r.unit.n) : null;
    const gear = r && r.unit ? pickedGearTexts(r.unit, r.lo, uds) : [];
    // in a multi-model unit a bearer-only change (one model's storm shield, some Tomb Blades' Shieldvanes) is shown as a
    // conditional change naming its bearers; when every model carries it, it is the unit's profile
    const nModels = r && r.lo && r.lo.c ? Object.values(r.lo.c).reduce((a, b) => a + (b || 0), 0) : 1;
    // abilities aimed at another unit ('select one friendly CANOPTEK unit within 3"': Accelerator Mandible) are not this profile
    for (const g of gear.filter((x) => !/\bselect one friendly\b|\bwithin \d+"/i.test(stripMd(x.text)))) for (const m of enhStatMods(g.text, { wp })) {
      const label = g.slot && norm(g.slot) !== norm(g.name) ? `${g.slot}: ${g.name}` : g.name;
      if (nModels <= 1 || m.scope === "unit" || g.n >= nModels) out.push(Object.assign({ enh: label, src: "gear", via: null }, m));
      else if (m.stat && !m.filter && !m.cond) out.push(Object.assign({ enh: label, src: "gear", via: null }, m, { cond: `only the ${g.n} of ${nModels} models with ${g.name}` }));
    }
    // a picked Mark of Chaos is a keyword ('excluding KHORNE units' then skips a Khorne Daemon Prince)
    const marks = gear.filter((g) => /^marks? of chaos$/i.test(g.slot)).map((g) => g.name);
    for (const dn of dets || []) {
      const d = F && F.dets[dn]; if (!d || !r || !r.unit) continue;
      const u = marks.length ? Object.assign({}, r.unit, { kw: (r.unit.kw || []).concat(marks) }) : r.unit;
      for (const m of detStatMods(d, wp)) if (detModEligible(m, u, F)) out.push(Object.assign({ enh: `${d.n} – ${d.rule[0]}`, src: "det", via: null }, m, { scope: "unit" }));
    }
    return out;
  }
  /* value of one characteristic after the mods that touch it: {v, base, cond, mods} or null (no change) */
  function statWithMods(stat, val, mods) {
    const touch = mods.filter((m) => m.stat === stat);
    if (!touch.length) return null;
    const un = touch.filter((m) => !m.cond);
    const use = un.length ? un : touch.filter((m, i) => !m.alt && touch.findIndex((y) => y.stat === m.stat) === i);
    let v = String(val == null ? "" : val), changed = false;
    for (const m of use) { const n = applyStatMod(stat, v, m); if (n != null && n !== v) { v = n; changed = true; } }
    if (!changed) return null;
    return { v, base: val, cond: !un.length, mods: touch };
  }
  function weaponMatches(mod, kind, name, kws) {
    const f = mod.filter || {};
    const K = (kws || []).map((k) => String(k).toUpperCase());
    if (f.kind && f.kind !== kind) return false;
    if (f.kw && !K.some((k) => k.includes(f.kw))) return false;
    if (f.exkw && K.some((k) => k.includes(f.exkw))) return false;
    if (f.name && !norm(name).includes(norm(f.name).replace(/s$/, ""))) return false;
    if ((mod.stat === "BS" && kind === "m") || (mod.stat === "WS" && kind === "r")) return false;
    if (mod.stat === "RANGE" && kind === "m") return false;
    return true;
  }

  /* ==== text import: any pasted army-list text -> parse report + Muster list ====
     Formats: GW app export (EN/FR/DE/ES), New Recruit (simple / GW-style / WTC compact / WTC full), ListForge text,
     BattleScribe text, Muster's own text exports, tournament templates and loose free-form lines.
     parseListText(text, idx, ds, opts) -> parse {format, header, items, lines, ...}; buildFromParse(parse, idx, ds) -> {list, calc, rows}
     Nothing is dropped: every non-blank line ends up as a unit, a sub-line of a unit, a header fact, or an "unrecognised" line. */
  const tiDeacc = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const tiSing = (w) => (w.length < 4 || /(ss|us|is|ys)$/.test(w) ? w : w.replace(/ies$/, "y").replace(/(ch|sh|x|ss)es$/, "$1").replace(/s$/, ""));
  /* normalised token key: case, accents, punctuation, unicode dashes/quotes, w/ -> with, & -> and, plurals, [Legends] */
  function tiKey(s) {
    const t = tiDeacc(s).toLowerCase().replace(/[’‘`´]/g, "'").replace(/\[legends\]|\(legends\)/g, " ").replace(/\bw\//g, " with ")
      .replace(/&/g, " and ").replace(/'s\b/g, "s").replace(/'/g, "").replace(/[^a-z0-9]+/g, " ").trim();
    return t ? t.split(" ").map(tiSing).join(" ") : "";
  }
  const tiCk = (s) => tiKey(s).replace(/ /g, "");
  const TI_STOP = new Set(["the", "of", "a", "an", "with", "and", "on", "in", "de", "du", "la", "le", "des", "et"]);
  function tiBigrams(s) { const o = new Map(); for (let i = 0; i < s.length - 1; i++) { const b = s.slice(i, i + 2); o.set(b, (o.get(b) || 0) + 1); } return o; }
  function tiDice(a, b) {
    if (!a || !b) return 0; if (a === b) return 1;
    const A = tiBigrams(a), B = tiBigrams(b); let inter = 0, na = 0, nb = 0;
    for (const v of A.values()) na += v; for (const v of B.values()) nb += v;
    for (const [k, v] of A) if (B.has(k)) inter += Math.min(v, B.get(k));
    return na + nb ? (2 * inter) / (na + nb) : 0;
  }
  /* similarity 0..1 of two names (token overlap + character bigrams) */
  function tiSim(a, b) {
    const ka = tiKey(a), kb = tiKey(b); if (!ka || !kb) return 0;
    if (ka === kb || ka.replace(/ /g, "") === kb.replace(/ /g, "")) return 1;
    const ta = ka.split(" ").filter((w) => !TI_STOP.has(w)), tb = kb.split(" ").filter((w) => !TI_STOP.has(w));
    const sb = new Set(tb); const inter = ta.filter((w) => sb.has(w)).length;
    const tok = ta.length + tb.length ? (2 * inter) / (ta.length + tb.length) : 0;
    return Math.max(tok * 0.97, tiDice(ka.replace(/ /g, ""), kb.replace(/ /g, "")));
  }
  /* renamed / commonly abbreviated datasheets: old or short name -> current name (only applied when the target exists) */
  const TI_ALIAS = {
    "allarus terminator": "Allarus Custodians", "custodian guard squad": "Custodian Guard", "intercessor": "Intercessor Squad",
    "assault intercessor": "Assault Intercessor Squad", "terminator": "Terminator Squad", "hellblaster": "Hellblaster Squad",
    "eradicator": "Eradicator Squad", "infernus": "Infernus Squad", "sternguard": "Sternguard Veteran Squad", "aggressor": "Aggressor Squad",
    "eliminator": "Eliminator Squad", "infiltrator": "Infiltrator Squad", "incursor": "Incursor Squad", "scout": "Scout Squad",
    "suppressor": "Suppressor Squad", "outrider": "Outrider Squad", "desolation": "Desolation Squad", "devastator": "Devastator Squad",
    "inceptor": "Inceptor Squad", "reiver": "Reiver Squad", "heavy intercessor": "Heavy Intercessor Squad", "tactical": "Tactical Squad",
    "battle sister": "Battle Sisters Squad", "battle sisters": "Battle Sisters Squad", "sister of battle": "Battle Sisters Squad", "repentia": "Repentia Squad", "seraphim": "Seraphim Squad",
    "zephyrim": "Zephyrim Squad", "retributor": "Retributor Squad", "dominion": "Dominion Squad", "sacresant": "Celestian Sacresants",
    "insidiant": "Celestian Insidiants", "arco": "Arco-flagellants", "kabalite": "Kabalite Warriors", "wych": "Wyches",
    "breacher": "Breacher Team", "stealth suit": "Stealth Battlesuits", "crisis": "Crisis Battlesuits", "broadside": "Broadside Battlesuits",
    "ghostkeel": "Ghostkeel Battlesuit", "riptide": "Riptide Battlesuit", "big mek": "Big Mek", "gros mek": "Big Mek",
    "boy": "Boyz", "nob": "Nobz", "lychguard": "Lychguard", "warrior": "Necron Warriors", "wraith": "Canoptek Wraiths",
    "plague marine": "Plague Marines", "poxwalker": "Poxwalkers", "berzerker": "Khorne Berzerkers", "rubric": "Rubric Marines",
    "legionary": "Legionaries", "chosen": "Chosen", "venatari": "Venatari Custodians", "praetor": "Vertus Praetors",
    "warden": "Custodian Wardens", "witchseeker": "Witchseekers", "prosecutor": "Prosecutors", "vigilator": "Vigilators",
    "sister rhino": "Rhino", "dawneagle captain": "Shield-Captain on Dawneagle Jetbike", "bike captain": "Shield-Captain on Dawneagle Jetbike",
    "tbt": "Terminator Squad", "blade champion": "Blade Champion", "pink horror": "Pink Horrors", "bloodletter": "Bloodletters",
    "plaguebearer": "Plaguebearers", "kamion": "Trukk", "kass'tanks": "Tankbustas", "frimeurs": "Flash Gitz", "klat'jet wazboum": "Wazbom Blastajet",
    "gros mek avec kanon shokk": "Big Mek with Shokk Attack Gun", "daemonette": "Daemonettes", "nurgling": "Nurglings", "flesh hound": "Flesh Hounds",
  };
  let _tiAl = null;
  const tiAliasMap = () => { if (!_tiAl) { _tiAl = {}; for (const [k, v] of Object.entries(TI_ALIAS)) _tiAl[tiKey(k)] = v; } return _tiAl; };
  /* faction names in other languages / older names: [name, faction id, rank] (rank 1 = generic) */
  const TI_FACTION_ALIAS = [["Adeptus Astartes", "space-marines", 1], ["Space Marine", "space-marines", 1], ["Imperial Guard", "astra-militarum", 2],
    ["Sisters of Battle", "adepta-sororitas", 2], ["Admech", "adeptus-mechanicus", 2], ["Ad Mech", "adeptus-mechanicus", 2], ["Custodes", "adeptus-custodes", 2],
    ["Craftworlds", "aeldari", 2], ["Eldar", "aeldari", 2], ["Asuryani", "aeldari", 2], ["Dark Eldar", "drukhari", 2], ["Tau", "tau-empire", 2],
    ["T'au", "tau-empire", 2], ["Tau Empire", "tau-empire", 2], ["Empire T'au", "tau-empire", 2], ["T'au-Sternenreich", "tau-empire", 2], ["Imperio T'au", "tau-empire", 2],
    ["Necrones", "necrons", 2], ["Votann", "leagues-of-votann", 2], ["GSC", "genestealer-cults", 2], ["Legiones Daemonica", "chaos-daemons", 2],
    ["Daemons", "chaos-daemons", 2], ["Heretic Astartes", "chaos-space-marines", 1], ["CSM", "chaos-space-marines", 2], ["Agents of the Imperium", "imperial-agents", 2],
    ["Questor Traitoris", "chaos-knights", 2], ["Adeptus Titanicus", "titan-legions", 2], ["Tyranides", "tyranids", 2], ["Orques", "orks", 2],
    ["Marines Espaciales", "space-marines", 1], ["Space Marines", "space-marines", 1], ["Mechanicus", "adeptus-mechanicus", 2]];
  const TI_SECTIONS = /^(characters?|epic heroe?s?|battleline|other datasheets|dedicated transports?|allied units|infantry|mounted|beasts?|swarms?|monsters?|vehicles?|fortifications?|transports?|lords? of war|elites|troops|fast attack|heavy support|flyers?|hq|personnages?|personaje|personajes|charaktere|ligne de bataille|autres fiches techniques|transports? assign[ée]s|unit[ée]s alli[ée]es|linea de batalla|l[ií]nea de batalla|otras hojas de datos|transportes asignados|standardtruppen|charaktermodelle|linientruppen|weitere datenbl[äa]tter|zugewiesene transportfahrzeuge|transportfahrzeuge|andere datenbl[äa]tter|errors|short version|long version|angeschlossene einheiten|attached units|unit[ée]s attach[ée]es|unidades (?:adjuntas|anexadas)|not in current data|configuration|units?)$/i;
  const TI_GROUP = /^(attached unit|attached|unit[ée] attach[ée]e|unit[ée] \d+ attach[ée]e|angeschlossene einheit|unidad adjunta|unidad anexada)\s*\d*\s*(?::.*)?$/i;
  const TI_FOOTER = /^(exported with|created with|export[ée] avec|exportiert mit|exportada con|exportado con|end of roster|total\s*:|validation\s*:|generated by|list ?forge|newrecruit\.eu|https?:\/\/)/i;
  const TI_WARLORD = /^(warlord|seigneur de guerre|kriegsherr|se[nñ]or de la guerra|signore della guerra)$/i;
  const TI_ATTACHED_AS = /^(attached as|attach[ée]e? en tant que|angeschlossen als|unid[oa] como|adjunt[oa] como|anexad[oa] como)\s*:?\s*(.*)$/i;
  const TI_ENH = /^(enhancements?|e|optimisations?|am[ée]liorations?|verbesserung(?:en)?|mejoras?|potenciamientos?|upgrades?)\s*:\s*(.+)$/i;
  const TI_PTS = /[([]\s*\+?\s*(\d{1,3}(?:[ ,.\u202f\u00a0]\d{3})+|\d+)\s*(?:pts?|points?|punkte|puntos|pkt|pt|punti|pontos)\.?\s*(?:limit)?\s*[)\]]/i;
  const TI_PTS_TAIL = /(?:^|\s|-|,)\s*(\d+)\s*(?:pts?|points?)\.?\s*$/i;
  const tiNum = (s) => +String(s).replace(/[ ,.\u202f\u00a0]/g, "");
  const TI_SIZES = [[/\b(incursion|combat patrol)\b/i, 1000], [/\b(strike ?force|force de frappe|einsatzverband|fuerza de (?:choque|asalto)|forza d'attacco)\b/i, 2000], [/\b(onslaught|assaut|ansturm|embestida|arrollador)\b/i, 3000]];

  const _tiLex = new WeakMap();
  function tiLexicon(idx) {
    if (_tiLex.has(idx)) return _tiLex.get(idx);
    const L = { units: new Map(), dets: [], enh: new Map(), fds: [], aliases: [], perF: {} };
    const push = (m, k, v) => { if (!k) return; const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
    for (const fid of Object.keys(idx.factions)) {
      const F = idx.factions[fid]; const P = (L.perF[fid] = { units: [], ck: new Map(), enh: new Map() });
      for (const u of F.f.units) {
        const ck = tiCk(u.n); const rec = { fid, u, ck, key: tiKey(u.n) };
        P.units.push(rec); if (!P.ck.has(ck)) P.ck.set(ck, u);
        push(L.units, ck, rec);
      }
      for (const d of F.f.dets) {
        L.dets.push({ fid, d, ck: tiCk(d.n) });
        for (const en of d.enh || []) { const v = { fid, det: d.n, en }; const k1 = tiCk(en[0]), k2 = tiCk(String(en[0]).replace(/\s*\([^)]*\)/g, ""));
          push(L.enh, k1, v); push(P.enh, k1, v); if (k2 !== k1) { push(L.enh, k2, v); push(P.enh, k2, v); } }
        for (const fd of d.fd || []) if (!L.fds.some((x) => x.v === fd)) L.fds.push({ v: fd, ck: tiCk(fd) });
      }
    }
    L.dets.sort((a, b) => b.ck.length - a.ck.length);
    for (const g of idx.data.groups || []) for (const s of g.factions) if (idx.factions[s.data])
      L.aliases.push({ ck: tiCk(s.name), fid: s.data, sub: s.id, rank: s.data !== s.id ? 3 : s.id === "space-marines" ? 1 : 2 });
    for (const f of idx.data.factions || []) if (!L.aliases.some((a) => a.sub === f.id)) L.aliases.push({ ck: tiCk(f.name), fid: f.id, sub: f.id, rank: 2 });
    for (const [n, fid, rank] of TI_FACTION_ALIAS) if (idx.factions[fid]) L.aliases.push({ ck: tiCk(n), fid, sub: fid, rank });
    _tiLex.set(idx, L); return L;
  }
  /* "Death Guard Rhino" / "World Eaters Terminator Champion" (the GW app prefixes shared datasheets) -> "Rhino" */
  function tiStripFaction(L, name) {
    const words = tiKey(name).split(" ");
    for (let k = Math.min(3, words.length - 1); k >= 1; k--) { const pre = words.slice(0, k).join(""); if (L.aliases.some((a) => a.ck === pre)) return words.slice(k).join(" "); }
    return null;
  }
  /* best datasheet for a name in faction fid: {u, status: "ok"|"alias"|"guessed", score, alts} or null */
  function tiMatchUnit(L, fid, name, strict) {
    const P = L.perF[fid]; if (!P || !name) return null;
    const clean = String(name).replace(/\s*\[legends\]|\s*\(legends\)/ig, "").trim();
    const ck = tiCk(clean); if (!ck) return null;
    if (P.ck.has(ck)) return { u: P.ck.get(ck), status: "ok", score: 1 };
    for (const v of [ck + "squad", ck.replace(/squad$/, ""), ck.replace(/^the/, ""), ck + "s", ck.replace(/unit$/, "")]) if (v && P.ck.has(v)) return { u: P.ck.get(v), status: "ok", score: 1 };
    const sf = tiStripFaction(L, clean); if (sf && sf !== tiKey(clean)) { const r = tiMatchUnit(L, fid, sf, strict); if (r) return r; }
    const al = tiAliasMap()[tiKey(clean)]; if (al && P.ck.has(tiCk(al))) return { u: P.ck.get(tiCk(al)), status: "alias", score: 0.99 };
    if (strict === "exact") return null;
    // custom names / shortened names: "Archon Gheislein De Wiart" -> Archon, "Eradicator Squad" -> Eradicator Squad with Melta Rifles
    const words = tiKey(clean).split(" ");
    if (!strict) for (let k = words.length - 1; k >= 1; k--) { const pre = words.slice(0, k).join(""); if (pre.length >= 4 && P.ck.has(pre)) return { u: P.ck.get(pre), status: "guessed", score: 0.8, alts: [] }; }
    let pref = P.units.filter((r) => r.ck.startsWith(ck) && ck.length >= 6);
    if (!pref.length && !strict && words[0].length >= 6) pref = P.units.filter((r) => r.key.split(" ")[0] === words[0]).sort((a, b) => tiSim(clean, b.u.n) - tiSim(clean, a.u.n));
    if (pref.length) return { u: pref[0].u, status: "guessed", score: 0.8, alts: pref.slice(1, 6).map((r) => r.u.n) };
    const sc = P.units.map((r) => ({ u: r.u, s: tiSim(clean, r.u.n) })).sort((a, b) => b.s - a.s);
    const best = sc[0];
    const th = strict ? 0.86 : 0.74;
    if (best && best.s >= th) return { u: best.u, status: "guessed", score: +best.s.toFixed(2), alts: sc.slice(1, 6).filter((x) => x.s > 0.5).map((x) => x.u.n) };
    return null;
  }
  function tiCandidates(L, fid, name, n) {
    const P = L.perF[fid]; if (!P) return [];
    return P.units.map((r) => ({ n: r.u.n, s: tiSim(name, r.u.n) })).sort((a, b) => b.s - a.s).slice(0, n || 6).filter((x) => x.s > 0.3).map((x) => x.n);
  }
  /* faction keyword lines: every alias hit [{fid, sub, rank, at}] */
  function tiFactionHits(L, text, at) {
    const out = []; const segs = new Set([text]);
    for (const s of String(text).split(/\s+-\s+|[,:;/()|]|\s+[–—]\s+|\s+and\s+/i)) if (s.trim()) segs.add(s.trim());
    for (const s of segs) { const ck = tiCk(s); if (!ck) continue; for (const a of L.aliases) if (a.ck === ck) out.push({ ...a, at }); }
    return out;
  }
  /* detachment names inside a line (longest first, consumed): {found:[{fid,d}], rest} */
  function tiFindDets(L, text, fid) {
    let ck = tiCk(text); const found = [];
    for (const r of L.dets) { if (fid && r.fid !== fid) continue; if (r.ck.length < 5) continue; const i = ck.indexOf(r.ck); if (i >= 0) { found.push({ fid: r.fid, d: r.d, pos: i }); ck = ck.slice(0, i) + "|" + ck.slice(i + r.ck.length); } }
    found.sort((a, b) => a.pos - b.pos);
    return { found, rest: ck.replace(/\|/g, "") };
  }
  /* "Char3: 10x Name (120 pts): gear, gear" / "Name [85 pts]: gear" / "3x10 Repentia" / "Name - Enh - 120pts" */
  function tiUnitLine(text) {
    let t = String(text).trim(); const o = { tag: null, count: null, copies: 1, pts: null, name: "", gear: [], warlord: false };
    let m = t.match(/^([A-Z][A-Za-z]{1,5}\d+)\s*:\s*/); if (m) { o.tag = m[1]; t = t.slice(m[0].length); }
    if (/\[warlord\]/i.test(t)) { o.warlord = true; t = t.replace(/\s*\[warlord\]/ig, ""); }
    m = t.match(/^(\d+)\s*[x×]\s*(\d+)\s+(?=\D)/i); if (m) { o.copies = +m[1]; o.count = +m[2]; t = t.slice(m[0].length); }
    else { m = t.match(/^(\d+)\s*[x×]\s*/i) || t.match(/^(\d+)\s+(?=[A-Za-z])/); if (m && +m[1] > 0 && +m[1] < 100) { o.count = +m[1]; t = t.slice(m[0].length); } }
    let rest = "";
    m = t.match(TI_PTS);
    if (m) { o.pts = tiNum(m[1]); rest = t.slice(m.index + m[0].length); t = t.slice(0, m.index); }
    else { m = t.match(TI_PTS_TAIL); if (m) { o.pts = +m[1]; t = t.slice(0, m.index); } }
    rest = rest.replace(/^\s*[:,-]\s*/, "").trim();
    if (rest) o.gear.push(...tiSplitGear(rest));
    t = t.trim().replace(/[.:,;-]+$/, "").trim();
    if (o.count == null) { m = t.match(/^(.+?)\s*(?:\((\d{1,2})\)|\s[x×]\s?(\d{1,2}))$/i); if (m && +(m[2] || m[3]) > 0) { o.count = +(m[2] || m[3]); t = m[1]; } } // "Skorpekh Destroyers (6)"
    const segs = t.split(/\s+-\s+/); o.name = segs.shift().trim();
    for (const s of segs) if (s.trim()) o.gear.push(...tiSplitGear(s));
    return o;
  }
  function tiSplitGear(s) {
    const out = []; let depth = 0, cur = "";
    for (const ch of String(s)) { if (ch === "(" || ch === "[") depth++; if (ch === ")" || ch === "]") depth--; if ((ch === "," || ch === ";") && depth <= 0) { out.push(cur); cur = ""; } else cur += ch; }
    out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
  }
  /* "2x Bolt rifle" / "2 Storm Bolters" -> {n, name} */
  function tiCountName(s) {
    const m = String(s).trim().match(/^(\d+)\s*[x×]?\s+(.+)$/i) || String(s).trim().match(/^(\d+)[x×](.+)$/i);
    if (m) return { n: +m[1], name: m[2].trim(), explicit: true };
    const t = String(s).trim().match(/^(.+?)\s*(?:\((\d{1,2})\)|\s[x×]\s?(\d{1,2}))$/i); // "Skorpekh Destroyers (6)" / "Warriors x20"
    if (t) return { n: +(t[2] || t[3]), name: t[1].trim(), explicit: true };
    return { n: 1, name: String(s).trim(), explicit: false };
  }
  function tiNormText(text) {
    return String(text || "").replace(/\r\n?/g, "\n").replace(/[\u00a0\u2007\u202f]/g, " ").replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/[\u2010-\u2015\u2212]/g, (c) => (c === "\u2013" || c === "\u2014" ? " - " : "-")).replace(/[’‘`´]/g, "'").replace(/[“”„]/g, '"').replace(/×/g, "x")
      .replace(/\*\*|__/g, "").replace(/ {2,}- {2,}/g, " - ");
  }
  function tiDetectFormat(t) {
    if (/^\s*[{[]/.test(t)) return "json";
    if (/#\/share\//.test(t)) return "share";
    if (/Exported with Muster/i.test(t)) return "muster";
    if (/^\s*#\s*\+\+\s*Army Roster/im.test(t) || /^##\s*Configuration/im.test(t)) return "nr-simple";
    if (/^\s*\+\+\s*Army Roster/im.test(t) || /Created with BattleScribe/i.test(t) || /^\+ Configuration \+/m.test(t)) return "battlescribe";
    if (/^\s*\+\s*FACTION KEYWORD:/im.test(t) || /^\+{10,}/m.test(t) && /^\s*\d+ with /m.test(t)) return /^\s*\d+ with /m.test(t) ? "wtc-full" :
      /^\s*(?:[A-Z][a-z]{2,4}\d+:\s*)?\d+x .+\(\d+ pts\)/m.test(t) || !/^\s*•/m.test(t) ? "wtc" : "wtc-gw";
    if (/Exported with New Recruit/i.test(t)) return "nr-gw";
    if (/Exported with App Version|Export[ée]e? avec la Version|Exportiert mit App|Exportada con la versi[oó]n/i.test(t) || /\(\d+\s*(Detachment Points|Points de D[ée]tachement|Kontingentspunkte|puntos de destacamento)\)/i.test(t) || /Attached as\s*:/i.test(t)) return "gw";
    if (/Factions Used:|FACTION KEYWORD:|Detachment\(s\):/i.test(t)) return "tournament";
    if (/^.* - .+\(\d[\d,. ]*\s*Points?\)\s*$/im.test(t.split("\n").find((x) => x.trim()) || "") || /^Attached Units:\s*$/im.test(t) || /^\s+• E: /m.test(t)) return "listforge";
    if (/^(?:Muster|Faction:\s)/m.test(t) && /^Detachments:/m.test(t)) return "muster";
    return "freeform";
  }
  function tiLineInfo(raw) {
    const ind = (raw.match(/^[\t ]*/)[0] || "").replace(/\t/g, "    ").length;
    let t = raw.trim(); let bullet = "";
    const hm = t.match(/^(#{1,6})\s+/); let hashes = 0; if (hm) { hashes = hm[1].length; t = t.slice(hm[0].length); }
    const bm = t.match(/^([•◦▪●○‣∙·*]|-(?=\s)|\.{1,3}(?=\s)|>)\s*/);
    if (bm) { bullet = bm[1]; t = t.slice(bm[0].length).trim(); }
    return { raw, ind, bullet, hashes, text: t };
  }
  const TI_FORMAT_NAMES = { json: "Muster JSON", share: "Muster share link", muster: "Muster text export", "nr-simple": "New Recruit (simple)", battlescribe: "BattleScribe text",
    wtc: "WTC compact (New Recruit / ListForge)", "wtc-gw": "WTC header + GW-app body (New Recruit / ListForge)", "wtc-full": "WTC full (New Recruit / ListForge)", "nr-gw": "New Recruit (GW app style)", gw: "Warhammer 40,000 app",
    listforge: "ListForge text", tournament: "Tournament template", freeform: "Free-form text" };

  /* pre-scan: header facts + the faction (stated, or detected from detachment and unit names) */
  function tiPickFaction(L, idx, lines, opts) {
    if (opts && opts.faction) { const s = idx.subs[opts.faction]; return { fid: s ? s.data : opts.faction, sub: opts.faction, how: "chosen" }; }
    const hits = [];
    lines.forEach((ln, i) => {
      const t = ln.text; if (!t) return;
      const key = t.match(/^\+?\s*(faction keyword|factions? used|faction|army roster|army|fraktion|facci[oó]n)\s*:\s*(.+)$/i);
      if (key) { hits.push(...tiFactionHits(L, key[2], i).map((h) => ({ ...h, w: 3 }))); return; }
      const ar = t.match(/army roster\s*\(([^)]+)\)/i); if (ar) { hits.push(...tiFactionHits(L, ar[1], i).map((h) => ({ ...h, w: 3 }))); return; }
      if (i < 25 && !TI_PTS.test(t.replace(/\(\d[\d,. ]*\s*(points?|punkte|puntos)\)\s*$/i, "")) && !ln.bullet) hits.push(...tiFactionHits(L, t, i).map((h) => ({ ...h, w: 1 })));
    });
    // detachment + unit votes
    const vote = {}, uniq = {}; let exact = 0;
    const add = (fid, v) => { vote[fid] = (vote[fid] || 0) + v; };
    lines.forEach((ln, i) => {
      const t = ln.text; if (!t) return;
      if (i < 30 && !ln.bullet) for (const f of tiFindDets(L, t).found) { const same = L.dets.filter((r) => r.ck === tiCk(f.d.n)); for (const r of same) add(r.fid, 2 / same.length); if (same.length === 1) uniq[f.fid] = (uniq[f.fid] || 0) + 1; }
      const u = tiUnitLine(t); if (!u.name || ln.bullet && u.pts == null) return;
      const recs = L.units.get(tiCk(u.name)) || L.units.get(tiCk(u.name) + "squad") || [];
      const own = recs.filter((r) => !r.u.af);
      const use = own.length ? own : recs;
      for (const r of use) add(r.fid, (own.length ? 1 : 0.25) / use.length);
      if (own.length === 1) uniq[own[0].fid] = (uniq[own[0].fid] || 0) + 1;
      if (recs.length) exact++;
    });
    if (exact < 2 && !hits.length) {   // loose free-form text: fuzzy-match every line against every faction
      lines.forEach((ln) => { const u = tiUnitLine(ln.text); if (!u.name || u.name.length < 4) return;
        for (const f of Object.keys(L.perF)) { const m = tiMatchUnit(L, f, u.name, false); if (m && !m.u.af) add(f, m.score); } });
    }
    if (hits.length) {
      const top = Math.max(...hits.map((h) => h.rank));
      const best = hits.filter((h) => h.rank === top).sort((a, b) => b.w - a.w || (vote[b.fid] || 0) - (vote[a.fid] || 0) || b.at - a.at)[0];
      return { fid: best.fid, sub: best.sub, how: "stated", vote };
    }
    // most units found only in that faction first (Black Templars also carries every generic Space Marine datasheet), then the overall vote
    const ranked = Object.entries(vote).sort((a, b) => (2 * (uniq[b[0]] || 0) + b[1]) - (2 * (uniq[a[0]] || 0) + a[1]) || (a[0] === "space-marines" ? -1 : b[0] === "space-marines" ? 1 : 0));
    if (!ranked.length) return { fid: null, sub: null, how: "none", vote };
    return { fid: ranked[0][0], sub: ranked[0][0], how: "detected", vote };
  }

  function parseListText(text, idx, ds, opts) {
    opts = opts || {};
    const norm0 = tiNormText(text);
    const format = tiDetectFormat(norm0);
    const L = tiLexicon(idx);
    const lines = norm0.split("\n").map(tiLineInfo);
    const fp = tiPickFaction(L, idx, lines, opts);
    const fid = fp.fid; const F = fid ? idx.factions[fid] : null;
    const dsF = ds && ds.factions && fid ? ds.factions[fid] : null;
    const P = { format, formatName: TI_FORMAT_NAMES[format] || format, faction: fid, sub: fp.sub || fid, factionHow: fp.how, vote: fp.vote,
      name: null, statedTotal: null, size: null, sizeText: null, dets: [], detsUnmatched: [], disposition: null, dispositionText: null,
      items: [], lines: [], hints: { warlord: null, enh: [] }, text: String(text || "") };
    if (!F) { P.lines = lines.filter((l) => l.text).map((l) => ({ text: l.text, kind: "unrecognised" })); return P; }
    let cur = null, group = null, inHeader = true, sawUnit = false, lastModel = null;
    const vocabCache = new WeakMap();
    const vocab = (u) => {
      if (!u) return new Set(); if (vocabCache.has(u)) return vocabCache.get(u);
      const s = new Set(); const add = (n) => { const k = tiCk(n); if (k) s.add(k); };
      add(u.n); const M = loModel(u);
      if (M) for (const t of M.types) { add(t.name); t.fixed.forEach(add); for (const sl of t.slots) sl.opts.forEach((o) => add(o.name)); }
      if (M) for (const sl of M.unit) sl.opts.forEach((o) => add(o.name));
      for (const w of u.w || []) add(w[0]);
      const d = dsF && dsF.units && dsF.units[u.n];
      if (d) { (d.wp || []).forEach((w) => add(w[0])); (d.wa || []).forEach((a) => { add(a[0]); add(a[1]); }); (d.ml || []).forEach((m) => add(m[0])); }
      vocabCache.set(u, s); return s;
    };
    const inVocab = (u, name) => { const V = vocab(u); const c = tiCk(tiCountName(name).name.replace(/:.*$/, "")); return !!c && (V.has(c) || [...V].some((v) => v.length > 5 && (v === c + "s" || c === v + "s"))); };
    const addLine = (ln, kind, extra) => P.lines.push({ text: ln.text, kind, ...(extra || {}) });
    const newUnit = (ln, u, m, how) => {
      const it = { kind: "unit", text: ln.text, name: u.name, tag: u.tag, count: u.count, copies: u.copies, pts: u.pts, match: m ? m.u.n : null,
        status: m ? m.status : "unmatched", score: m ? m.score : 0, alts: m && m.alts ? m.alts : (!m ? tiCandidates(L, fid, u.name) : []),
        subs: [], gear: [], models: [], enh: null, warlord: u.warlord, attachRole: null, attachTo: null, leading: null, group: group ? group.id : null,
        include: true, how, line: P.items.length, unitRef: m ? m.u : null };
      for (const g of u.gear) it.gear.push({ text: g, owner: null });
      P.items.push(it); cur = it; lastModel = null; sawUnit = true; inHeader = false;
      if (group) group.members.push(it);
      return it;
    };
    let gid = 0;
    const header = (ln) => {
      const t = ln.text;
      let m = t.match(/^\+?\s*([A-Za-z][A-Za-z ()']*?)\s*:\s*(.*)$/);
      const key = m ? m[1].toLowerCase().trim().replace(/\s+used$/, "") : "";
      const val = m ? m[2].trim() : "";
      if (m && cur && !/^\+/.test(t) && !/^(faction keyword|factions?|detachments?|detachment\(s\)|force dispositions?|disposition|battle size|list name)$/.test(key)) return false;
      if (m && /^(list name|name|player name|team name|nom|army name)$/.test(key)) { if (/^(list name|army name|name|nom)$/.test(key) && val && !/^[—-]$/.test(val) && (key === "list name" || !P.name)) P.name = val; addLine(ln, "header"); return true; }
      if (m && /^(faction keyword|factions? used|faction|fraktion|facci[oó]n)$/.test(key)) { addLine(ln, "header"); return true; }
      if (m && /^(detachments?|detachment\(s\)|detachment choice|kontingent|d[ée]tachements?|destacamentos?)$/.test(key)) { tiHeaderDets(P, L, fid, val.replace(/\[\d+\/\d+ DP\]|\(\d+ DP\)/g, " ")); addLine(ln, "header"); return true; }
      if (m && /^(force dispositions?|disposition|force disposition)$/.test(key)) { tiHeaderDisp(P, L, val); addLine(ln, "header"); return true; }
      if (m && /^(total army points|army points|points|total)$/.test(key)) { const n = val.match(/\d[\d,. ]*/); if (n && P.statedTotal == null) P.statedTotal = tiNum(n[0]); addLine(ln, "header"); return true; }
      if (m && /^(points limit|battle size)$/.test(key)) { tiHeaderSize(P, idx, val); addLine(ln, "header"); return true; }
      if (m && /^warlord$/.test(key)) { const w = tiUnitLine(val); P.hints.warlord = { tag: w.tag, name: w.name }; addLine(ln, "header"); return true; }
      if (m && /^(enhancements?|army enhancements.*)$/.test(key) && !/^\d+(\/\d+)?$/.test(val)) { tiHeaderEnh(P, val); addLine(ln, "header"); return true; }
      if (m && /^(number of units|secondary|secondaries|show legends|enhancements|game type|edition)$/.test(key)) { addLine(ln, "header"); return true; }
      if (/^&\s*/.test(t) && !sawUnit) { tiHeaderEnh(P, t.replace(/^&\s*/, "")); addLine(ln, "header"); return true; }
      if (/army roster/i.test(t) || /^\++ .*\++$/.test(t) || /new roster/i.test(t)) { const n = t.match(TI_PTS); if (n && P.statedTotal == null) P.statedTotal = tiNum(n[1]); addLine(ln, "header"); return true; }
      return false;
    };
    const headerZone = (ln, first) => {
      const t = ln.text;
      // det line "A and B (3 Detachment Points)"
      if (/\(\s*\d+\s*(detachment points?|points? de d[ée]tachement|kontingentspunkte|puntos de destacamento|dp)\s*\)/i.test(t)) { tiHeaderDets(P, L, fid, t.replace(/\([^)]*\)/g, " ")); addLine(ln, "header"); return true; }
      // battle size "Strike Force (2,000 Points)"
      const sz = TI_SIZES.find((s) => s[0].test(t));
      if (sz && t.length < 60 && !/ - .* - /.test(t)) { tiHeaderSize(P, idx, t); addLine(ln, "header"); return true; }
      // New Recruit simple: "<faction> - <list name> - [2000 pts]"
      const nr = t.match(/^(.+?)\s+-\s+(.+?)\s+-\s+\[\s*(\d[\d,. ]*)\s*pts?\s*\]\s*$/i);
      if (nr && first) { P.name = P.name || nr[2].trim(); tiHeaderSize(P, idx, nr[3]); addLine(ln, "header"); return true; }
      // list name / ListForge header "name - faction - [disposition -] dets (N Points)"
      const pm = t.match(/^(.*?)\s*\(\s*(\d[\d,. ]*)\s*(?:\/\s*\d[\d,. ]*\s*)?(points?|pts|punkte|puntos)\s*\)\s*$/i);
      if (pm && !sawUnit && !tiMatchUnit(L, fid, pm[1].replace(/^\s*-\s*/, "").split(/\s+-\s+/)[0], "exact") && (first || P.name == null && P.statedTotal == null)) {
        if (P.statedTotal == null) P.statedTotal = tiNum(pm[2]);
        const segs = pm[1].split(/\s+-\s+/);
        if (segs.length >= 3 || /^\s*-/.test(pm[1])) { const s2 = pm[1].replace(/^\s*-\s*/, "").split(/\s+-\s+/); if (/^\s*-/.test(pm[1])) s2.unshift("");
          P.name = s2[0] || P.name; tiHeaderDets(P, L, fid, s2[s2.length - 1]); for (const x of s2.slice(2, -1)) tiHeaderDisp(P, L, x); }
        else P.name = P.name || pm[1].trim();
        addLine(ln, "header"); return true;
      }
      if (tiFactionHits(L, t, 0).length && t.length < 60) {
        // "Custodes - Shield Host" / "My list - Necrons - Awakened Dynasty": the other segments are dets / disposition / name
        const segs = t.split(/\s+[-–—|]\s+/).map((x) => x.trim()).filter(Boolean);
        if (segs.length > 1) segs.forEach((x, k) => {
          if (L.aliases.some((a) => a.ck === tiCk(x))) return;
          if (L.fds.some((f) => f.ck === tiCk(x))) { tiHeaderDisp(P, L, x); return; }
          if (tiFindDets(L, x, fid).found.length || k === segs.length - 1) { tiHeaderDets(P, L, fid, x); return; }
          if (P.name == null) P.name = x;
        });
        addLine(ln, "header"); return true;
      }
      if (L.fds.some((f) => f.ck === tiCk(t)) || /^force dispositions?\s*:/i.test(t)) { tiHeaderDisp(P, L, t.replace(/^force dispositions?\s*:/i, "")); addLine(ln, "header"); return true; }
      const fd = tiFindDets(L, t, fid);
      if (fd.found.length && fd.rest.replace(/and|et|und|y/g, "").length < 6) { tiHeaderDets(P, L, fid, t); addLine(ln, "header"); return true; }
      return false;
    };
    let firstText = true;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]; const t = ln.text;
      if (!t) continue;
      const first = firstText; firstText = false;
      if (/^\+{3,}$/.test(t) || t === "+" || /^[=\-_~]{3,}$/.test(t)) { addLine(ln, "structure"); continue; }
      if (TI_FOOTER.test(t)) { addLine(ln, "footer"); continue; }
      if (!ln.bullet && header(ln)) continue;
      if (!ln.bullet && (inHeader || !cur) && headerZone(ln, first)) continue;
      // sections / attached groups
      const plain = t.replace(/\s*[[(]\s*\d[\d,. ]*\s*(pts?|points?)\s*[\])]\s*$/i, "").replace(/^\+\s*|\s*\+$/g, "").replace(/:$/, "").trim();
      if (!ln.bullet && TI_SECTIONS.test(plain)) { if (!/attached|attach|angeschlossene|adjunta|anexada/i.test(plain)) group = null; cur = null; inHeader = false; addLine(ln, "section"); continue; }
      if (!ln.bullet && TI_GROUP.test(plain)) { group = { id: ++gid, members: [] }; cur = null; addLine(ln, "section"); continue; }
      // ListForge "Leader + Bodyguard (275 pts)" group marker
      if (!ln.bullet && / \+ /.test(t)) { const u0 = tiUnitLine(t); const parts = u0.name.split(/\s+\+\s+/); if (parts.length > 1 && parts.every((p) => tiMatchUnit(L, fid, p, true))) { group = { id: ++gid, members: [], lf: true }; cur = null; addLine(ln, "section"); continue; } }
      // sub-lines of the current unit
      const sub = cur && tiSubLine(P, L, fid, cur, ln, inVocab);
      if (sub === true) continue;
      const u = tiUnitLine(t);
      const looksUnit = u.name && (u.pts != null || u.count != null || !cur || format === "freeform");
      if (!ln.bullet || !cur || (u.pts != null && !inVocab(cur.match && F.units[cur.match], u.name))) {
        if (looksUnit && (!ln.bullet && u.pts != null || !(cur && inVocab(cur.match && F.units[cur.match], u.name)))) {
          // free-form "A attached to B" / "A leading B" / "A and B with N C"
          const fr = format === "freeform" || format === "tournament" ? tiFreeform(P, L, fid, ln, u, newUnit) : false;
          if (fr) continue;
          const exactFull = tiMatchUnit(L, fid, u.name, "exact");
          const m = exactFull || (/\s(with|w\/|w\.)\s/i.test(u.name) && tiSplitWith(L, fid, u, "exact")) || tiMatchUnit(L, fid, u.name, u.pts == null && u.count == null ? "strict" : false) || tiSplitWith(L, fid, u);
          if (m || u.pts != null) { if (group && group.lf && ln.ind === 0 && group.members.length >= 2) group = null; newUnit(ln, u, m, "line"); continue; }
        }
      }
      if (cur) { tiSubLine(P, L, fid, cur, ln, inVocab, true); continue; }
      addLine(ln, inHeader ? "unrecognised-header" : "unrecognised");
    }
    tiResolveItems(P, idx, L, F, dsF);
    return P;
  }
  function tiHeaderDets(P, L, fid, text) {
    const r = tiFindDets(L, text, fid);
    for (const f of r.found) if (!P.dets.includes(f.d.n)) P.dets.push(f.d.n);
    // leftovers that look like names (another faction's detachment, a typo, a translation)
    const left = String(text).split(/,|\s+and\s+|\s+et\s+|\s+und\s+|\s+y\s+|&/i).map((x) => x.replace(/\([^)]*\)/g, "").trim()).filter((x) => x && !r.found.some((f) => tiCk(f.d.n) === tiCk(x)) && tiCk(x).length > 3 && !r.found.some((f) => tiCk(x).includes(tiCk(f.d.n))));
    for (const x of left) { const best = L.dets.filter((d) => d.fid === fid).map((d) => ({ d: d.d, s: tiSim(x, d.d.n) })).sort((a, b) => b.s - a.s)[0];
      if (best && best.s >= 0.8 && !P.dets.includes(best.d.n)) { P.dets.push(best.d.n); P.detsGuessed = (P.detsGuessed || []).concat([[x, best.d.n]]); } else if (!(best && P.dets.includes(best.d.n) && best.s >= 0.8)) P.detsUnmatched.push(x); }
  }
  function tiHeaderDisp(P, L, text) {
    for (const part of String(text).split(/,|\//)) { const ck = tiCk(part); if (!ck) continue; const f = L.fds.find((x) => x.ck === ck) || L.fds.map((x) => ({ ...x, s: tiSim(part, x.v) })).filter((x) => x.s > 0.85).sort((a, b) => b.s - a.s)[0];
      if (f) { if (!P.disposition) P.disposition = f.v; else (P.dispositionsExtra = P.dispositionsExtra || []).push(f.v); } else P.dispositionText = (P.dispositionText ? P.dispositionText + ", " : "") + part.trim(); }
  }
  function tiHeaderSize(P, idx, text) {
    P.sizeText = String(text).trim();
    const n = String(text).match(/(\d[\d,. ]{2,})/); const pts = n ? tiNum(n[1]) : null;
    const byName = TI_SIZES.find((s) => s[0].test(text));
    const want = byName ? byName[1] : pts;
    const s = (idx.data.battle_sizes || []).find((x) => x.points === want) || (pts && (idx.data.battle_sizes || []).find((x) => x.points >= pts));
    if (s) P.size = s.id;
  }
  function tiHeaderEnh(P, text) {
    for (const part of String(text).split(/;|\),\s*|\s&\s/)) { const m = part.match(/^\s*(.+?)\s*\(\s*(?:on\s+)?(?:([A-Z][A-Za-z]{1,5}\d*)\s*:\s*)?(.+?)\)?\s*$/i);
      if (m) P.hints.enh.push({ name: m[1].replace(/\(\+?\d+\s*pts?\)/i, "").trim(), tag: m[2] && /\d/.test(m[2]) ? m[2] : null, unit: m[3].trim() }); }
  }
  /* "Canoness with the Catechism attached to 10 Sacresants", "Triumph and Hospitaller attached to a Battle Sisters squad" */
  function tiFreeform(P, L, fid, ln, u, newUnit) {
    const t = ln.text.replace(/\.$/, "");
    const m = t.match(/^(.+?)\s+(attached to|leading|joining|joined to|with)\s+(.+)$/i);
    if (!m) return false;
    const leftNames = m[1].split(/\s*(?:,|\+|\band\b|&)\s*/i).map((x) => x.trim()).filter(Boolean);
    const leftU = leftNames.map((n) => ({ n, lu: tiUnitLine(n) })).map((x) => ({ ...x, m: tiMatchUnit(L, fid, x.lu.name, "strict") }));
    if (!leftU.length || !leftU.every((x) => x.m)) return false;
    let right = m[3].replace(/^(a|an|the|one)\s+/i, "");
    const ru = tiUnitLine(right); const rm = tiMatchUnit(L, fid, ru.name, "strict");
    if (/^with$/i.test(m[2])) {
      if (rm && ru.count) { // "Priest with 10 Arco-flagellants": the left units lead the right unit
        const body = newUnit({ text: right }, ru, rm, "freeform"); for (const x of leftU) { const it = newUnit({ text: x.n }, x.lu, x.m, "freeform"); it.attachToItem = body; }
        P.lines.push({ text: ln.text, kind: "freeform" }); return true;
      }
      if (leftU.length === 1) { const it = newUnit({ text: ln.text }, leftU[0].lu, leftU[0].m, "freeform"); const pt = m[3].match(TI_PTS_TAIL); if (pt && it.pts == null) it.pts = +pt[1]; it.gear.push({ text: m[3].replace(TI_PTS_TAIL, "").trim(), owner: null }); P.lines.push({ text: ln.text, kind: "freeform" }); return true; }
      return false;
    }
    if (!rm) return false;
    // "Royal Warden attached to Necron Warriors": an already-listed unit of that name is the bodyguard
    const taken = new Set(P.items.map((x) => x.attachToItem).filter(Boolean));
    const prior = ru.count == null && ru.pts == null ? P.items.filter((x) => x.match === rm.u.n && !x.attachToItem && !taken.has(x)).pop() : null;
    const body = prior || newUnit({ text: right }, ru, rm, "freeform");
    for (const x of leftU) { const it = newUnit({ text: x.n }, x.lu, x.m, "freeform"); it.attachToItem = body; }
    P.lines.push({ text: ln.text, kind: "freeform" });
    return true;
  }
  /* "Shield-Captain w/ Admonimortis" / "Shield-Captain with Praesidius" -> unit + gear/enhancement */
  function tiSplitWith(L, fid, u, mode) {
    const m = String(u.name).match(/^(.+?)\s+(?:with|w\/|w\.)\s+(.+)$/i); if (!m) return null;
    const r = tiMatchUnit(L, fid, m[1], mode || (u.pts == null && u.count == null ? "strict" : false)); if (!r) return null;
    u.name = m[1]; u.gear.unshift(m[2].replace(TI_PTS_TAIL, "").trim()); return r;
  }
  /* bullet / continuation lines under a unit; returns true when consumed */
  function tiSubLine(P, L, fid, cur, ln, inVocab, force) {
    let t = ln.text;
    const U = cur.match ? null : null; void U;
    if (TI_WARLORD.test(t)) { cur.warlord = true; cur.subs.push({ text: t, kind: "warlord" }); return true; }
    let m = t.match(TI_ATTACHED_AS);
    if (m) { const r = m[2]; cur.attachRole = /bodyguard|garde|leibw|guardaespaldas|escolta/i.test(r) ? "bodyguard" : /support|soutien|unterst|apoyo/i.test(r) ? "support" : /leader|meneur|anf[üu]hrer|l[ií]der|lider/i.test(r) ? "leader" : r ? "other" : "bodyguard"; cur.subs.push({ text: t, kind: "attach" }); return true; }
    m = t.match(/^(attached to|leading|joined to|joining)\s*:?\s*(.+?)\s*(?:\[(\d+)\]|#(\d+))?\s*(\((?:support|joined|leader)\))?$/i);
    if (m) { const ref = { name: m[2].trim(), n: +(m[3] || m[4] || 0) || null };
      if (/^attached|^joined/i.test(m[1])) cur.attachTo = ref; else cur.leading = (cur.leading || []).concat([ref]); cur.subs.push({ text: t, kind: "attach" }); return true; }
    if (/^(imported, not matched|enhancement not applied)\s*:/i.test(t)) { cur.notes = (cur.notes || []).concat([t]); cur.subs.push({ text: t, kind: "note" }); return true; }
    if (/^led by\s*:/i.test(t)) { cur.subs.push({ text: t, kind: "attach" }); return true; }
    m = t.match(TI_ENH);
    if (m && !/^upgrades?$/i.test(m[1]) || m && /^upgrades?$/i.test(m[1])) { cur.enhText = m[2].replace(/\s*\((?:\+?\d+\s*pts?|upgrade|am[ée]lioration|mejora|verbesserung)\)\s*/ig, "").trim(); cur.subs.push({ text: t, kind: "enh" }); return true; }
    m = t.match(/^mark of chaos\s*:\s*(.+)$/i); if (m) { cur.markText = m[1].trim(); cur.subs.push({ text: t, kind: "mark" }); return true; }
    // WTC full "6 with Close combat weapon, Gauss cannon"
    m = t.match(/^(\d+)\s+with\s+(.+?)(?:\s+\(([^)]+)\))?$/i);
    if (m) { const mod = { n: +m[1], name: m[3] || null, gear: [] }; cur.models.push(mod); cur.withN = (cur.withN || 0) + mod.n;
      for (const g of tiSplitGear(m[2])) cur.gear.push({ text: g, owner: mod, per: mod.n }); cur.subs.push({ text: t, kind: "models" }); return true; }
    if (!ln.bullet && !force) {
      // an unbulleted line is a sub-line only if it does not look like a unit of its own
      const u = tiUnitLine(t);
      if (u.pts != null) return false;
      if (!inVocab(cur.unitRef, t) && tiMatchUnit(L, fid, u.name, "exact")) return false;
      if (!cur.lastBullet && !inVocab(cur.unitRef, t)) return false;
    }
    if (ln.bullet) cur.lastBullet = ln;
    // "1x Model: gear, gear" (NR simple / BattleScribe) or "Nx Name" model/gear lines
    const [head, tail] = (() => { const k = t.indexOf(":"); return k > 0 && !/^https?/i.test(t) ? [t.slice(0, k), t.slice(k + 1)] : [t, null]; })();
    const items = tail != null ? [head] : tiSplitGear(t);
    for (const raw of items) {
      const cn = tiCountName(raw.replace(/\s*\[\s*\+?\d+\s*pts?\s*\]\s*$/i, "").replace(/\s*\(\s*\+?\d+\s*pts?\s*\)\s*$/i, ""));
      if (TI_WARLORD.test(cn.name)) { cur.warlord = true; continue; }
      if (/^(\w+\s+)*character$|^epic hero$/i.test(cn.name)) continue;
      const deeper = ln.bullet === "◦" || ln.bullet === ".." || ln.ind > (cur.modelInd != null ? cur.modelInd : 0) && cur.lastModel && ln.ind > 0;
      cur.gear.push({ text: raw, cn, ln: { bullet: ln.bullet, ind: ln.ind }, deeper, tail: tail != null ? tiSplitGear(tail) : null });
    }
    cur.subs.push({ text: t, kind: "line" });
    return true;
  }
  /* datasheet-level matching of every unit item: models, gear, enhancement, warlord, attachments */
  function tiResolveItems(P, idx, L, F, dsF) {
    const fid = P.faction;
    for (const it of P.items) {
      // a guessed "X with Y" variant: let the listed wargear pick between the variants
      if (it.status === "guessed" && /\bwith\s/i.test(it.match || "") && (it.alts || []).length) {
        const txt = " " + tiKey(it.gear.map((g) => g.text).concat(it.subs.map((x) => x.text)).join(" ")).split(" ").map(tiSing).join(" ") + " ";
        const ev = (n) => { const m = String(n).match(/\bwith\s+(.+)$/i); if (!m) return 0; const w = tiKey(m[1]).split(" ").map(tiSing).filter((x) => x.length > 2); return w.filter((x) => txt.includes(" " + x + " ")).length / (w.length || 1); };
        const best = [it.match].concat(it.alts).filter((n) => F.units[n]).map((n) => ({ n, s: ev(n) })).sort((a, b) => b.s - a.s)[0];
        if (best && best.s === 1 && ev(it.match) < 1) { it.alts = [it.match].concat(it.alts.filter((x) => x !== best.n)); it.match = best.n; }
      }
      const u = it.match ? F.units[it.match] : null; it.unitRef = u;
      if (!u) { const k = tiCk(it.name), k2 = tiCk(tiStripFaction(L, it.name) || ""); const recs = (L.units.get(k) || []).concat(k2 ? L.units.get(k2) || [] : []);
        it.elsewhere = [...new Set(recs.filter((r) => r.fid !== fid).map((r) => idx.factions[r.fid].f.name))]; }
      tiResolveGear(P, L, F, dsF, it, u);
    }
    // header hints: warlord / enhancements by Char tag or name
    const byTag = (tag, name) => P.items.find((x) => tag && x.tag === tag) || P.items.find((x) => name && x.match && tiCk(x.match) === tiCk(name) && !x.enhText) || P.items.find((x) => name && tiCk(x.name) === tiCk(name));
    if (P.hints.warlord && !P.items.some((x) => x.warlord)) { const w = byTag(P.hints.warlord.tag, P.hints.warlord.name); if (w) w.warlord = true; }
    for (const h of P.hints.enh) { if (P.items.some((x) => x.enhText && tiCk(x.enhText) === tiCk(h.name.replace(/\s*\([^)]*\)/g, "")) || x.enhText && tiCk(x.enhText) === tiCk(h.name))) continue;
      const w = byTag(h.tag, h.unit); if (w && !w.enhText) w.enhText = h.name.replace(/\s*\((?:upgrade|one per army)\)/ig, ""); }
    // enhancements -> detachment enhancement
    for (const it of P.items) if (it.enhText) {
      const r = tiFindEnh(L, fid, P.dets, it.enhText);
      it.enh = r ? { det: r.det, name: r.en[0], status: r.status, text: it.enhText } : { det: null, name: null, status: "unmatched", text: it.enhText };
    }
    // attachments
    const units = P.items;
    const nth = (name, n) => { const ms = units.filter((x) => tiCk(x.match || x.name) === tiCk(name) || tiCk(x.name) === tiCk(name)); return n ? ms[n - 1] : ms.find((x) => !x._ledBy) || ms[0]; };
    for (const it of units) {
      if (it.attachToItem) { it.attachTarget = it.attachToItem; continue; }
      if (it.attachTo) { const t = nth(it.attachTo.name, it.attachTo.n); if (t && t !== it) { it.attachTarget = t; t._ledBy = true; } else it.attachUnresolved = it.attachTo.name; }
    }
    for (const it of units) for (const ref of it.leading || []) {
      const t = nth(ref.name, ref.n); if (!t || t === it) { it.attachUnresolved = ref.name; continue; }
      // WTC: the Leading line sits on the leader; the "Attached to" line on the bodyguard names the leader
      if (!it.attachTarget && !(it.unitRef && t.unitRef && !isCharacter(it.unitRef) && isCharacter(t.unitRef))) { it.attachTarget = t; t._ledBy = true; }
    }
    for (const it of units) if (it.attachTarget && it.attachTarget.unitRef && it.unitRef && !isCharacter(it.unitRef) && isCharacter(it.attachTarget.unitRef)) {
      // the bodyguard said "Attached to <leader>": flip it so the leader points at the bodyguard
      const ldr = it.attachTarget; if (!ldr.attachTarget) ldr.attachTarget = it; it.attachTarget = null;
    }
    // GW app "Attached unit N" groups / ListForge "A + B" groups: leaders/support attach to the bodyguard
    const groups = {};
    for (const it of units) if (it.group) (groups[it.group] = groups[it.group] || []).push(it);
    for (const g of Object.values(groups)) {
      const body = g.find((x) => x.attachRole === "bodyguard") || g.find((x) => x.unitRef && !isCharacter(x.unitRef)) || g.find((x) => x.unitRef && x.unitRef.ldr == null && !(x.unitRef.sup || []).length);
      for (const x of g) if (x !== body && body && !x.attachTarget) x.attachTarget = body;
    }
  }
  function tiFindEnh(L, fid, dets, text) {
    const ck = tiCk(text); const P = L.perF[fid]; if (!P || !ck) return null;
    const cands = P.enh.get(ck) || [];
    const inDet = cands.find((c) => dets.includes(c.det)); if (inDet) return { ...inDet, status: "ok" };
    if (cands.length) return { ...cands[0], status: "other-detachment" };
    let best = null;
    for (const [k, vs] of P.enh) { const s = tiSim(text, String(vs[0].en[0]).replace(/\s*\([^)]*\)/g, "")); if (s >= 0.8 && (!best || s > best.s || (s === best.s && vs.some((v) => dets.includes(v.det))))) best = { s, v: vs.find((v) => dets.includes(v.det)) || vs[0] }; void k; }
    return best ? { ...best.v, status: dets.includes(best.v.det) ? "guessed" : "other-detachment" } : null;
  }
  /* model counts + loadout picks + priced wargear from the item's sub-lines */
  function tiResolveGear(P, L, F, dsF, it, u) {
    it.gearOk = []; it.gearBad = [];
    if (!u) { it.gearBad = it.gear.map((g) => g.text); return; }
    const M = loModel(u); const ds = dsF && dsF.units ? dsF.units[u.n] : null;
    const types = M ? M.types : [];
    const mlNames = (ds && ds.ml ? ds.ml.map((x) => x[0]) : []);
    const isModelName = (name0) => {
      const sf = tiStripFaction(L, name0); const name = sf && !types.some((x) => tiCk(x.name) === tiCk(name0)) ? sf : name0;
      const c = tiCk(name); if (!c) return null;
      let t = types.find((x) => tiCk(x.name) === c); if (t) return { name: t.name, exact: true };
      const base = (types.find((x) => !x.up && !x.addOn) || {}).name;
      if (mlNames.some((n) => tiCk(n) === c) || tiCk(u.n) === c) return { name: types.length === 1 ? types[0].name : base || name, exact: true };
      t = types.find((x) => { const k = tiCk(x.name); return (k.startsWith(c) || c.startsWith(k)) && Math.abs(k.length - c.length) <= 3; });
      if (t) return { name: t.name, exact: false };
      if (tiCk(u.n).startsWith(c) && c.length > 5 && tiCk(u.n).length - c.length <= 6) return { name: types.length === 1 ? types[0].name : base || name, exact: false };
      return null;
    };
    // pass 0: "3x Tyrant Guard: Bone cleaver" inside a one-line unit (WTC compact) -> model line + its gear;
    // option names that contain commas ("Bone cleaver, lash whip and rending claws") are re-joined
    const commaOpts = M ? [...new Set([...M.types.flatMap((t) => t.slots.flatMap((sl) => sl.opts.map((o) => o.name))), ...M.unit.flatMap((sl) => sl.opts.map((o) => o.name)), ...M.types.flatMap((t) => t.fixed)].filter((n) => /,/.test(n)))] : [];
    if (commaOpts.length) for (let gi = 0; gi < it.gear.length; gi++) for (const on of commaOpts) {
      const parts = on.split(/\s*,\s*/); if (gi + parts.length > it.gear.length) continue;
      const seq = it.gear.slice(gi, gi + parts.length).map((x) => x.text);
      const first = seq[0].replace(/^.*:\s*/, "").replace(/^\d+\s*x\s*/i, "");
      if (tiCk(first) === tiCk(parts[0]) && seq.slice(1).every((x, j) => tiCk(x) === tiCk(parts[j + 1]))) {
        it.gear[gi] = { ...it.gear[gi], text: seq[0].slice(0, seq[0].length - first.length) + on, cn: null }; it.gear.splice(gi + 1, parts.length - 1); }
    }
    for (let gi = 0; gi < it.gear.length; gi++) { const g = it.gear[gi]; if (g.owner || g.tail) continue;
      const cm = g.text.match(/^((?:\d+\s*x\s*)?[^:]{2,60}):\s*(.+)$/i);
      if (cm && !/^(enhancements?|mark of chaos|attached|e)$/i.test(cm[1].trim()) && isModelName(tiCountName(cm[1]).name)) { g.text = cm[1].trim(); g.cn = null; g.tail = [cm[2].trim()]; } }
    // pass 1: split model lines from gear lines (the GW app nests weapons under "Nx Model"; pastes often lose the bullets)
    const modelLines = []; let curModel = null;
    const G = it.gear;
    for (let gi = 0; gi < G.length; gi++) {
      const g = G[gi];
      if (g.owner) { continue; }
      if (!g.cn) g.cn = tiCountName(g.text);
      let mt = isModelName(g.cn.name);
      const isWeapon = tiGearHit(u, M, ds, g.cn.name, null);
      // structure: a shallow bullet followed by deeper (◦ / indented) lines is a model line even when its name is not in our data
      const nx = G[gi + 1];
      if (!mt && !g.deeper && nx && nx.deeper && !nx.owner && (!isWeapon || isWeapon.kind === "ds" && !G.slice(0, gi).some((x) => x.deeper))) {
        const best = types.map((t) => ({ t, s: tiSim(g.cn.name, t.name) })).sort((a, b) => b.s - a.s)[0];
        mt = { name: best && (best.s >= 0.45 || types.filter((t) => !t.addOn).length === 1) ? best.t.name : g.cn.name, exact: false, structural: true };
      }
      if (mt && (g.tail || !g.deeper) && (!isWeapon || mt.exact || mt.structural)) {
        curModel = { n: g.cn.n, name: mt.name, gear: [] }; modelLines.push(curModel); g.model = curModel;
        if (g.tail) for (const x of g.tail) it.gear.push({ text: x, cn: tiCountName(x), owner: curModel, per: curModel.n });
        continue;
      }
      g.owner = curModel;
    }
    for (const m of it.models || []) modelLines.push(m);
    // model count
    const sumModels = modelLines.reduce((n, m) => n + (types.find((t) => t.name === m.name && t.addOn) ? 0 : m.n), 0);
    const opts = modelOptions(u, 1);
    let models = it.count != null && !(opts.length === 1 && it.count === 1) ? it.count : sumModels || null;
    if (it.copies > 1 && it.count) models = it.count;
    if (models == null && it.pts != null && opts.length > 1) { const hit = opts.find((o) => o.points === it.pts) || opts.filter((o) => o.points <= it.pts).sort((a, b) => b.points - a.points)[0]; if (hit) { models = hit.models; it.sizeGuess = true; } }
    if (models == null) models = opts.length ? opts[0].models : 1;
    if (opts.length && !opts.some((o) => o.models === models)) { const near = [...opts].sort((a, b) => Math.abs(a.models - models) - Math.abs(b.models - models))[0]; it.sizeNote = `${models} models is not a listed size; using ${near.label}`; models = near.models; }
    it.models_n = models;
    // loadout
    const lo = M ? { c: {}, p: {} } : null;
    if (M) for (const m of modelLines) if (types.some((t) => t.name === m.name)) lo.c[m.name] = (lo.c[m.name] || 0) + m.n;
    const wargear = {}; const addons = []; const defC = M ? defaultCounts(M, loN(M, models), null) : {};
    const linked = linkedWargear(u);
    for (const g of it.gear) {
      if (g.model) continue;
      const cn = g.cn || tiCountName(g.text);
      if (TI_WARLORD.test(cn.name)) { it.warlord = true; continue; }
      const em = cn.name.match(TI_ENH); if (em) { it.enhText = em[2].replace(/\s*\(.*\)\s*$/, ""); continue; }
      if (/^(\w+\s+)*character$|^epic hero$/i.test(cn.name)) continue;
      const mk = cn.name.match(/^mark of chaos\s*:\s*(.+)$|^mark of (khorne|nurgle|slaanesh|tzeentch)$/i); if (mk) { it.markText = (mk[1] || mk[2]).trim(); continue; }
      const n = cn.explicit ? cn.n : (g.per || (g.owner ? g.owner.n : 1));
      const hit = tiGearHit(u, M, ds, cn.name, g.owner ? g.owner.name : null);
      if (hit && hit.kind === "opt" && hit.all && hit.all.length > 1) {   // the same option in several slots (Weapon 1 / Weapon 2): fill the one with room
        const cap = (h) => { const [tn, sn] = h.key.split("|"); const T = tn === "*" ? null : M.types.find((x) => x.name === tn);
          const sl = tn === "*" ? M.unit.find((x) => x.name === sn) : T && T.slots.find((x) => x.name === sn); if (!sl) return 0;
          const k = tn === "*" ? 1 : (lo.c[tn] != null ? lo.c[tn] : defC[tn] || 0); const used = Object.values(lo.p[h.key] || {}).reduce((a, b) => a + b, 0);
          return slotRange(sl, k)[1] - used; };
        const pref = hit.all.filter((h) => !g.owner || h.key.startsWith(g.owner.name + "|")); const L2 = pref.length ? pref : hit.all;
        const h = L2.find((x) => cap(x) >= n) || L2.find((x) => cap(x) > 0) || L2[0];
        if (cap(h) < n) { let left = n; for (const x of L2) { const c2 = Math.min(left, Math.max(0, cap(x))); if (c2 > 0) { lo.p[x.key] = lo.p[x.key] || {}; lo.p[x.key][x.opt] = (lo.p[x.key][x.opt] || 0) + c2; left -= c2; } if (!left) break; }
          if (!left) { it.gearOk.push(g.text); continue; } }
        hit.key = h.key; hit.opt = h.opt;
      }
      if (hit && hit.kind === "opt") { const k = hit.key; lo.p[k] = lo.p[k] || {}; lo.p[k][hit.opt] = (lo.p[k][hit.opt] || 0) + n; it.gearOk.push(g.text); continue; }
      if (hit && hit.kind === "w" && !linked.has(hit.wi)) { wargear[hit.name] = (wargear[hit.name] || 0) + n; it.gearOk.push(g.text); continue; }
      if (hit && hit.kind === "addon") { if (!addons.includes(hit.label)) addons.push(hit.label); it.gearOk.push(g.text); continue; }
      if (hit) { it.gearOk.push(g.text); continue; }
      // an enhancement written as gear (NR simple "Name [15 pts]: Enh [15 pts], gear")
      const en = tiFindEnh(L, P.faction, P.dets, cn.name);
      if (en && !it.enhText && (en.status === "ok" || tiCk(en.en[0]) === tiCk(cn.name))) { it.enhText = cn.name; continue; }
      it.gearBad.push(g.text);
    }
    it.lo = lo && (Object.keys(lo.c).length || Object.keys(lo.p).length) ? lo : null;
    it.wargear = wargear; it.addons = addons;
  }
  /* does a gear name belong to the datasheet? -> {kind:"opt", key, opt} | {kind:"fixed"} | {kind:"w", wi, name} | {kind:"addon"} | {kind:"ds"} | null */
  function tiGearHit(u, M, ds, name, typeName) {
    const c = tiCk(name); if (!c) return null;
    const eq = (a) => { const x = tiCk(a); return x === c || x.replace(/linked/g, "") === c.replace(/linked/g, "") || x.replace(/twin/g, "") === c.replace(/twin/g, "") && c.length > 6 && false; };
    if (M) {
      const order = [...M.types].sort((a, b) => (b.name === typeName) - (a.name === typeName));
      const hs = [];
      for (const t of order) for (const s of t.slots) for (const o of s.opts) if (eq(o.name)) hs.push({ key: `${t.name}|${s.name}`, opt: o.name });
      for (const s of M.unit) for (const o of s.opts) if (eq(o.name)) hs.push({ key: `*|${s.name}`, opt: o.name });
      if (hs.length) return { kind: "opt", key: hs[0].key, opt: hs[0].opt, all: hs };
      for (const t of order) if (t.fixed.some(eq)) return { kind: "fixed" };
      // a combined option ("Bolt pistol and chainsword") named by one of its weapons
      for (const t of order) for (const s of t.slots) for (const o of s.opts) { const parts = gearWeapons(o.name, [name]); if (parts.length && tiCk(o.name).includes(c) && c.length > 4) return { kind: "opt", key: `${t.name}|${s.name}`, opt: o.name }; }
    }
    const wi = (u.w || []).findIndex((w) => eq(w[0])); if (wi >= 0) return { kind: "w", wi, name: u.w[wi][0] };
    for (const a of addonOptions(u, 1)) if (tiCk(a.label.replace(/^\+\s*\d*\s*/, "")) === c || tiCk(a.label) === c) return { kind: "addon", label: a.label };
    if (ds) { if ((ds.wp || []).some((w) => eq(w[0]))) return { kind: "ds" }; if ((ds.wa || []).some((a) => eq(a[0]) || eq(a[1]))) return { kind: "ds" }; }
    if (M) for (const t of M.types) if (t.fixed.some((f) => tiCk(f).includes(c) && c.length > 5)) return { kind: "fixed" };
    if (/^close ?combat weapons?$/.test(tiKey(name)) || /^(armou?red (hull|feet|tracks?)|wrecker|close combat weapon)$/i.test(name)) return { kind: "ds" };
    // partial names ("Astartes chainsword" -> Chainsword, "Twin Icarus rocket pod" -> Icarus Rocket Pod, "Black Knight combat weapon" -> Corvus Hammers)
    if (M) { const order = [...M.types].sort((a, b) => (b.name === typeName) - (a.name === typeName));
      for (const t of order) for (const sl of t.slots) for (const o of sl.opts) { const k = tiCk(o.name); if (k.length > 4 && (c.includes(k) || k.includes(c) && c.length > 5)) return { kind: "opt", key: `${t.name}|${sl.name}`, opt: o.name, partial: true }; }
      for (const sl of M.unit) for (const o of sl.opts) { const k = tiCk(o.name); if (k.length > 4 && (c.includes(k) || k.includes(c) && c.length > 5)) return { kind: "opt", key: `*|${sl.name}`, opt: o.name, partial: true }; } }
    const wpN = ds ? (ds.wp || []).map((w) => w[0]) : []; if (M) for (const t of M.types) wpN.push(...t.fixed);
    if (wpN.length && gearWeapons(name, wpN).length) return { kind: "ds", partial: true };
    return null;
  }
  /* build a Muster list from a (possibly user-edited) parse; item.include=false skips, item.pick overrides the datasheet */
  function buildFromParse(P, idx, ds, edits) {
    edits = edits || {};
    const fid = P.faction; const F = idx.factions[fid];
    const list = newList({ name: P.name || "Imported list", faction: fid, sub: P.sub || fid, size: P.size || "strikeforce" });
    list.dets = (P.dets || []).filter((d) => F && F.dets[d]);
    if (P.disposition) list.disposition = P.disposition;
    const rows = [];
    const uidOf = new Map();
    for (const it of P.items) {
      if (!it.include) continue;
      const name = it.pick || it.match; const u = name && F ? F.units[name] : null;
      if (!u) continue;
      if (it.pick && it.pick !== it.match) { it.match = it.pick; it.unitRef = u; tiResolveGear(P, tiLexicon(idx), F, ds && ds.factions ? ds.factions[fid] : null, it, u); if (it.enhText) { const r = tiFindEnh(tiLexicon(idx), fid, P.dets, it.enhText); it.enh = r ? { det: r.det, name: r.en[0], status: r.status, text: it.enhText } : { status: "unmatched", text: it.enhText }; } }
      const copies = it.copies || 1;
      for (let c = 0; c < copies; c++) {
        const e = newEntry(u);
        e.models = it.models_n || e.models;
        if (it.lo) e.lo = JSON.parse(JSON.stringify(it.lo));
        if (it.wargear && Object.keys(it.wargear).length) e.wargear = { ...it.wargear };
        if (it.addons && it.addons.length) e.addons = [...it.addons];
        if (c === 0 && it.warlord) e.warlord = true;
        if (c === 0 && it.enh && it.enh.det && it.enh.name && list.dets.includes(it.enh.det)) e.enh = { det: it.enh.det, name: it.enh.name };
        if (it.markText) { const mk = MARKS.find((x) => tiCk(x) === tiCk(it.markText) || tiCk(x).includes(tiCk(it.markText))); if (mk) e.mark = mk; }
        const notes = c === 0 && it.notes ? [...it.notes] : [];
        if (c === 0 && it.gearBad && it.gearBad.length) notes.push(`Imported, not matched: ${it.gearBad.join(", ")}`);
        if (c === 0 && it.enh && !(e.enh)) notes.push(`Enhancement not applied: ${it.enhText}`);
        if (notes.length) e.note = notes.join(" · ");
        list.entries.push(e); rows.push({ it, e });
        if (c === 0) uidOf.set(it, e.uid);
      }
    }
    for (const { it, e } of rows) if (it.attachTarget && it.attachTarget.include !== false && uidOf.has(it.attachTarget)) {
      const t = list.entries.find((x) => x.uid === uidOf.get(it.attachTarget)); const tu = F.units[t.unit]; const mu = F.units[e.unit];
      if (attachKind(mu, tu, enhAttach(F, e)) || it.attachTo || it.leading || it.attachToItem || it.group) e.attach = t.uid;
    }
    const calc = calcList(list, idx);
    const byUid = {}; for (const r of calc.entries) byUid[r.uid] = r;
    for (const r of rows) r.row = byUid[r.e.uid];
    return { list, calc, rows };
  }
  /* summary numbers for the review screen / tests */
  function importSummary(P, B) {
    const units = P.items.length, matched = P.items.filter((x) => x.match && x.status !== "guessed").length, guessed = P.items.filter((x) => x.match && x.status === "guessed").length;
    const gearOk = P.items.reduce((n, x) => n + (x.gearOk || []).length, 0), gearBad = P.items.reduce((n, x) => n + (x.gearBad || []).length, 0);
    const statedUnits = P.items.reduce((n, x) => n + (x.pts != null ? x.pts * (x.copies || 1) : 0), 0);
    return { format: P.format, faction: P.faction, units, matched, guessed, unmatched: units - matched - guessed, gearOk, gearBad,
      stated: P.statedTotal, statedUnits, computed: B ? B.calc.total : null, diff: B && P.statedTotal != null ? B.calc.total - P.statedTotal : null,
      unrecognised: P.lines.filter((l) => /^unrecognised/.test(l.kind)).length, errors: B ? B.calc.errors.map((e) => e.msg) : [] };
  }
  /* ==== end text import ==== */

  return { allyView, detAllyRules, parseListText, buildFromParse, importSummary, tiKey, tiSim, tiDetectFormat, TI_FORMAT_NAMES, allyGodCounts, allyRatioIssues, allyAddCheck, unitMark, markEffects, wargearAbilities, favouredKatah, armyRuleBody, gearWeapons, allyCapText, allyCountIssues, MARKS, markChoices, markRuleActive, leadersOk, enhAttach, detFits, detStatMods, detModEligible, pointsLeft, enhStatMods, applyStatMod, weaponMatches, entryStatMods, pickedGearTexts, setUnitAbilities, statWithMods, rulesIndex, rulesSearch, rulesMarks, ruleText, ruleNorm, scrubList, scrubSourceName, syncTime, pendingPush, syncRow, mergeLists, attachText, unitAllowed, attachKind, canAttach, attachTargets, enhRestriction, enhEligible, enhancementChoices, groupOf, findUnit, loadoutSummary, fmtLocal, loModel, hasLoadout, getLoadout, setModelCount, loadoutIssues, loadoutWargear, linkedWargear, loadoutLines, loadoutText, defaultCounts, effMin, loN, slotRange, typeMax, optMax, sortRows, metaFaction, metaDetachment, metaRanges, metaHasRtt, metaView, metaDetail, fmtPct, ROLE_ORDER, norm, uid, indexData, getFaction, getSize, tierFor, modelOptions, pickModelOption, stratTargetText, unitKeywords, unitStratMatch, unitStratagems, addonOptions, defaultModels,
    minCost, unitLimit, isCharacter, isEpicHero, isBattleline, isTransport, newList, newEntry, calcList, searchUnits,
    diffData, diffLists, costSummary, listToText, exportLists, importLists, duplicateList,
    EXPORT_FORMATS, exportText, exportYellowscribe, exportYellowscribeRosz, ysResolveGear, zipStore, crc32, discordBlocks, toMarkdown, b64urlEncode, b64urlDecode, shareableList, listFromShareable };
});
