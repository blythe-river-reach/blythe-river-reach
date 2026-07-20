// RELEASE 2026-07-12a — Is The River Up data robot (Davis Dam → Martinez Lake)
// Runs in GitHub Actions (Node 20). Fetches Reclamation's hourly reach feed (with the
// HTML daily-report as a fallback when the JSON export stalls) plus the dam schedule
// PDFs server-side (no CORS), parses them, and writes data/riverdata.json for the
// dashboard to read. Exits 0 if at least one source worked.

const fs = require("fs");

const BOR = "https://www.usbr.gov/lc/region/g4000/riverops/webreports/hourlyweb.json";
const HG = "https://www.usbr.gov/lc/region/g4000/hourly/HeadgateReport.pdf";
const MONTHS = { january:0, february:1, march:2, april:3, may:4, june:5, july:6, august:7, september:8, october:9, november:10, december:11 };

// "7/3/2026 6:00:00 PM" (MST, UTC-7 year round) -> epoch ms
function borToEpoch(s) {
  const m = String(s).match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+)\s+(AM|PM)/i);
  if (!m) return null;
  let mo = +m[1], d = +m[2], y = +m[3], h = +m[4], mi = +m[5];
  const ap = m[7].toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return Date.UTC(y, mo - 1, d, h, mi, 0) + 7 * 3600 * 1000;
}
function mstEpoch(mn, day, year, hour) {
  const mo = MONTHS[String(mn).toLowerCase()];
  if (mo == null) return null;
  return Date.UTC(year, mo, day, hour, 0, 0) + 7 * 3600 * 1000;
}
function findSeries(series, names, typePart, claimed) {
  return series.find((s) => {
    const n = (s.SiteName || "").toLowerCase();
    if (claimed && claimed.has(n)) return false;
    return names.some((x) => n.includes(x)) && (s.DataTypeName || "").toLowerCase().includes(typePart);
  });
}
function toPoints(s) {
  if (!s || !Array.isArray(s.Data)) return [];
  return s.Data.map((d) => ({ t: borToEpoch(d.t), v: d.v === "" ? null : parseFloat(d.v) }))
    .filter((p) => p.t && p.v != null && !isNaN(p.v))
    .sort((a, b) => a.t - b.t);
}

// Must match the station shape the page expects
const REACH = [
  { key: "davis",        name: "Davis Dam release", role: "Release upstream \u00b7 top of the map", order: -10, names: ["mohave"], releaseType: "release" },
  { key: "belowdavis",   name: "Below Davis Dam", role: "Reclamation sensor \u00b7 Laughlin reach", order: -8, names: ["below davis"] },
  { key: "bigbend",      name: "Big Bend", role: "Reclamation sensor \u00b7 below Laughlin", order: -7, names: ["big bend"] },
  { key: "boyscout",     name: "Boy Scout Camp", role: "Reclamation sensor \u00b7 Mohave Valley", order: -6, names: ["boy scout"] },
  { key: "interstate",   name: "Interstate Bridge (Needles)", role: "Reclamation sensor \u00b7 at Needles", order: -5, names: ["interstate bridge"] },
  { key: "topockg",      name: "Topock Bridge", role: "Reclamation sensor \u00b7 head of Havasu", order: -4, names: ["topock", "river section 41"] },
  { key: "parker",       name: "Parker Dam release", role: "Release upstream \u00b7 early warning", order: 0, names: ["havasu"], releaseType: "release" },
  { key: "parkergage",   name: "Parker gage", role: "Below Headgate \u00b7 upper reach", order: 1, names: ["parker gage", "parker  gage"] },
  { key: "waterwheel",   name: "Water Wheel", role: "Reclamation sensor \u00b7 mid reach", order: 2, primary: true, names: ["water wheel"] },
  { key: "i10",          name: "Blythe (I-10 bridge)", role: "Reclamation sensor \u00b7 at Blythe", order: 3, names: ["interstate 10", "interstate-10", "i-10", "i 10", "i10"] },
  { key: "mcintyrepark", name: "McIntyre Park", role: "Reclamation sensor \u00b7 south of Blythe", order: 5, names: ["mcintyre"] },
  { key: "taylor",       name: "Taylor Ferry", role: "Reclamation sensor \u00b7 below Blythe", order: 6, names: ["taylor"] },
  { key: "oxbow",        name: "Oxbow Bridge", role: "Reclamation sensor \u00b7 Cibola reach", order: 7, names: ["oxbow"] },
  { key: "cibola",       name: "Cibola gage", role: "Reclamation sensor \u00b7 Cibola reach", order: 8, names: ["cibola"] },
  { key: "picacho",      name: "Picacho Park", role: "Reclamation sensor \u00b7 Picacho reach", order: 12, names: ["picacho"] },
  { key: "martinez",     name: "Martinez Lake", role: "Reclamation sensor \u00b7 above Imperial Dam", order: 13, names: ["martinez"] },
];

function buildStations(json) {
  const series = json.Series || [];
  const stations = [];
  const claimed = new Set(); const siteNames = {};
  for (const def of REACH) {
    let flow, stage = [];
    if (def.releaseType) {
      const hitR = findSeries(series, def.names, def.releaseType, claimed) || findSeries(series, def.names, "flow", claimed);
      if (hitR) { claimed.add((hitR.SiteName || "").toLowerCase()); siteNames[def.key] = hitR.SiteName; }
      flow = toPoints(hitR);
    } else {
      const hitF = findSeries(series, def.names, "flow", claimed);
      if (hitF) { claimed.add((hitF.SiteName || "").toLowerCase()); siteNames[def.key] = hitF.SiteName; }
      flow = toPoints(hitF);
      stage = toPoints(findSeries(series, def.names, "gage height"));
    }
    if (flow.length || stage.length) {
      stations.push({ key: def.key, name: def.name, role: def.role, order: def.order, primary: !!def.primary, source: "USBR", flow, stage });
    }
  }
  stations.siteNames = siteNames;
  return stations;
}

function parseHeadgate(text) {
  // Publication date ("Date of Publication: 7/3/2026 1:32 PM MST") — the first
  // table (which has no weekday header before it) belongs to this date.
  let pub = null;
  const pm = text.match(/Date of Publication:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (pm) pub = { y: +pm[3], mo: +pm[1] - 1, d: +pm[2] };

  // Weekday date headers, with their position in the text. Each PRECEDES its table.
  const dates = [];
  const dateRe = /(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s*,\s+([a-z]+)\s+(\d{1,2})\s*,\s+(\d{4})/gi;
  let dm;
  while ((dm = dateRe.exec(text))) dates.push({ idx: dm.index, month: dm[2], day: +dm[3], year: +dm[4] });

  // Rows: hour + 4 flows + decimal MWH. \s+ tolerates numbers split across lines;
  // the leading non-digit guard stops false matches starting inside a longer number
  // (e.g. inside the Avg/Sum row's totals).
  const rowRe = /(^|[^\d.])(\d{1,2})\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+\.\d+)/g;
  const tables = [];
  let curr = null, rm;
  while ((rm = rowRe.exec(text))) {
    const hr = +rm[2];
    if (hr < 1 || hr > 24) continue;
    if (hr === 1) { if (curr && curr.rows.length) tables.push(curr); curr = { idx: rm.index, rows: [] }; }
    if (!curr) curr = { idx: rm.index, rows: [] };
    curr.rows.push({ hr, parker: +rm[3], crit: +rm[4] });
  }
  if (curr && curr.rows.length) tables.push(curr);

  // Pair each table with the nearest date header BEFORE it; the first table
  // falls back to the publication date.
  const downstream = [], parker = [];
  let critSum = 0, critN = 0;
  for (const tb of tables) {
    let best = null;
    for (const d of dates) { if (d.idx < tb.idx && (!best || d.idx > best.idx)) best = d; }
    let t0 = null;
    if (best) t0 = mstEpoch(best.month, best.day, best.year, 0);
    else if (pub) t0 = Date.UTC(pub.y, pub.mo, pub.d, 0, 0, 0) + 7 * 3600 * 1000;
    if (t0 == null) continue;
    for (const r of tb.rows) {
      const t = t0 + (r.hr - 1) * 3600 * 1000;
      downstream.push({ t, v: r.parker - r.crit });
      parker.push({ t, v: r.parker });
      critSum += r.crit; critN++;
    }
  }
  const dedupe = (arr) => {
    const seen = {};
    for (const p of arr) seen[p.t] = p.v;
    return Object.keys(seen).map((t) => ({ t: +t, v: seen[t] })).sort((a, b) => a.t - b.t);
  };
  const out = dedupe(downstream), outP = dedupe(parker);
  return {
    downstream: out,
    parker: outP,
    critAvg: critN ? Math.round(critSum / critN) : null,
    note: out.length ? "Downstream flow = Parker inflow minus the CRIT canal diversion (avg ~" + Math.round(critSum / critN) + " cfs pulled out at Headgate)." : "",
    tableCount: tables.length,
  };
}


const DP = "https://www.usbr.gov/lc/region/g4000/hourly/DavisParkerSchedules.pdf";
// pdf-parse's default text glues same-line items together; this renderer keeps spaces.
const renderPage = (pageData) =>
  pageData.getTextContent().then((tc) => {
    let lastY, out = "";
    for (const item of tc.items) {
      if (lastY !== undefined && Math.abs(item.transform[5] - lastY) > 1) out += "\n";
      else if (out && !out.endsWith("\n")) out += " ";
      out += item.str;
      lastY = item.transform[5];
    }
    return out;
  });

// Davis & Parker schedule: one page per day; rows "12 am - 1 am  units davisCfs  units parkerCfs".
function parseDavisParker(text) {
  const dates = [];
  const dre = /(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/gi;
  let m;
  while ((m = dre.exec(text))) dates.push({ mo: +m[2], d: +m[3], y: (+m[4] < 100 ? 2000 + +m[4] : +m[4]) });
  const rre = /(\d{1,2})\s*(am|pm)\s*-\s*\d{1,2}\s*(am|pm)\s+(\d+(?:\.\d+)?)\s+([\d,]+)\s+(\d+(?:\.\d+)?)\s+([\d,]+)/gi;
  const tables = [];
  let curr = null, r;
  while ((r = rre.exec(text))) {
    let hr = (+r[1]) % 12;
    if (r[2].toLowerCase() === "pm") hr += 12;
    if (hr === 0) { if (curr && curr.length) tables.push(curr); curr = []; }
    if (!curr) curr = [];
    curr.push({ hr, parker: +r[7].replace(/,/g, ""), davis: +r[5].replace(/,/g, "") });
  }
  if (curr && curr.length) tables.push(curr);
  const pm2 = text.match(/Date of Publication:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  const pk = [], dv = [];
  for (let i = 0; i < tables.length; i++) {
    const d = (dates.length === tables.length) ? dates[i] : (pm2 ? { mo: +pm2[1], d: +pm2[2] + i, y: +pm2[3] } : null);
    if (!d) continue;
    const t0 = Date.UTC(d.y, d.mo - 1, d.d, 0, 0, 0) + 7 * 3600 * 1000;
    for (const row of tables[i]) {
      pk.push({ t: t0 + row.hr * 3600 * 1000, v: row.parker });
      dv.push({ t: t0 + row.hr * 3600 * 1000, v: row.davis });
    }
  }
  const uniq = (arr) => { const s = {}; for (const p of arr) s[p.t] = p.v; return Object.keys(s).map((t) => ({ t: +t, v: s[t] })).sort((a, b) => a.t - b.t); };
  return { parker: uniq(pk), davis: uniq(dv) };
}

// Measure how fast pulses actually travel by cross-correlating adjacent sensors.
function xcorrPair(aPts, bPts, miles) {
  const am = {}; for (const p of aPts) am[p.t] = p.v;
  let best = null; const rs = {};
  for (let lag = 0; lag <= 24; lag++) {
    const xs = [], ys = [];
    for (const q of bPts) { const t = q.t - lag * 3600000; if (am[t] != null) { xs.push(am[t]); ys.push(q.v); } }
    if (xs.length < 72) continue;
    const n = xs.length, mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    const r = sxy / Math.sqrt((sxx * syy) || 1);
    rs[lag] = r;
    if (!best || r > best.r) best = { lag, r };
  }
  if (!best || best.r < 0.55 || best.lag < 1 || best.lag > 23) return null;
  let lagH = best.lag;
  const r0 = rs[best.lag - 1], r1 = rs[best.lag], r2 = rs[best.lag + 1];
  if (r0 != null && r2 != null) { const den = r0 - 2 * r1 + r2; if (den < 0) lagH = best.lag + 0.5 * (r0 - r2) / den; }
  const mph = miles / lagH;
  if (!(mph >= 1 && mph <= 12)) return null;
  return { lagHours: +lagH.toFixed(2), r: +best.r.toFixed(3), mph: +mph.toFixed(2) };
}
function calibrate(stations) {
  const by = {}; for (const s of stations) by[s.key] = s;
  const PAIRS = [
    ["davis", "bigbend", 10.1], ["bigbend", "interstate", 21.7],
    ["belowdavis", "bigbend", 9.5], ["bigbend", "boyscout", 11.2],
    ["boyscout", "interstate", 10.5], ["interstate", "topockg", 10.55],
    ["parkergage", "waterwheel", 23.3], ["waterwheel", "i10", 30.7],
    ["i10", "taylor", 14.7], ["taylor", "cibola", 19.3],
    ["cibola", "picacho", 25.3], ["picacho", "martinez", 7.0]
  ];
  const segments = [];
  for (const [a, b, mi] of PAIRS) {
    if (by[a] && by[b] && by[a].flow.length && by[b].flow.length) {
      const x = xcorrPair(by[a].flow, by[b].flow, mi);
      if (x) segments.push({ from: a, to: b, miles: mi, ...x });
    }
  }
  if (!segments.length) return null;
  const mphs = segments.map(s => s.mph).sort((p, q) => p - q);
  const waveMph = +(mphs[Math.floor(mphs.length / 2)]).toFixed(1);
  return { waveMph, segments };
}

// Fetch JSON with retries: Reclamation's generator sometimes serves a truncated
// file mid-rewrite; a short wait and a second try usually gets a whole one.
async function fetchJsonRetry(url, tries = 3) {
  let lastErr, lastText = null;
  const diag = [];
  // Escalating strategies: a CDN can hold a corrupted cached copy of ONE compression
  // variant (same-byte truncation every time, while browsers on another variant see a
  // healthy file). Attempt 2 asks for the uncompressed variant; attempt 3 changes the
  // cache key entirely to force a fresh copy.
  const attempts = [
    { url: url, headers: { "User-Agent": "Mozilla/5.0 (compatible; blythe-river-bot)", "Accept": "application/json" } },
    { url: url, headers: { "User-Agent": "Mozilla/5.0 (compatible; blythe-river-bot)", "Accept": "application/json", "Accept-Encoding": "identity" } },
    { url: url + (url.includes("?") ? "&" : "?") + "v=" + Date.now(), headers: { "User-Agent": "Mozilla/5.0 (compatible; blythe-river-bot)", "Accept": "application/json", "Accept-Encoding": "identity" } },
  ];
  for (let i = 0; i < Math.max(tries, attempts.length); i++) {
    const a = attempts[Math.min(i, attempts.length - 1)];
    try {
      const r = await fetch(a.url, { headers: a.headers });
      if (!r.ok) throw new Error("HTTP " + r.status);
      lastText = await r.text();
      diag.push("[try " + (i + 1) + " enc=" + (r.headers.get("content-encoding") || "none") + " len=" + lastText.length + "]");
      return { ok: true, json: JSON.parse(lastText), salvaged: false, diag };
    } catch (e) {
      lastErr = e;
      diag.push("[try " + (i + 1) + " " + String(e && e.message ? e.message : e).slice(0, 90) + "]");
      if (i < Math.max(tries, attempts.length) - 1) await new Promise((res) => setTimeout(res, 12000));
    }
  }
  lastErr.diag = diag;
  // Last resort: Reclamation sometimes serves a file truncated mid-array.
  // Cut back to the last complete station record and close the brackets.
  if (lastText) {
    const s = salvageJson(lastText);
    if (s) return { ok: true, json: s, salvaged: true };
  }
  throw lastErr;
}

function salvageJson(text) {
  let t = text;
  for (let k = 0; k < 8; k++) {
    const i = t.lastIndexOf("}]}"); // end of a complete series object
    if (i < 1000) return null;
    try { return JSON.parse(t.slice(0, i + 3) + "]}"); }
    catch (e) { t = t.slice(0, i); }
  }
  return null;
}

function loadPrevious() {
  // On non-main branches the workflow renames the output to riverdata-<branch>.json
  // AFTER this script runs, so the freshest previous data lives under that name —
  // read it first or carry-forward (and the history archive) would silently reset.
  const branch = process.env.GITHUB_REF_NAME;
  const candidates = [];
  if (branch && branch !== "main") candidates.push("data/riverdata-" + branch + ".json");
  candidates.push("data/riverdata.json");
  for (const f of candidates) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {}
  }
  return null;
}

// ---------- Past-year history ----------
// Two sources, one goal: let the dashboard say whether today's water is high
// for the YEAR, not just for this week.
//  1. USGS daily-values backfill — the only public source with a year+ of
//     record on this reach; five gauges along it publish daily stats.
//  2. A day-by-day min/avg/max archive accumulated from Reclamation's hourly
//     sensors on every run, so the USBR-only sites grow their own history.
// Points are compact arrays: [tMstMidnight, avg, min, max] (accum adds a 5th
// element, the sample count, used only for merging).
const HIST_DAYS = 400;
const HIST_REFRESH_MS = +(process.env.HISTORY_REFRESH_MS || 6 * 3600 * 1000);
const HIST_VERSION = 8; // bump when the site list / fetch logic changes so a carried-forward backfill refetches immediately
const HIST_USGS = [
  { id: "09423000", key: "belowdavisusgs", name: "Colorado River below Davis Dam (USGS)" },
  { id: "09424000", key: "topockg",        name: "Colorado River near Topock (USGS)" },
  { id: "09427520", key: "parker",         name: "Colorado River below Parker Dam (USGS)" },
  { id: "09429100", key: "belowpv",        name: "Colorado River below Palo Verde Dam (USGS)" },
  // NOT 09429500 — that gauge sits BELOW Imperial Dam and reads the ~500 cfs
  // left after the All-American Canal diversion, which says nothing about the
  // water at Martinez Lake. 09429490 is the above-dam gauge.
  { id: "09429490", key: "martinez",       name: "Colorado River above Imperial Dam (USGS)" },
];
const HIST_UA = { "User-Agent": "Mozilla/5.0 (compatible; blythe-river-bot)", "Accept": "application/json" };

// Instantaneous-values fallback: several gauges on this reach never publish
// daily statistics but do keep years of 15-minute data. Pull a year in
// ~100-day chunks and reduce to daily min/avg/max ourselves.
async function fetchUsgsIvDaily(id, days, chunkDiag, param) {
  const DAY = 86400000, OFF = 7 * 3600 * 1000;
  const byDay = {};
  const end = Date.now();
  const decimals = param === "00065" ? 2 : 0; // stage needs its decimals, flow doesn't
  let total = 0;
  const ingest = (j) => {
    let n = 0, series = 0;
    for (const ts of (j.value && j.value.timeSeries) || []) {
      series++;
      for (const block of ts.values || []) {
        for (const v of block.value || []) {
          const num = parseFloat(v.value);
          if (!isFinite(num) || num <= -999990) continue;
          const t = new Date(v.dateTime).getTime();
          if (!isFinite(t)) continue;
          const d = Math.floor((t - OFF) / DAY) * DAY + OFF;
          (byDay[d] = byDay[d] || []).push(num);
          n++;
        }
      }
    }
    total += n;
    return { series, n };
  };
  for (let c = 0; c < Math.ceil(days / 100); c++) {
    const e = new Date(end - c * 100 * DAY);
    const s = new Date(Math.max(end - (c + 1) * 100 * DAY, end - days * DAY));
    if (e <= s) break;
    const url = "https://waterservices.usgs.gov/nwis/iv/?format=json&sites=" + id +
      "&parameterCd=" + param + "&startDT=" + s.toISOString().slice(0, 10) + "&endDT=" + e.toISOString().slice(0, 10) + "&siteStatus=all";
    try {
      const r = await fetch(url, { headers: HIST_UA });
      const body = await r.text();
      let got = { series: 0, n: 0 };
      if (r.ok) { try { got = ingest(JSON.parse(body)); } catch (pe) { if (chunkDiag) chunkDiag.push("c" + c + ":parse " + String(pe.message).slice(0, 40)); continue; } }
      if (chunkDiag) chunkDiag.push("c" + c + ":" + r.status + " len" + body.length + " ts" + got.series + " n" + got.n);
    } catch (fe) {
      if (chunkDiag) chunkDiag.push("c" + c + ":fetch " + String(fe && fe.message ? fe.message : fe).slice(0, 40));
    }
  }
  // If the windowed requests produced nothing, fall back to the same URL shape
  // the dashboard uses live (period=), which is known to work for these sites.
  if (!total) {
    const url2 = "https://waterservices.usgs.gov/nwis/iv/?format=json&sites=" + id + "&parameterCd=" + param + "&period=P120D&siteStatus=all";
    try {
      const r2 = await fetch(url2, { headers: HIST_UA });
      const body2 = await r2.text();
      let got2 = { series: 0, n: 0 };
      if (r2.ok) { try { got2 = ingest(JSON.parse(body2)); } catch (pe) {} }
      if (chunkDiag) chunkDiag.push("p120:" + r2.status + " len" + body2.length + " ts" + got2.series + " n" + got2.n);
    } catch (fe) {
      if (chunkDiag) chunkDiag.push("p120:fetch " + String(fe && fe.message ? fe.message : fe).slice(0, 40));
    }
  }
  const rnd = (v) => +v.toFixed(decimals);
  return Object.keys(byDay).map((d) => {
    const vs = byDay[d];
    const avg = vs.reduce((s, v) => s + v, 0) / vs.length;
    return [+d, rnd(avg), rnd(Math.min.apply(null, vs)), rnd(Math.max.apply(null, vs))];
  }).sort((a, b) => a[0] - b[0]);
}

async function fetchUsgsHistory(diag) {
  const ids = HIST_USGS.map((s) => s.id).join(",");
  const url = "https://waterservices.usgs.gov/nwis/dv/?format=json&sites=" + ids +
    "&parameterCd=00060,00065&statCd=00003,00001,00002&period=P" + HIST_DAYS + "D&siteStatus=all";
  const r = await fetch(url, { headers: HIST_UA });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const sites = {};
  for (const ts of (j.value && j.value.timeSeries) || []) {
    const siteId = ts.sourceInfo && ts.sourceInfo.siteCode && ts.sourceInfo.siteCode[0] && ts.sourceInfo.siteCode[0].value;
    const def = HIST_USGS.find((s) => s.id === siteId);
    if (!def) continue;
    const param = ts.variable && ts.variable.variableCode && ts.variable.variableCode[0] && ts.variable.variableCode[0].value;
    const kind = param === "00060" ? "flow" : param === "00065" ? "stage" : null;
    if (!kind) continue;
    let stat = null;
    try { stat = ts.variable.options.option[0].optionCode; } catch (e) {}
    const slot = stat === "00001" ? 3 : stat === "00002" ? 2 : 1; // [t, avg, min, max]
    const site = (sites[def.key] = sites[def.key] || { id: def.id, name: def.name, flow: {}, stage: {} });
    if (ts.sourceInfo && ts.sourceInfo.siteName) site.name = ts.sourceInfo.siteName + " (USGS)";
    for (const block of ts.values || []) { // a series can split across method blocks
      for (const v of block.value || []) {
        const m = String(v.dateTime).match(/^(\d{4})-(\d{2})-(\d{2})/);
        const num = parseFloat(v.value);
        if (!m || !isFinite(num) || num <= -999990) continue; // -999999 = USGS missing-value sentinel
        const t = Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0) + 7 * 3600 * 1000; // MST midnight
        (site[kind][t] = site[kind][t] || [t, null, null, null])[slot] = num;
      }
    }
  }
  const out = {};
  for (const key of Object.keys(sites)) {
    const s = sites[key], o = { id: s.id, name: s.name };
    for (const kind of ["flow", "stage"]) {
      const arr = Object.values(s[kind])
        .filter((p) => p[1] != null || p[2] != null || p[3] != null)
        .sort((a, b) => a[0] - b[0]);
      if (arr.length) o[kind] = arr;
    }
    if (o.flow || o.stage) out[key] = o;
  }
  // Sites the daily service can't cover get the instantaneous-values fallback.
  for (const def of HIST_USGS) {
    const have = out[def.key] && out[def.key].flow && out[def.key].flow.length >= 300;
    if (have) { if (diag) diag.push(def.key + ":dv" + out[def.key].flow.length + "d"); continue; }
    try {
      const chunkDiag = [];
      let daily = await fetchUsgsIvDaily(def.id, HIST_DAYS, chunkDiag, "00060");
      let kind = "flow";
      if (daily.length < 60) {
        // Regulated-reach gauges here often publish NO discharge at all — just
        // gage height. A year of stage still answers "is the water high".
        chunkDiag.push("| 00065:");
        const st = await fetchUsgsIvDaily(def.id, HIST_DAYS, chunkDiag, "00065");
        if (st.length > daily.length) { daily = st; kind = "stage"; }
      }
      if (daily.length >= 60 && !(out[def.key] && out[def.key][kind] && out[def.key][kind].length >= daily.length)) {
        out[def.key] = Object.assign(out[def.key] || { id: def.id, name: def.name }, { derived: "iv" });
        out[def.key][kind] = daily;
        if (diag) diag.push(def.key + ":iv-" + kind + daily.length + "d");
      } else if (diag) diag.push(def.key + ":none(" + daily.length + "d iv) [" + chunkDiag.join(" ") + "]");
    } catch (e) {
      if (diag) diag.push(def.key + ":err " + String(e && e.message ? e.message : e).slice(0, 60));
    }
  }
  // The daily-values feed for these sites carries means only — no daily
  // min/max — which leaves the year chart with no low–high band. Derive the
  // band from the 15-minute record and merge it into the daily rows.
  for (const def of HIST_USGS) {
    const site = out[def.key];
    if (!site || !site.flow || site.derived === "iv") continue;
    const missing = site.flow.filter((p) => p[2] == null || p[3] == null).length;
    if (missing < site.flow.length * 0.3) continue;
    try {
      const cd = [];
      const daily = await fetchUsgsIvDaily(def.id, HIST_DAYS, cd, "00060");
      if (daily.length) {
        const by = {};
        for (const p of daily) by[p[0]] = p;
        let filled = 0;
        for (const p of site.flow) {
          const q = by[p[0]];
          if (q) { if (p[2] == null) p[2] = q[2]; if (p[3] == null) p[3] = q[3]; if (p[1] == null) p[1] = q[1]; filled++; }
        }
        if (diag) diag.push(def.key + ":+minmax" + filled + "d");
      } else if (diag) diag.push(def.key + ":minmax0 [" + cd.join(" ") + "]");
    } catch (e) {
      if (diag) diag.push(def.key + ":minmax err " + String(e && e.message ? e.message : e).slice(0, 40));
    }
  }
  return out;
}

// Reclamation's daily water accounting (accumweb.json) keeps a full YEAR of
// daily average releases for Davis (Lake Mohave) and Parker (Lake Havasu) —
// the exact anchors the upper/lake/strip/mid reaches need, since USGS retains
// no history for its gauges up there. Daily averages only (no min/max band).
const ACCUMWEB = "https://www.usbr.gov/lc/region/g4000/riverops/webreports/accumweb.json";
async function fetchAccumHistory(diag) {
  const r = await fetch(ACCUMWEB, { headers: HIST_UA });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const defs = [
    { key: "davis",  site: /^lake mohave$/i, dtype: /average total release/i, kind: "flow",  round: 0, name: "Davis Dam daily release — Reclamation water accounting" },
    { key: "parker", site: /^lake havasu$/i, dtype: /average total release/i, kind: "flow",  round: 0, name: "Parker Dam daily release — Reclamation water accounting" },
    { key: "havasu", site: /^lake havasu$/i, dtype: /ws elevation/i,          kind: "stage", round: 2, name: "Lake Havasu daily elevation — Reclamation water accounting" },
  ];
  const out = {};
  for (const def of defs) {
    const s = (j.Series || []).find((x) => def.site.test((x.SiteName || "").trim()) && def.dtype.test(x.DataTypeName || ""));
    if (!s) { if (diag) diag.push(def.key + ":accumweb-miss"); continue; }
    const rows = [];
    for (const d of s.Data || []) {
      const t = borToEpoch(d.t);
      const v = d.v === "" ? null : parseFloat(d.v);
      if (t && v != null && isFinite(v)) rows.push([t, +v.toFixed(def.round), null, null]);
    }
    rows.sort((a, b) => a[0] - b[0]);
    if (rows.length >= 300) {
      const entry = { id: null, name: def.name };
      entry[def.kind] = rows;
      out[def.key] = entry;
      if (diag) diag.push(def.key + ":accumweb-" + def.kind + rows.length + "d");
    }
    else if (diag) diag.push(def.key + ":accumweb-short" + rows.length + "d");
  }
  return out;
}

function accumulateDaily(stations, prevAccum) {
  const DAY = 86400000, OFF = 7 * 3600 * 1000;
  const prevSites = (prevAccum && prevAccum.sites) || {};
  const outSites = {};
  const today = Math.floor((Date.now() - OFF) / DAY) * DAY + OFF;
  for (const st of stations || []) {
    const entry = {};
    for (const kind of ["flow", "stage"]) {
      const pts = st[kind] || [];
      const byDay = {};
      for (const p of pts) {
        const d = Math.floor((p.t - OFF) / DAY) * DAY + OFF;
        (byDay[d] = byDay[d] || []).push(p.v);
      }
      const merged = {};
      for (const p of (prevSites[st.key] && prevSites[st.key][kind]) || []) merged[p[0]] = p;
      for (const d of Object.keys(byDay)) {
        const vs = byDay[d];
        const avg = vs.reduce((s, v) => s + v, 0) / vs.length;
        const fresh = [+d, +avg.toFixed(2), +Math.min.apply(null, vs).toFixed(2), +Math.max.apply(null, vs).toFixed(2), vs.length];
        const old = merged[d];
        // Keep whichever aggregate saw more of the day — a frozen full day must
        // not be overwritten by a thinner re-read after a feed outage. Today is
        // always still filling, so the fresh read wins there.
        if (!old || +d === today || (old[4] || 0) <= fresh[4]) merged[d] = fresh;
      }
      const cutoff = Date.now() - HIST_DAYS * DAY;
      const arr = Object.values(merged).filter((p) => p[0] >= cutoff).sort((a, b) => a[0] - b[0]);
      if (arr.length) entry[kind] = arr;
    }
    if (entry.flow || entry.stage) outSites[st.key] = entry;
  }
  // stations that missed this run keep their archive
  for (const key of Object.keys(prevSites)) if (!outSites[key]) outSites[key] = prevSites[key];
  return { updatedAt: new Date().toISOString(), sites: outSites };
}

// ---------- HTML daily-report fallback ----------
// Reclamation runs TWO export pipelines: hourlyweb.json (which this robot
// prefers) and the server-rendered "Lower Colorado River Daily Report"
// (hourly7.html, 7 days of tables). In July 2026 the JSON froze for a full
// day while the HTML report stayed current, so when the JSON's newest reading
// goes stale we parse the report and merge in the newer hours. The merge only
// adds points NEWER than what the JSON provided, so the moment the JSON
// recovers the fallback naturally contributes nothing.
const HOURLY7 = "https://www.usbr.gov/lc/region/g4000/riverops/hourly7.html";
const HTML_STALE_MS = +(process.env.HTML_FALLBACK_AFTER_MS || 3 * 3600 * 1000);
// Report column heading -> station key. "RS 41" = "River Section 41" = the
// Topock gauge (verified by value-matching against hourlyweb.json). "Below
// Needles Bridge" is a DIFFERENT gauge from "Below Interstate Bridge" (values
// disagree), and the report carries no Interstate Bridge column, so the
// interstate sensor simply gets no HTML backup.
const HTML_COLS = [
  { re: /parker gage/i, key: "parkergage" },
  { re: /water wheel/i, key: "waterwheel" },
  { re: /i-?\s?10 bridge/i, key: "i10" },
  { re: /mcintyre/i, key: "mcintyrepark" },
  { re: /taylor/i, key: "taylor" },
  { re: /oxbow/i, key: "oxbow" },
  { re: /cibola/i, key: "cibola" },
  { re: /picacho/i, key: "picacho" },
  { re: /martinez/i, key: "martinez" },
  { re: /big bend/i, key: "bigbend" },
  { re: /rs\s*41/i, key: "topockg" },
];
function parseHourly7(html) {
  const stations = {}, havasu = [];
  const add = (key, kind, t, v) => {
    (stations[key] = stations[key] || { flow: [], stage: [] })[kind].push({ t, v });
  };
  // Each day's tables sit under an accordion heading like "Sunday, 07-12-2026";
  // associate every table with the nearest preceding date heading.
  const dates = [];
  const dre = /(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),\s*(\d{2})-(\d{2})-(\d{4})/g;
  let dm;
  while ((dm = dre.exec(html))) dates.push({ idx: dm.index, mo: +dm[1], d: +dm[2], y: +dm[3] });
  const tre = /<table[\s\S]*?<\/table>/gi;
  let tm;
  while ((tm = tre.exec(html))) {
    const tbl = tm[0];
    let day = null;
    for (const d of dates) if (d.idx < tm.index && (!day || d.idx > day.idx)) day = d;
    if (!day) continue;
    const t0 = Date.UTC(day.y, day.mo - 1, day.d, 0, 0, 0) + 7 * 3600 * 1000; // MST midnight
    const groups = [];
    const thre = /<th colspan="(\d)"[^>]*>([\s\S]*?)<\/th>/gi;
    let th;
    while ((th = thre.exec(tbl))) groups.push({ span: +th[1], name: th[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() });
    if (!groups.length) continue;
    const dams = groups.some((g) => /HOOVER|MOHAVE/i.test(g.name));
    const rre = /<tr>\s*<td[^>]*>\s*(\d{4})-(\d{4})\s*<\/td>([\s\S]*?)<\/tr>/gi;
    let rw;
    while ((rw = rre.exec(tbl))) {
      const startH = Math.floor(+rw[1] / 100);
      if (!(startH >= 0 && startH <= 23)) continue;
      const t = t0 + startH * 3600 * 1000; // hourlyweb.json stamps each hour-average at the interval START — verified against overlap
      const cells = [];
      const cre = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let c;
      while ((c = cre.exec(rw[3]))) {
        const raw = c[1].replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;/g, "").replace(/[, ]/g, "").trim();
        const v = raw === "" ? null : parseFloat(raw);
        cells.push(v != null && isFinite(v) ? v : null);
      }
      let ci = 0;
      for (const g of groups) {
        const vals = cells.slice(ci, ci + g.span);
        ci += g.span;
        if (dams) { // colspan-3 groups: ELEV, STORAGE, RELEASE
          if (/DAVIS/i.test(g.name) && vals[2] != null) add("davis", "flow", t, vals[2]);
          if (/HAVASU/i.test(g.name)) {
            if (vals[0] != null) havasu.push({ t, v: vals[0] });
            if (vals[2] != null) add("parker", "flow", t, vals[2]);
          }
        } else { // colspan-2 groups: STAGE, FLOW
          const map = HTML_COLS.find((m) => m.re.test(g.name));
          if (map) {
            if (vals[0] != null) add(map.key, "stage", t, vals[0]);
            if (vals[1] != null) add(map.key, "flow", t, vals[1]);
          }
        }
      }
    }
  }
  const bySorted = (arr) => arr.sort((a, b) => a.t - b.t);
  for (const k of Object.keys(stations)) { bySorted(stations[k].flow); bySorted(stations[k].stage); }
  return { stations, havasu: bySorted(havasu) };
}
function newestReading(stations) {
  let n = 0;
  for (const s of stations || []) for (const arr of [s.flow || [], s.stage || []]) for (const p of arr) if (p.t > n) n = p.t;
  return n;
}
async function mergeHtmlFallback(out, reason) {
  const r = await fetch(HOURLY7, { headers: { "User-Agent": "Mozilla/5.0 (compatible; blythe-river-bot)" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const parsed = parseHourly7(await r.text());
  const byKey = {};
  for (const s of out.stations) byKey[s.key] = s;
  let merged = 0, through = 0;
  for (const key of Object.keys(parsed.stations)) {
    let st = byKey[key];
    if (!st) {
      const def = REACH.find((d) => d.key === key);
      if (!def) continue;
      st = { key, name: def.name, role: def.role, order: def.order, primary: !!def.primary, source: "USBR", flow: [], stage: [] };
      out.stations.push(st);
      byKey[key] = st;
    }
    for (const kind of ["flow", "stage"]) {
      const lastT = st[kind].length ? st[kind][st[kind].length - 1].t : 0;
      for (const p of parsed.stations[key][kind]) {
        if (p.t > lastT) { st[kind].push(p); merged++; if (p.t > through) through = p.t; }
      }
    }
  }
  if (parsed.havasu.length) {
    const cur = (out.havasu && out.havasu.elev) || [];
    const lastT = cur.length ? cur[cur.length - 1].t : 0;
    const extra = parsed.havasu.filter((p) => p.t > lastT);
    if (extra.length) out.havasu = { elev: cur.concat(extra) };
  }
  out.htmlFallback = { reason, mergedPoints: merged, mergedThrough: through ? new Date(through).toISOString() : null };
  out.errors.push("reach: " + reason + " — merged " + merged + " points from the HTML daily report" + (through ? " (through " + new Date(through).toISOString() + ")" : ""));
}

async function main() {
  const prev = loadPrevious();
  const out = { generatedAt: new Date().toISOString(), stations: [], headgate: null, errors: [] };

  try {
    const rr = await fetchJsonRetry(BOR);
    const feed = rr.json;
    out.stations = buildStations(feed);
    out.siteNames = out.stations.siteNames || null;
    if (rr.salvaged) out.errors.push("reach: upstream feed was truncated \u2014 salvaged " + out.stations.length + " station(s) from the readable part");
    if (!out.stations.length) out.errors.push("reach: feed loaded but no known sites matched");
    const missed = REACH.filter((d) => !out.stations.find((x) => x.key === d.key)).map((d) => d.key);
    if (missed.length) out.errors.push("reach: no series matched for: " + missed.join(", "));
    const hav = toPoints(findSeries(feed.Series || [], ["havasu"], "elevation"));
    out.havasu = hav.length ? { elev: hav } : null;
  } catch (e) {
    out.errors.push("reach: " + (e && e.message ? e.message : e) + (e && e.diag ? " " + e.diag.join(" ") : ""));
    if (prev && prev.stations && prev.stations.length) {
      out.stations = prev.stations;
      out.havasu = prev.havasu || null;
      out.errors.push("reach: carried forward previous stations from " + prev.generatedAt);
    }
  }

  // If the JSON export has stalled (or failed entirely), top up from the
  // server-rendered HTML daily report. Recovers automatically: once the JSON
  // is fresh again, nothing in the report is newer, so nothing merges.
  const newest = newestReading(out.stations);
  if (!out.stations.length || Date.now() - newest > HTML_STALE_MS) {
    try {
      await mergeHtmlFallback(out, "hourlyweb.json stale (newest reading " + (newest ? new Date(newest).toISOString() : "none") + ")");
    } catch (e) {
      out.errors.push("htmlreport: " + (e && e.message ? e.message : e));
    }
  }
  out.calibration = calibrate(out.stations) || (prev && prev.calibration) || null;

  // Past-year history: refresh the USGS daily backfill a few times a day and
  // carry it forward between refreshes; fold today's hourly readings into the
  // per-sensor daily archive on every run.
  try {
    const prevHist = (prev && prev.history) || {};
    let usgsHist = prevHist.usgs || null;
    const histAge = usgsHist && usgsHist.fetchedAt ? Date.now() - new Date(usgsHist.fetchedAt).getTime() : Infinity;
    if (!(histAge < HIST_REFRESH_MS) || !usgsHist || usgsHist.v !== HIST_VERSION) {
      const diag = [];
      try {
        const sites = await fetchUsgsHistory(diag);
        // Reclamation's accounting fills the reaches USGS can't: Davis and
        // Parker daily releases, a full year each.
        try {
          const ac = await fetchAccumHistory(diag);
          for (const k of Object.keys(ac)) {
            if (!(sites[k] && sites[k].flow && sites[k].flow.length >= 300)) sites[k] = ac[k];
          }
        } catch (e) {
          diag.push("accumweb:err " + String(e && e.message ? e.message : e).slice(0, 60));
        }
        if (Object.keys(sites).length) usgsHist = { v: HIST_VERSION, fetchedAt: new Date().toISOString(), sites, diag: diag.join(", ") };
        else out.errors.push("history: USGS daily service returned no usable series" + (usgsHist ? " — kept previous backfill" : ""));
      } catch (e) {
        out.errors.push("history: " + (e && e.message ? e.message : e) + (usgsHist ? " — kept previous backfill" : ""));
      }
      if (diag.length) console.log("history diag:", diag.join(", "));
    }
    out.history = { usgs: usgsHist, accum: accumulateDaily(out.stations, prevHist.accum) };
    // Fold the robot's own daily min/max onto backfill rows that lack a band
    // (the Reclamation daily-release backfill is averages-only). Merged rows
    // are carried forward in the written file, so the shaded low–high band
    // grows day by day as the archive accretes.
    try {
      const hs = out.history.usgs && out.history.usgs.sites, as = out.history.accum && out.history.accum.sites;
      if (hs && as) for (const k of Object.keys(hs)) {
        const site = hs[k], acc = as[k];
        if (!site.flow || !acc || !acc.flow) continue;
        const by = {};
        for (const p of acc.flow) by[p[0]] = p;
        for (const row of site.flow) {
          const q2 = by[row[0]];
          if (q2) { if (row[2] == null && q2[2] != null) row[2] = q2[2]; if (row[3] == null && q2[3] != null) row[3] = q2[3]; }
        }
      }
    } catch (e) { /* band merge is best-effort */ }
  } catch (e) {
    out.errors.push("history: " + (e && e.message ? e.message : e));
    if (prev && prev.history) out.history = prev.history;
  }

  try {
    const pdf = require("pdf-parse/lib/pdf-parse.js");
    const r = await fetch(HG, { headers: { "User-Agent": "blythe-river-bot" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const text = (await pdf(buf, { pagerender: renderPage })).text;
    const parsed = parseHeadgate(text);
    out.headgate = parsed.downstream.length ? { downstream: parsed.downstream, parker: parsed.parker, critAvg: parsed.critAvg, note: parsed.note } : null;
    if (!parsed.downstream.length) {
      out.errors.push("headgate: parsed 0 rows (layout change?)");
      out.errors.push("headgate sample: " + text.slice(0, 500).replace(/\s+/g, " "));
    }
  } catch (e) {
    out.errors.push("headgate: " + (e && e.message ? e.message : e));
    if (prev && prev.headgate) { out.headgate = prev.headgate; out.errors.push("headgate: carried forward from " + prev.generatedAt); }
  }

  try {
    const pdf = require("pdf-parse/lib/pdf-parse.js");
    const r = await fetch(DP, { headers: { "User-Agent": "blythe-river-bot" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const sch = parseDavisParker((await pdf(buf, { pagerender: renderPage })).text);
    out.parkerSchedule = sch.parker.length ? { points: sch.parker } : null;
    out.davisSchedule = sch.davis.length ? { points: sch.davis } : null;
    if (!sch.parker.length) out.errors.push("davisparker: parsed 0 rows");
  } catch (e) {
    out.errors.push("davisparker: " + (e && e.message ? e.message : e));
    if (prev && prev.parkerSchedule) { out.parkerSchedule = prev.parkerSchedule; out.davisSchedule = prev.davisSchedule || null; out.errors.push("davisparker: carried forward from " + prev.generatedAt); }
  }

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/riverdata.json", JSON.stringify(out));
  const histUsgsN = out.history && out.history.usgs ? Object.keys(out.history.usgs.sites || {}).length : 0;
  const histAccumN = out.history && out.history.accum ? Object.keys(out.history.accum.sites || {}).length : 0;
  console.log(
    "stations:", out.stations.map((s) => s.key + ":" + s.flow.length + "f/" + s.stage.length + "s").join(", ") || "none",
    "| headgate pts:", out.headgate ? out.headgate.downstream.length : 0,
    "| history:", histUsgsN + " USGS backfill site(s), " + histAccumN + " accumulating",
    "| errors:", out.errors.join(" ; ") || "none"
  );
  if (!out.stations.length && !out.headgate) process.exit(1);
}

if (require.main === module) main();
module.exports = { parseHeadgate, buildStations, calibrate, xcorrPair, parseDavisParker, parseHourly7, newestReading, accumulateDaily, fetchUsgsHistory };
