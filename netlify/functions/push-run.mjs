// POST (header x-run-key: PUSH_RUN_KEY) { branch } -> evaluates every
// subscription against the freshest riverdata for that branch and sends what
// is due. Called by the GitHub Action right after each data update, so it
// works on branch deploys too (Netlify's scheduled functions only run on the
// production deploy).
import { getStore } from "@netlify/blobs";
import webpush from "web-push";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const NS = require("../lib/ns.js");
const alerts = require("../lib/alerts.js");
const { spotsOf, expand } = require("../lib/push-subs.js");

const REPO = "blythe-river-reach/blythe-river-reach";
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req, context) => {
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

  const store = getStore({ name: NS.name("push-subs", NS.deployInfo(context)), consistency: "strong" });
  const { blobs } = await store.list();
  // One record per device; each carries a settings block per spot. Spots whose
  // chosen end passed more than a week ago are dropped (and the record with
  // them when none is left).
  const subs = [], recs = {}; let expired = 0, devices = 0;
  for (const b of blobs) {
    const rec = await store.get(b.key, { type: "json" }).catch(() => null); if (!(rec && rec.subscription)) continue;
    const spots = Object.assign({}, spotsOf(rec)); let dropped = 0;
    for (const k of Object.keys(spots)) {
      const u = spots[k] && spots[k].prefs && spots[k].prefs.until;
      if (u && Date.now() - new Date(u).getTime() > 7 * 86400000) { delete spots[k]; dropped++; }
    }
    if (dropped) {
      expired += dropped;
      if (!Object.keys(spots).length) { await store.delete(b.key).catch(() => {}); continue; }
      rec.spots = spots; delete rec.spot; delete rec.prefs; delete rec.sent; await store.setJSON(b.key, rec).catch(() => {});
    }
    devices++;
    const norm = { subscription: rec.subscription, spots, createdAt: rec.createdAt, updatedAt: rec.updatedAt, ua: rec.ua, testAt: rec.testAt };
    recs[b.key] = norm;
    for (const v of expand(norm, b.key)) subs.push(v);
  }

  const due = alerts.evaluate(data, subs, Date.now());
  let sent = 0, failed = 0, removed = 0; const dirty = {}, gone = {};
  for (const { sub, messages } of due) {
    if (gone[sub._key]) continue;
    for (const m of messages) {
      try {
        // the tag carries the spot so pings for two spots don't replace each other
        await webpush.sendNotification(sub.subscription, JSON.stringify({ title: m.title, body: m.body, url: m.url, tag: m.tag + ":" + sub.spot }), { TTL: 6 * 3600 });
        sub.sent = sub.sent || {}; for (const k of (m.keys || [m.key])) sub.sent[k] = Date.now(); sent++; dirty[sub._key] = true;
      } catch (e) {
        failed++;
        if (e && (e.statusCode === 404 || e.statusCode === 410)) { await store.delete(sub._key).catch(() => {}); removed++; gone[sub._key] = true; break; }
      }
    }
    if (!gone[sub._key]) {
      // keep the dedupe log small: drop keys older than 3 days
      const cut = Date.now() - 3 * 86400000; for (const k of Object.keys(sub.sent || {})) if (sub.sent[k] < cut) delete sub.sent[k];
      const rec = recs[sub._key]; if (rec && rec.spots[sub.spot]) rec.spots[sub.spot].sent = sub.sent;
    }
  }
  for (const k of Object.keys(dirty)) if (!gone[k]) await store.setJSON(k, recs[k]).catch(() => {});
  return json({ ok: true, branch, subscribers: devices, spots: subs.length, due: due.length, sent, failed, removed, expired, generatedAt: data.generatedAt });
};

export const config = { path: "/api/push/run" };
