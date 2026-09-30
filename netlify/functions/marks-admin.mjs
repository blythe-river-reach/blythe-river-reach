// Moderation for depth marks. Key: ADMIN_KEY env var (falls back to PUSH_RUN_KEY).
//   GET  /api/marks-admin            (header x-admin-key) -> full queue
//   POST /api/marks-admin            { type: place|mark|reading, id, action }
import { getStore } from "@netlify/blobs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const C = require("../lib/marks-core.js");
const E = require("../lib/engine-node.js");
let spotNames = null; // built-in spot key -> name, read once from river.js
function spots() { if (!spotNames) { try { const ctx = E.makeContext(); spotNames = {}; for (const p of ctx.PLACES) spotNames[p.key] = p.name; } catch (e) { spotNames = {}; } } return spotNames; }
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  const want = process.env.ADMIN_KEY || process.env.PUSH_RUN_KEY;
  if (!want) return json({ error: "ADMIN_KEY not configured" }, 503);
  if (req.headers.get("x-admin-key") !== want) return json({ error: "unauthorized" }, 401);
  const S = { places: getStore({ name: "marks-places", consistency: "strong" }), marks: getStore({ name: "marks-marks", consistency: "strong" }), readings: getStore({ name: "marks-readings", consistency: "strong" }), ratelimit: getStore({ name: "marks-ratelimit", consistency: "strong" }), photos: getStore({ name: "marks-photos", consistency: "strong" }), settings: getStore({ name: "marks-settings", consistency: "strong" }), feedback: getStore({ name: "marks-feedback", consistency: "strong" }) };
  try {
    const url = new URL(req.url), pid = url.searchParams.get("photo");
    if (req.method === "GET" && pid) { const r = await C.photoFor(S, "", true, pid); if (r.error) return json(r, r.status || 404); return new Response(r.buf, { status: 200, headers: { "content-type": "image/jpeg", "cache-control": "private, no-store" } }); }
    if (req.method === "GET") {
      // push subscribers by spot (counts only; no endpoints leave the function)
      let push = null;
      try {
        const ps = getStore({ name: "push-subs", consistency: "strong" }); const { blobs } = await ps.list(); const bySpot = {}; let n = 0;
        for (const b of blobs) { const rec = await ps.get(b.key, { type: "json" }).catch(() => null); if (rec && rec.subscription) { n++; const sp = rec.spots && typeof rec.spots === "object" ? Object.keys(rec.spots) : (rec.spot ? [rec.spot] : []); for (const k of sp) bySpot[k] = (bySpot[k] || 0) + 1; } }
        push = { total: n, bySpot };
      } catch (e) { push = { error: String(e && e.message || e) }; }
      return json({ ok: true, spots: spots(), push, ...(await C.queue(S)) });
    }
    if (req.method === "POST") {
      let body = {}; try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
      if (body.type === "settings") { const f = await C.setFlags(S, body); if (f.error) return json({ error: f.error }, f.status || 400); return json({ ok: true, flags: f }); }
      if (body.type === "runalerts") {
        const runKey = process.env.PUSH_RUN_KEY; if (!runKey) return json({ error: "PUSH_RUN_KEY not configured on this site" }, 503);
        const base = (process.env.DEPLOY_PRIME_URL || process.env.URL || "").replace(/\/$/, ""); if (!base) return json({ error: "site URL unknown" }, 500);
        const branch = /^[a-z0-9-]{1,40}$/.test(String(body.branch || "")) ? body.branch : "main";
        const r = await fetch(base + "/api/push/run", { method: "POST", headers: { "x-run-key": runKey, "content-type": "application/json" }, body: JSON.stringify({ branch }), signal: AbortSignal.timeout(50000) });
        const out = await r.json().catch(() => ({ error: "bad response " + r.status }));
        return json(out, r.ok ? 200 : 502);
      }
      const r = await C.act(S, body); return json(r, r.error ? (r.status || 400) : 200);
    }
    return json({ error: "method" }, 405);
  } catch (e) { return json({ error: String(e && e.message || e) }, 500); }
};

export const config = { path: "/api/marks-admin" };
