// Alert rules — pure logic, no I/O, so it can be tested with plain data.
// Each subscription: { subscription, spot, prefs:{brief, briefHour, heads, stale}, sent:{key:ts} }
"use strict";
const E = require("./engine-node.js");
const DAY = 86400000, OFF = 7 * 3600 * 1000;
const dayKey = (t) => Math.floor((t - OFF) / DAY);
const mstHour = (t) => new Date(t - OFF).getUTCHours();
const clock = (t) => new Date(t).toLocaleTimeString("en-US", { timeZone: "America/Phoenix", hour: "numeric", minute: "2-digit" });
const relTime = (t, now) => { const d = dayKey(t) - dayKey(now); return "~" + clock(t) + (d === 1 ? " tomorrow" : d > 1 ? " " + new Date(t).toLocaleDateString("en-US", { timeZone: "America/Phoenix", weekday: "short" }) : ""); };
function ftStr(v) { if (v == null || isNaN(v)) return "—"; if (Math.abs(v) < 0.05) return "0.0 ft"; return (v > 0 ? "+" : "−") + Math.abs(v).toFixed(1) + " ft"; }
function lvl(M, v) { const ft = M.toFtH ? M.toFtH(v) : null; return ft != null ? ftStr(ft) : Math.round(v).toLocaleString("en-US") + " cfs"; }
function extremes(pts, k) { let hi = null, lo = null; for (const p of pts) { if (dayKey(p.t) !== k) continue; if (!hi || p.v > hi.v) hi = p; if (!lo || p.v < lo.v) lo = p; } return { hi, lo }; }
function dayPeaks(M, now) {
  const tk = dayKey(now), flowP = M.flowP || [];
  const today = flowP.filter((p) => dayKey(p.t) === tk).map((p) => ({ t: p.t, v: p.v }));
  const horizon = flowP.length ? flowP[flowP.length - 1].t : 0;
  const fut = (M.outlook && M.outlook.blend) || [];
  for (const p of fut) if (p.t > horizon && dayKey(p.t) === tk) today.push({ t: p.t, v: p.v });
  return { yest: extremes(flowP, tk - 1), today: extremes(today, tk), tomorrow: extremes(fut, tk + 1) };
}
// feet vs the week's average at a moment in the past, from the shifted sensor record
function ftAt(M, t) {
  const fp = M.flowP || []; if (!M.toFtH || fp.length < 2) return null;
  let best = null; for (const p of fp) { if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p; }
  if (!best || Math.abs(best.t - t) > 45 * 60000) return null;
  return M.toFtH(best.v);
}
const leadTxt = (lead) => lead >= 60 ? (lead / 60) + " h" : lead + " min";
const recentlySent = (sub, prefix, now, ms) => Object.keys(sub.sent || {}).some((k) => k.startsWith(prefix) && now - sub.sent[k] < ms);
function cmp(M, a, b) {
  if (a == null || b == null) return null;
  if (M.toFtH) { const fa = M.toFtH(a), fb = M.toFtH(b); if (fa != null && fb != null) { const d = fa - fb; return d > 0.25 ? "bigger" : d < -0.25 ? "smaller" : "similar"; } }
  const r = a / (b || 1); return r > 1.08 ? "bigger" : r < 0.92 ? "smaller" : "similar";
}
const plain = (s) => String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

// Messages a subscription is due for right now (keys let the caller dedupe).
function messagesFor(M, sub, now, dataAgeMs) {
  const out = [], prefs = sub.prefs || {}, name = M.pl.name, url = "/s/" + M.pl.key;
  if (!M.ok) return out;
  const tk = dayKey(now);
  if (prefs.brief) {
    const hr = Number.isFinite(+prefs.briefHour) ? +prefs.briefHour : 7;
    if (mstHour(now) >= hr && mstHour(now) < hr + 6) { // send in the first run after the chosen hour; give up 6 h later
      const e0 = M.events[0], e1 = M.events[1];
      let body = "";
      if (M.lake && M.lakeInfo) body = "Lake at " + M.lakeInfo.elev.toFixed(2) + " ft, " + M.lakeInfo.word + ".";
      else {
        body = (M.abl != null ? "Now " + ftStr(M.abl) + (Math.abs(M.abl) < 0.05 ? " — right at" : (M.abl > 0 ? " above" : " below")) + " the week's average" : "Now " + (M.f ? Math.round(M.f.v).toLocaleString("en-US") + " cfs" : "")) + ".";
        if (e0) body += " Next " + e0.type + " " + lvl(M, e0.v) + " " + relTime(e0.t, now) + (e1 ? ", then " + e1.type + " " + lvl(M, e1.v) + " " + relTime(e1.t, now) : "") + ".";
        if (M.yc) body += " " + M.yc.phrase.charAt(0).toUpperCase() + M.yc.phrase.slice(1) + ".";
      }
      if (/\d:\d\d [AP]M/.test(body)) body += " (Arizona time)";
      out.push({ key: "brief:" + tk, title: name + ": " + plain(M.head.t), body, url, tag: "brief" });
    }
  }
  if (prefs.heads && !M.lake) {
    const P = dayPeaks(M, now);
    if (P.tomorrow.hi && P.today.hi) {
      const rel = cmp(M, P.tomorrow.hi.v, P.today.hi.v);
      if (rel && rel !== "similar") {
        out.push({ key: "heads:" + tk + ":" + rel, title: name + ": tomorrow's peak " + rel, body: "Tomorrow peaks at " + lvl(M, P.tomorrow.hi.v) + " " + relTime(P.tomorrow.hi.t, now) + " vs today's " + lvl(M, P.today.hi.v) + (P.tomorrow.lo ? ". Low " + lvl(M, P.tomorrow.lo.v) + " " + relTime(P.tomorrow.lo.t, now) : "") + ".", url, tag: "heads" });
      }
    }
  }
  if (prefs.until && new Date(prefs.until).getTime() < now) return out; // the person asked for alerts only through a date
  const qf = Number.isFinite(+prefs.quietFrom) ? +prefs.quietFrom : 22, qt = Number.isFinite(+prefs.quietTo) ? +prefs.quietTo : 6, hr = mstHour(now);
  const quiet = prefs.quiet !== false && qf !== qt && (qf < qt ? (hr >= qf && hr < qt) : (hr >= qf || hr < qt));
  // High and low water: a ping as the next high and the next low arrive (or a
  // chosen lead time before). The robot runs about every 10 minutes, so the
  // window is a little wider than that; a 3-hour guard stops repeats when the
  // forecast time drifts a few minutes between runs.
  if (prefs.turns && !M.lake && !quiet) {
    const lead = [0, 30, 60, 120].includes(+prefs.turnLead) ? +prefs.turnLead : 60;
    for (const e of (M.events || []).slice(0, 2)) {
      const fireAt = e.t - lead * 60000;
      if (fireAt < now - 15 * 60000 || fireAt > now + 10 * 60000) continue;
      if (recentlySent(sub, "turn:" + e.type + ":", now, 3 * 3600000)) continue;
      const other = (M.events || []).find((x) => x.type !== e.type && x.t > e.t);
      out.push({ key: "turn:" + e.type + ":" + Math.round(e.t / 1800000), title: name + ": " + (e.type === "high" ? "high water" : "low water") + (lead ? " in ~" + leadTxt(lead) : " now"),
        body: (e.type === "high" ? "Peaks around " : "Bottoms out around ") + lvl(M, e.v) + " at ~" + clock(e.t) + (other ? ", then " + (other.type === "high" ? "up to " : "down to ") + lvl(M, other.v) + " ~" + clock(other.t) : "") + " (Arizona time).", url, tag: "turn" });
    }
  }
  // Above or below a level of your choosing, in feet vs this week's average:
  // fires on the crossing (compares now with an hour ago), once per crossing.
  if (prefs.level && !M.lake && !quiet && M.toFtH && M.f) {
    const cur = M.toFtH(M.f.v), prev = ftAt(M, now - 3600000);
    if (cur != null && prev != null) {
      const hi = prefs.levelHi, lo = prefs.levelLo, e0 = M.events[0];
      const nextTxt = e0 ? " Next " + e0.type + " " + lvl(M, e0.v) + " " + relTime(e0.t, now) + "." : "";
      if (hi != null && cur >= hi && prev < hi && !recentlySent(sub, "lvl:hi:", now, 3 * 3600000)) out.push({ key: "lvl:hi:" + Math.round(now / 3600000), title: name + ": above " + ftStr(hi), body: "The water has climbed past " + ftStr(hi) + " \u2014 now " + ftStr(cur) + " vs the week\u2019s average." + nextTxt, url, tag: "level" });
      if (lo != null && cur <= lo && prev > lo && !recentlySent(sub, "lvl:lo:", now, 3 * 3600000)) out.push({ key: "lvl:lo:" + Math.round(now / 3600000), title: name + ": below " + ftStr(lo), body: "The water has dropped past " + ftStr(lo) + " \u2014 now " + ftStr(cur) + " vs the week\u2019s average." + nextTxt, url, tag: "level" });
    }
  }
  // Weekend outlook: Friday afternoon, Saturday's and Sunday's highs and lows.
  if (prefs.weekend && !M.lake) {
    const dow = new Date(now - OFF).getUTCDay();
    if (dow === 5 && mstHour(now) >= 15 && mstHour(now) < 21) {
      const fut = (M.outlook && M.outlook.blend) || [], days = [["Saturday", tk + 1], ["Sunday", tk + 2]], bits = [];
      for (const [nm, k] of days) { const x = extremes(fut, k); if (x.hi && x.lo) bits.push(nm + ": high " + lvl(M, x.hi.v) + " ~" + clock(x.hi.t) + ", low " + lvl(M, x.lo.v) + " ~" + clock(x.lo.t)); }
      if (bits.length) out.push({ key: "wknd:" + tk, title: name + ": the weekend ahead", body: bits.join(". ") + " (Arizona time).", url, tag: "weekend" });
    }
  }
  if (prefs.stale && dataAgeMs > 8 * 3600 * 1000) {
    out.push({ key: "stale:" + tk, title: "River data is running behind", body: "The newest sensor reading is " + Math.round(dataAgeMs / 3600000) + " h old — Reclamation's feed has paused. The page will catch up on its own.", url, tag: "stale" });
  }
  return out;
}

// Evaluate all subscriptions against one riverdata.json. Returns per-sub
// messages not yet sent (by key), with the engine result cached per spot.
function evaluate(data, subs, now) {
  now = now || Date.now();
  const ctx = E.makeContext();
  E.loadData(ctx, data);
  let newest = 0;
  for (const s of data.stations || []) for (const p of (s.flow || []).concat(s.stage || [])) if (p.t > newest) newest = p.t;
  const dataAge = newest ? now - newest : 0;
  const cache = {}, results = [];
  for (const sub of subs) {
    if (!sub || !sub.spot) continue;
    if (!cache[sub.spot]) { try { cache[sub.spot] = E.evalSpot(ctx, sub.spot); } catch (e) { cache[sub.spot] = null; } }
    const M = cache[sub.spot]; if (!M) continue;
    const sent = sub.sent || {};
    let due = messagesFor(M, sub, now, dataAge).filter((m) => !sent[m.key]);
    // When the daily brief and a heads-up are due in the same run, send ONE
    // notification: the brief, with the heads-up folded in as its last line.
    const brief = due.find((m) => m.tag === "brief"), heads = due.find((m) => m.tag === "heads");
    if (brief && heads) {
      brief.body += " " + heads.body.replace(/^Tomorrow peaks at/, "Heads-up: tomorrow peaks at");
      brief.keys = [brief.key, heads.key];
      due = due.filter((m) => m !== heads);
    }
    if (due.length) results.push({ sub, messages: due });
  }
  return results;
}
module.exports = { evaluate, messagesFor, dayPeaks };
