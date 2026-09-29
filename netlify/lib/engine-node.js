// Runs the page's shared engine (river.js) under Node so server-side alerts
// use EXACTLY the outlook/tide/travel-time logic the page shows. river.js only
// touches the DOM inside null-guarded render functions, so a tiny shim of the
// browser globals is enough.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");

function findRiverJs() {
  const cands = [path.join(__dirname, "..", "..", "river.js"), path.join(process.cwd(), "river.js")];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error("river.js not found next to the functions bundle");
}

function makeContext() {
  const noop = () => {};
  const nullEl = () => null;
  const fakeEl = () => ({ style: {}, appendChild: noop, insertBefore: noop, setAttribute: noop, addEventListener: noop, textContent: "", innerHTML: "", className: "" });
  const mem = {};
  const ctx = {
    console, Date, Math, JSON, Promise, Error, Array, Object, String, Number, RegExp, Uint8Array, isNaN, isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent,
    setTimeout: () => 0, setInterval: () => 0, clearTimeout: noop, clearInterval: noop,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    document: { getElementById: nullEl, querySelector: nullEl, querySelectorAll: () => [], addEventListener: noop, createElement: fakeEl, body: { className: "" }, head: { appendChild: noop }, visibilityState: "hidden", title: "", createTextNode: fakeEl },
    localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } },
    location: { hostname: "", pathname: "/", search: "", hash: "", origin: "" },
    navigator: {}, history: null,
    fetch: () => Promise.reject(new Error("engine-node: no network")),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
  };
  ctx.addEventListener = noop; ctx.removeEventListener = noop; ctx.matchMedia = () => ({ matches: false });
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(findRiverJs(), "utf8"), ctx, { filename: "river.js" });
  return ctx;
}

// Feed one riverdata.json into the engine (mirrors loadRelay's handler).
function loadData(ctx, j) {
  ctx.relayInfo = { t: new Date(j.generatedAt).getTime(), branch: null };
  if (j.calibration) { ctx.relayCal = j.calibration; if (j.calibration.waveMph >= 1 && j.calibration.waveMph <= 12) ctx.WAVE_MPH = j.calibration.waveMph; }
  ctx.borData = j.stations && j.stations.length ? { stations: j.stations } : null; ctx.borTried = true;
  ctx.hgData = j.headgate && j.headgate.downstream && j.headgate.downstream.length ? JSON.parse(JSON.stringify(j.headgate)) : null; ctx.hgTried = true;
  ctx.psData = j.parkerSchedule && j.parkerSchedule.points ? j.parkerSchedule.points.slice() : null;
  ctx.dsData = j.davisSchedule && j.davisSchedule.points ? j.davisSchedule.points.slice() : null;
  ctx.havasuData = j.havasu && j.havasu.elev ? j.havasu.elev : null;
  ctx.histData = j.history || null;
  ctx.usgsData = null;
  if (j.outlook && j.outlook.dams) { ctx.outlookData = j.outlook; ctx.applyOutlook(); }
  ctx.rebuild();
}

// The page's hero model for one spot, plus what the tiles compute.
function evalSpot(ctx, spotKey) {
  ctx.store.set(ctx.PLACE_KEY, spotKey);
  ctx.rebuild();
  const M = ctx.heroModel();
  return M;
}

module.exports = { makeContext, loadData, evalSpot };

// Modeled level at a spot (built-in key, or a user place {id,name,mile}) at
// time t: { cfs, ft (vs this week's average), stage (absolute sensor stage) }.
function levelAt(ctx, place, t) {
  let pl;
  if (typeof place === "string") pl = ctx.PLACES.find((p) => p.key === place);
  else if (place && place.mile > 0) { ctx.addUserPlaces([place]); pl = ctx.PLACES.find((p) => p.key === "u:" + place.id); }
  if (!pl) return null;
  ctx.store.set(ctx.PLACE_KEY, pl.key);
  ctx.rebuild();
  return ctx.levelAtSpot(pl, t);
}
module.exports.levelAt = levelAt;
