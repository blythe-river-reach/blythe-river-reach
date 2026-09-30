// GET    ?endpoint=                      -> the device's spots (prefs + what was sent)
// POST   { subscription, spot, prefs }   -> adds/updates that spot on the device (up to MAX_SPOTS)
// DELETE { endpoint, spot? }             -> removes one spot, or the whole device when no spot is given
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const NS = require("../lib/ns.js");
const { MAX_SPOTS, spotsOf } = require("../lib/push-subs.js");

const keyFor = (endpoint) => createHash("sha256").update(String(endpoint)).digest("hex");
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req, context) => {
  const store = getStore({ name: NS.name("push-subs", NS.deployInfo(context)), consistency: "strong" });
  if (req.method === "GET") {
    const ep = new URL(req.url).searchParams.get("endpoint") || "";
    if (!ep) return json({ error: "endpoint required" }, 400);
    const rec = await store.get(keyFor(ep), { type: "json" }).catch(() => null);
    if (!rec) return json({ error: "not subscribed" }, 404);
    return json({ ok: true, spots: spotsOf(rec), updatedAt: rec.updatedAt });
  }
  let body = null;
  try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  if (req.method === "DELETE") {
    if (!body || !body.endpoint) return json({ error: "endpoint required" }, 400);
    const k = keyFor(body.endpoint);
    if (body.spot) {
      const rec = await store.get(k, { type: "json" }).catch(() => null);
      if (!rec) return json({ ok: true, spots: [] });
      const spots = Object.assign({}, spotsOf(rec)); delete spots[String(body.spot)];
      if (!Object.keys(spots).length) { await store.delete(k); return json({ ok: true, spots: [] }); }
      await store.setJSON(k, { subscription: rec.subscription, spots, createdAt: rec.createdAt, updatedAt: new Date().toISOString(), ua: rec.ua, testAt: rec.testAt });
      return json({ ok: true, spots: Object.keys(spots) });
    }
    await store.delete(k);
    return json({ ok: true, spots: [] });
  }
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const sub = body && body.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json({ error: "subscription required" }, 400);
  if (!/^[a-z0-9-]{2,40}$/.test(String(body.spot || ""))) return json({ error: "spot required" }, 400);
  const p = body.prefs || {};
  const num = (v, lo, hi) => (v === null || v === undefined || v === "" || !isFinite(+v)) ? null : Math.max(lo, Math.min(hi, +(+v).toFixed(2)));
  const prefs = {
    brief: !!p.brief, briefHour: Math.min(21, Math.max(4, parseInt(p.briefHour, 10) || 7)), heads: !!p.heads, stale: !!p.stale,
    turns: !!p.turns, turnLead: [0, 30, 60, 120].includes(+p.turnLead) ? +p.turnLead : 60,
    level: !!p.level, levelHi: num(p.levelHi, -15, 15), levelLo: num(p.levelLo, -15, 15),
    weekend: !!p.weekend, quiet: p.quiet !== false && p.quiet !== "false",
    quietFrom: Math.min(23, Math.max(0, parseInt(p.quietFrom, 10) || 0)), quietTo: Math.min(23, Math.max(0, parseInt(p.quietTo, 10) || 0)),
    dur: /^(weekend|today|3d|7d|always)$/.test(String(p.dur || "")) ? p.dur : "always",
    until: (p.until && isFinite(+new Date(p.until)) && +new Date(p.until) > Date.now() && +new Date(p.until) < Date.now() + 60 * 86400000) ? new Date(p.until).toISOString() : null
  };
  if (!("quietFrom" in p)) { prefs.quietFrom = 22; prefs.quietTo = 6; }
  const key = keyFor(sub.endpoint);
  const prev = await store.get(key, { type: "json" }).catch(() => null);
  const spots = Object.assign({}, spotsOf(prev));
  if (!spots[body.spot] && Object.keys(spots).length >= MAX_SPOTS) return json({ error: "too many spots", max: MAX_SPOTS }, 400);
  spots[body.spot] = { prefs, sent: (spots[body.spot] && spots[body.spot].sent) || {}, updatedAt: new Date().toISOString() };
  const rec = { subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, expirationTime: sub.expirationTime || null }, spots, createdAt: (prev && prev.createdAt) || new Date().toISOString(), updatedAt: new Date().toISOString(), ua: String(req.headers.get("user-agent") || "").slice(0, 160), testAt: prev && prev.testAt };
  await store.setJSON(key, rec);
  return json({ ok: true, spot: body.spot, prefs, spots: Object.keys(spots) });
};

export const config = { path: "/api/push/subscribe" };
