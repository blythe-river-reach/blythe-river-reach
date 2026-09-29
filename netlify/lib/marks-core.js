// Depth marks: storage rules and validation, independent of Netlify so it can
// be tested with an in-memory store. Stores (each a key -> JSON record):
//   places   "<id>"                 user-added spots      status pending|approved|hidden
//   marks    "<spot>/<id>"          references at a spot  status pending|approved|hidden
//   readings "<markId>/<t>-<rand>"  one reading           status ok|flagged|hidden
//   ratelimit "<device>:<hour>"     submissions per device per hour
"use strict";
const M = require("../../marks-math.js");
const crypto = require("crypto");
const ID = () => crypto.randomBytes(6).toString("hex");
const DEVICE_RE = /^[a-z0-9-]{8,64}$/, KEY_RE = /^(u:)?[a-z0-9-]{2,48}$/;
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
const RATE_PER_HOUR = 30;

async function listAll(store, prefix) {
  const out = []; let cursor;
  do { const r = await store.list({ prefix, cursor }); for (const b of r.blobs || []) { const rec = await store.get(b.key, { type: "json" }).catch(() => null); if (rec) { rec._key = b.key; out.push(rec); } } cursor = r.cursor; } while (cursor);
  return out;
}
async function rateOk(stores, device) {
  const k = device + ":" + Math.floor(Date.now() / 3600000);
  const n = (await stores.ratelimit.get(k, { type: "json" }).catch(() => null)) || 0;
  if (n >= RATE_PER_HOUR) return false;
  await stores.ratelimit.setJSON(k, n + 1); return true;
}
const visible = (rec, device, admin) => admin || rec.status === "approved" || (rec.owner && rec.owner === device);
const pub = (rec, device) => { const o = Object.assign({}, rec); delete o._key; o.mine = !!(device && rec.owner === device); delete o.owner; delete o.ua; return o; };

// ---- places ----
async function listPlaces(stores, device, admin) { return (await listAll(stores.places, "")).filter((p) => visible(p, device, admin) && (admin || p.status !== "hidden")).map((p) => admin ? p : pub(p, device)); }
async function createPlace(stores, device, body) {
  if (!DEVICE_RE.test(device || "")) return { error: "device id required", status: 400 };
  const name = clean(body.name, 60), mile = +body.mile;
  if (name.length < 2) return { error: "give the place a name", status: 400 };
  if (!(mile >= 40 && mile <= 280)) return { error: "river mile out of range", status: 400 };
  if (!(await rateOk(stores, device))) return { error: "too many submissions this hour", status: 429 };
  const rec = { id: ID(), name, mile: +mile.toFixed(2), lat: isFinite(+body.lat) ? +(+body.lat).toFixed(5) : null, lon: isFinite(+body.lon) ? +(+body.lon).toFixed(5) : null, note: clean(body.note, 200), owner: device, status: "pending", createdAt: new Date().toISOString() };
  await stores.places.setJSON(rec.id, rec);
  return { ok: true, place: pub(rec, device) };
}
// ---- marks ----
async function listMarks(stores, device, admin, spot) {
  const all = await listAll(stores.marks, spot ? spot + "/" : "");
  return all.filter((m) => visible(m, device, admin) && (admin || m.status !== "hidden")).map((m) => admin ? m : pub(m, device));
}
async function createMark(stores, device, body) {
  if (!DEVICE_RE.test(device || "")) return { error: "device id required", status: 400 };
  const spot = String(body.spot || "");
  if (!KEY_RE.test(spot)) return { error: "spot required", status: 400 };
  const name = clean(body.name, 60), ref = clean(body.ref, 300);
  if (name.length < 2) return { error: "give the mark a name", status: 400 };
  if (ref.length < 8) return { error: "describe exactly where the reading is taken", status: 400 };
  const ladder = [];
  for (const r of (Array.isArray(body.ladder) ? body.ladder : []).slice(0, 12)) {
    const label = clean(r && r.label, 40); if (label.length < 1) continue;
    const h = (r && r.h != null && isFinite(+r.h)) ? +(+r.h).toFixed(2) : null;
    ladder.push({ id: "r" + (ladder.length + 1), label, h });
  }
  if (ladder.length === 1) return { error: "a ladder needs at least two landmarks (or none)", status: 400 };
  if (!(await rateOk(stores, device))) return { error: "too many submissions this hour", status: 429 };
  const rec = { id: ID(), spot, name, ref, ladder, lat: isFinite(+body.lat) ? +(+body.lat).toFixed(5) : null, lon: isFinite(+body.lon) ? +(+body.lon).toFixed(5) : null, owner: device, status: "pending", createdAt: new Date().toISOString() };
  await stores.marks.setJSON(spot + "/" + rec.id, rec);
  return { ok: true, mark: pub(rec, device) };
}
async function getMark(stores, id) { const all = await listAll(stores.marks, ""); return all.find((m) => m.id === id) || null; }
// ---- readings ----
function summarize(mark, readings, now) {
  const curve = M.fitDepth(readings, now), ladder = M.fitLadder(mark.ladder, readings, now);
  const ok = readings.filter((r) => r.status === "ok");
  return { curve, ladder, n: ok.length, lastT: ok.length ? Math.max.apply(null, ok.map((r) => r.t)) : null, flagged: readings.filter((r) => r.status === "flagged").length };
}
async function listReadings(stores, device, admin, markId) {
  const mark = await getMark(stores, markId); if (!mark || !visible(mark, device, admin)) return { error: "no such mark", status: 404 };
  const rs = (await listAll(stores.readings, mark.id + "/")).filter((r) => admin || r.status !== "hidden").sort((a, b) => a.t - b.t);
  return { ok: true, mark: admin ? mark : pub(mark, device), readings: rs.map((r) => admin ? r : pub(r, device)), summary: summarize(mark, rs, Date.now()) };
}
// levelFn(mark, t) -> { cfs, ft, stage } from the engine (injected: the
// Netlify wrapper fetches the branch's riverdata and runs river.js).
async function createReading(stores, device, body, levelFn) {
  if (!DEVICE_RE.test(device || "")) return { error: "device id required", status: 400 };
  const mark = await getMark(stores, String(body.mark || "")); if (!mark || !visible(mark, device, false)) return { error: "no such mark", status: 404 };
  const now = Date.now(), t = +body.t;
  if (!(t > now - 4 * 86400000 && t <= now + 15 * 60000)) return { error: "reading time must be within the last 4 days", status: 400 };
  const kind = String(body.kind || "");
  const rec = { id: ID(), mark: mark.id, t: Math.round(t), kind, owner: device, status: "ok", createdAt: new Date().toISOString(), note: clean(body.note, 140) };
  if (kind === "depth") { const d = +body.depth; if (!(d >= 0 && d <= 40)) return { error: "depth must be 0-40 ft", status: 400 }; rec.depth = +d.toFixed(2); }
  else if (kind === "rung" || kind === "between") {
    const ok = (id) => mark.ladder.some((r) => r.id === id);
    if (!ok(body.rung)) return { error: "pick a landmark", status: 400 }; rec.rung = body.rung;
    if (kind === "between") { if (!ok(body.rung2) || body.rung2 === body.rung) return { error: "pick two landmarks", status: 400 }; rec.rung2 = body.rung2; }
  } else if (kind === "over" || kind === "under") { if (!mark.ladder.length) return { error: "this mark has no landmarks", status: 400 }; rec.rung = kind === "over" ? mark.ladder[mark.ladder.length - 1].id : mark.ladder[0].id; }
  else return { error: "kind must be depth, rung, between, over or under", status: 400 };
  const lv = await levelFn(mark, rec.t);
  if (!lv || lv.stage == null) return { error: "no height gauge is modeled near this spot yet, so a reading can't be placed on the river's scale", status: 422 };
  rec.stage = +lv.stage.toFixed(3); rec.cfs = Math.round(lv.cfs); rec.ft = lv.ft != null ? +lv.ft.toFixed(2) : null;
  if (!(await rateOk(stores, device))) return { error: "too many submissions this hour", status: 429 };
  const prior = (await listAll(stores.readings, mark.id + "/")).filter((r) => r.status !== "hidden");
  const why = M.flagReading(rec, M.fitDepth(prior, now), M.fitLadder(mark.ladder, prior, now));
  if (why) { rec.status = "flagged"; rec.why = why; }
  await stores.readings.setJSON(mark.id + "/" + rec.t + "-" + rec.id, rec);
  const all = prior.concat([rec]);
  return { ok: true, reading: pub(rec, device), summary: summarize(mark, all, now) };
}
// ---- photos (one per mark; JPEG already shrunk by the page) ----
const PHOTO_MAX = 800 * 1024;
async function setPhoto(stores, device, admin, markId, buf, meta) {
  const mark = await getMark(stores, markId); if (!mark) return { error: "no such mark", status: 404 };
  if (!admin && mark.owner !== device) return { error: "only the mark's creator can add its photo", status: 403 };
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 1024 || b.length > PHOTO_MAX) return { error: "photo must be 1 KB - 800 KB (the page shrinks it first)", status: 413 };
  if (!(b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)) return { error: "photo must be a JPEG", status: 415 };
  if (!admin && !(await rateOk(stores, device))) return { error: "too many submissions this hour", status: 429 };
  await stores.photos.set(mark.id, b);
  const key = mark._key; delete mark._key;
  mark.photo = { at: Date.now(), bytes: b.length, w: meta && +meta.w || null, h: meta && +meta.h || null };
  await stores.marks.setJSON(key, mark);
  return { ok: true, photo: mark.photo };
}
async function photoFor(stores, device, admin, markId) {
  const mark = await getMark(stores, markId); if (!mark || !mark.photo) return { error: "no photo", status: 404 };
  if (!visible(mark, device, admin)) return { error: "no photo", status: 404 };
  const buf = await stores.photos.get(mark.id, { type: "arrayBuffer" }).catch(() => null);
  if (!buf) return { error: "no photo", status: 404 };
  return { ok: true, buf, photo: mark.photo, approved: mark.status === "approved" };
}
// ---- admin ----
async function queue(stores) {
  const places = await listAll(stores.places, ""), marks = await listAll(stores.marks, ""), readings = await listAll(stores.readings, "");
  return { places, marks, readings: readings.filter((r) => r.status === "flagged"), counts: { places: places.length, marks: marks.length, readings: readings.length } };
}
async function act(stores, body) {
  const type = String(body.type || ""), id = String(body.id || ""), action = String(body.action || "");
  const store = { place: stores.places, mark: stores.marks, reading: stores.readings }[type]; if (!store) return { error: "type", status: 400 };
  const all = await listAll(store, ""); const rec = all.find((r) => r.id === id); if (!rec) return { error: "not found", status: 404 };
  const key = rec._key; delete rec._key;
  if (action === "delete") { await store.delete(key); if (type === "mark") await stores.photos.delete(id).catch(() => {}); return { ok: true, deleted: id }; }
  if (action === "unphoto") { if (type !== "mark") return { error: "photos belong to marks", status: 400 }; await stores.photos.delete(id).catch(() => {}); delete rec.photo; await store.setJSON(key, rec); return { ok: true, record: rec }; }
  if (action === "setmile") { if (type !== "place") return { error: "mile only applies to places", status: 400 }; const mile = +body.mile; if (!(mile >= 40 && mile <= 280)) return { error: "mile out of range", status: 400 }; rec.mile = +mile.toFixed(2); rec.mileEditedAt = new Date().toISOString(); await store.setJSON(key, rec); return { ok: true, record: rec }; }
  const allowed = type === "reading" ? { ok: "ok", hide: "hidden" } : { approve: "approved", hide: "hidden", pending: "pending" };
  if (!allowed[action]) return { error: "action", status: 400 };
  rec.status = allowed[action]; rec.reviewedAt = new Date().toISOString();
  await store.setJSON(key, rec); return { ok: true, record: rec };
}
module.exports = { listPlaces, createPlace, listMarks, createMark, getMark, listReadings, createReading, setPhoto, photoFor, queue, act, summarize, DEVICE_RE };
