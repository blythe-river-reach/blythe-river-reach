// POST   { subscription, spot, prefs }  -> stores/updates the subscription
// DELETE { endpoint }                   -> removes it
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const keyFor = (endpoint) => createHash("sha256").update(String(endpoint)).digest("hex");
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  const store = getStore({ name: "push-subs", consistency: "strong" });
  if (req.method === "GET") {
    const ep = new URL(req.url).searchParams.get("endpoint") || "";
    if (!ep) return json({ error: "endpoint required" }, 400);
    const rec = await store.get(keyFor(ep), { type: "json" }).catch(() => null);
    if (!rec) return json({ error: "not subscribed" }, 404);
    return json({ ok: true, spot: rec.spot, prefs: rec.prefs, sent: rec.sent || {}, updatedAt: rec.updatedAt });
  }
  let body = null;
  try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  if (req.method === "DELETE") {
    if (!body || !body.endpoint) return json({ error: "endpoint required" }, 400);
    await store.delete(keyFor(body.endpoint));
    return json({ ok: true });
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
  const rec = { subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, expirationTime: sub.expirationTime || null }, spot: body.spot, prefs, sent: (prev && prev.sent) || {}, createdAt: (prev && prev.createdAt) || new Date().toISOString(), updatedAt: new Date().toISOString(), ua: String(req.headers.get("user-agent") || "").slice(0, 160) };
  await store.setJSON(key, rec);
  return json({ ok: true, spot: rec.spot, prefs: rec.prefs });
};

export const config = { path: "/api/push/subscribe" };
