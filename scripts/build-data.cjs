// Runs in GitHub Actions (Node 20). Fetches Reclamation's hourly reach feed and the
// Headgate Rock Dam schedule PDF server-side (no CORS), parses both, and writes
// data/riverdata.json for the dashboard to read. Exits 0 if at least one source worked.

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
function findSeries(series, names, typePart) {
  return series.find((s) => {
    const n = (s.SiteName || "").toLowerCase();
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
  { key: "parker",       name: "Parker Dam release", role: "Release upstream \u00b7 early warning", order: 0, names: ["havasu"], releaseType: "release" },
  { key: "parkergage",   name: "Parker gage", role: "Below Headgate \u00b7 upper reach", order: 1, names: ["parker gage", "parker  gage"] },
  { key: "waterwheel",   name: "Water Wheel", role: "Reference sensor \u00b7 mid reach", order: 2, primary: true, names: ["water wheel"] },
  { key: "i10",          name: "Blythe (I-10 bridge)", role: "Reclamation sensor \u00b7 at Blythe", order: 3, names: ["i-10", "i 10", "interstate", "i10"] },
  { key: "mcintyrepark", name: "McIntyre Park", role: "Reclamation sensor \u00b7 south of Blythe", order: 5, names: ["mcintyre"] },
  { key: "taylor",       name: "Taylor Ferry", role: "Reclamation sensor \u00b7 below Blythe", order: 6, names: ["taylor"] },
  { key: "oxbow",        name: "Oxbow Bridge", role: "Reclamation sensor \u00b7 Cibola reach", order: 7, names: ["oxbow"] },
  { key: "cibola",       name: "Cibola gage", role: "Reclamation sensor \u00b7 Cibola reach", order: 8, names: ["cibola"] },
];

function buildStations(json) {
  const series = json.Series || [];
  const stations = [];
  for (const def of REACH) {
    let flow, stage = [];
    if (def.releaseType) {
      flow = toPoints(findSeries(series, def.names, def.releaseType) || findSeries(series, def.names, "flow"));
    } else {
      flow = toPoints(findSeries(series, def.names, "flow"));
      stage = toPoints(findSeries(series, def.names, "gage height"));
    }
    if (flow.length || stage.length) {
      stations.push({ key: def.key, name: def.name, role: def.role, order: def.order, primary: !!def.primary, source: "USBR", flow, stage });
    }
  }
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
    curr.push({ hr, parker: +r[7].replace(/,/g, "") });
  }
  if (curr && curr.length) tables.push(curr);
  const pm2 = text.match(/Date of Publication:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  const points = [];
  for (let i = 0; i < tables.length; i++) {
    const d = (dates.length === tables.length) ? dates[i] : (pm2 ? { mo: +pm2[1], d: +pm2[2] + i, y: +pm2[3] } : null);
    if (!d) continue;
    const t0 = Date.UTC(d.y, d.mo - 1, d.d, 0, 0, 0) + 7 * 3600 * 1000;
    for (const row of tables[i]) points.push({ t: t0 + row.hr * 3600 * 1000, v: row.parker });
  }
  const seen = {};
  for (const p of points) seen[p.t] = p.v;
  return Object.keys(seen).map((t) => ({ t: +t, v: seen[t] })).sort((a, b) => a.t - b.t);
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
    ["parkergage", "waterwheel", 23.3], ["waterwheel", "i10", 30.7],
    ["i10", "taylor", 14.7], ["taylor", "cibola", 19.3]
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

async function main() {
  const out = { generatedAt: new Date().toISOString(), stations: [], headgate: null, errors: [] };

  try {
    const r = await fetch(BOR + "?t=" + Date.now(), { headers: { "User-Agent": "blythe-river-bot", "Cache-Control": "no-cache", "Pragma": "no-cache" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const feed = await r.json();
    out.stations = buildStations(feed);
    if (!out.stations.length) out.errors.push("reach: feed loaded but no known sites matched");
    out.calibration = calibrate(out.stations);
    const hav = toPoints(findSeries(feed.Series || [], ["havasu"], "elevation"));
    out.havasu = hav.length ? { elev: hav } : null;
  } catch (e) {
    out.errors.push("reach: " + (e && e.message ? e.message : e));
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
  }

  try {
    const pdf = require("pdf-parse/lib/pdf-parse.js");
    const r = await fetch(DP, { headers: { "User-Agent": "blythe-river-bot" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const pts = parseDavisParker((await pdf(buf, { pagerender: renderPage })).text);
    out.parkerSchedule = pts.length ? { points: pts } : null;
    if (!pts.length) out.errors.push("davisparker: parsed 0 rows");
  } catch (e) {
    out.errors.push("davisparker: " + (e && e.message ? e.message : e));
  }

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/riverdata.json", JSON.stringify(out));
  console.log(
    "stations:", out.stations.map((s) => s.key + ":" + s.flow.length + "f/" + s.stage.length + "s").join(", ") || "none",
    "| headgate pts:", out.headgate ? out.headgate.downstream.length : 0,
    "| errors:", out.errors.join(" ; ") || "none"
  );
  if (!out.stations.length && !out.headgate) process.exit(1);
}

if (require.main === module) main();
module.exports = { parseHeadgate, buildStations, calibrate, xcorrPair, parseDavisParker };
