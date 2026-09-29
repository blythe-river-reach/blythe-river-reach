// POST (header x-run-key: PUSH_RUN_KEY) { branch } -> evaluates every
// subscription against the freshest riverdata for that branch and sends what
// is due. Called by the GitHub Action right after each data update, so it
// works on branch deploys too (Netlify's scheduled functions only run on the
// production deploy).
import { getStore } from "@netlify/blobs";
import webpush from "web-push";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const alerts = require("../lib/alerts.js");

const REPO = "blythe-river-reach/blythe-river-reach";
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const want = process.env.PUSH_RUN_KEY;
  if (!want || req.headers.get("x-run-key") !== want) return json({ error: "unauthorized" }, 401);
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY, subject = process.env.VAPID_SUBJECT || "mailto:river@istheriverup.com";
  if (!pub || !priv) return json({ error: "VAPID keys not configured" }, 503);
  webpush.setVapidDetails(subject, pub, priv);

  let body = {}; try { body = await req.json(); } catch (e) {}
  const branch = /^[a-z0-9-]{1,40}$/.test(String(body.branch || "")) ? body.branch : "main";
  const file = branch === "main" ? "data/riverdata.json" : "data/riverdata-" + branch + ".json";
  const r = await fetch("https://raw.githubusercontent.com/" + REPO + "/" + branch + "/" + file + "?t=" + Date.now(), { signal: AbortSignal.timeout(20000) });
  if (!r.ok) return json({ error: "data fetch " + r.status }, 502);
  const data = await r.json();

  const store = getStore("push-subs");
  const { blobs } = await store.list();
  const subs = [];
  for (const b of blobs) { const rec = await store.get(b.key, { type: "json" }).catch(() => null); if (rec && rec.subscription) subs.push(Object.assign(rec, { _key: b.key })); }

  const due = alerts.evaluate(data, subs, Date.now());
  let sent = 0, failed = 0, removed = 0;
  for (const { sub, messages } of due) {
    for (const m of messages) {
      try {
        await webpush.sendNotification(sub.subscription, JSON.stringify({ title: m.title, body: m.body, url: m.url, tag: m.tag }), { TTL: 6 * 3600 });
        sub.sent = sub.sent || {}; sub.sent[m.key] = Date.now(); sent++;
      } catch (e) {
        failed++;
        if (e && (e.statusCode === 404 || e.statusCode === 410)) { await store.delete(sub._key).catch(() => {}); removed++; sub._gone = true; break; }
      }
    }
    if (!sub._gone) {
      // keep the dedupe log small: drop keys older than 3 days
      const cut = Date.now() - 3 * 86400000; for (const k of Object.keys(sub.sent || {})) if (sub.sent[k] < cut) delete sub.sent[k];
      const { _key, _gone, ...rec } = sub; await store.setJSON(_key, rec).catch(() => {});
    }
  }
  return json({ ok: true, branch, subscribers: subs.length, due: due.length, sent, failed, removed, generatedAt: data.generatedAt });
};

export const config = { path: "/api/push/run" };
