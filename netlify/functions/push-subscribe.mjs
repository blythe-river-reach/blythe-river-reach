// POST   { subscription, spot, prefs }  -> stores/updates the subscription
// DELETE { endpoint }                   -> removes it
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const keyFor = (endpoint) => createHash("sha256").update(String(endpoint)).digest("hex");
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  let body = null;
  try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  const store = getStore("push-subs");
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
  const prefs = { brief: !!p.brief, briefHour: Math.min(21, Math.max(4, parseInt(p.briefHour, 10) || 7)), heads: !!p.heads, stale: !!p.stale };
  const key = keyFor(sub.endpoint);
  const prev = await store.get(key, { type: "json" }).catch(() => null);
  const rec = { subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, expirationTime: sub.expirationTime || null }, spot: body.spot, prefs, sent: (prev && prev.sent) || {}, createdAt: (prev && prev.createdAt) || new Date().toISOString(), updatedAt: new Date().toISOString(), ua: String(req.headers.get("user-agent") || "").slice(0, 160) };
  await store.setJSON(key, rec);
  return json({ ok: true, spot: rec.spot, prefs: rec.prefs });
};

export const config = { path: "/api/push/subscribe" };
