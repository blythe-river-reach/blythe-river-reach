// POST { endpoint } -> sends one test notification to that subscription, so a
// person can confirm alerts really reach their phone (iPhone especially).
import { getStore } from "@netlify/blobs";
import webpush from "web-push";
import { createHash } from "node:crypto";
const keyFor = (endpoint) => createHash("sha256").update(String(endpoint)).digest("hex");
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY, subject = process.env.VAPID_SUBJECT || "mailto:river@istheriverup.com";
  if (!pub || !priv) return json({ error: "alerts are not configured on this site" }, 503);
  let body = {}; try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  if (!body.endpoint) return json({ error: "endpoint required" }, 400);
  const store = getStore({ name: "push-subs", consistency: "strong" });
  const rec = await store.get(keyFor(body.endpoint), { type: "json" }).catch(() => null);
  if (!rec || !rec.subscription) return json({ error: "not subscribed" }, 404);
  // at most one test a minute per subscription
  if (rec.testAt && Date.now() - rec.testAt < 60000) return json({ error: "give it a minute between tests" }, 429);
  webpush.setVapidDetails(subject, pub, priv);
  const nSpots = Object.keys(rec.spots || {}).length || (rec.spot ? 1 : 0);
  try {
    await webpush.sendNotification(rec.subscription, JSON.stringify({ title: "Is The River Up? \u2014 test", body: "Alerts are working on this device" + (nSpots ? " for " + nSpots + " spot" + (nSpots === 1 ? "" : "s") : "") + ".", url: "/alerts", tag: "test" }), { TTL: 600 });
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) { await store.delete(keyFor(body.endpoint)).catch(() => {}); return json({ error: "this device is no longer subscribed \u2014 turn alerts on again" }, 410); }
    return json({ error: "send failed (" + (e && e.statusCode || "?") + ")" }, 502);
  }
  rec.testAt = Date.now(); await store.setJSON(keyFor(body.endpoint), rec).catch(() => {});
  return json({ ok: true });
};

export const config = { path: "/api/push/test" };
