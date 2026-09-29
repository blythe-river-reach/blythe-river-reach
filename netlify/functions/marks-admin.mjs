// Moderation for depth marks. Key: ADMIN_KEY env var (falls back to PUSH_RUN_KEY).
//   GET  /api/marks-admin            (header x-admin-key) -> full queue
//   POST /api/marks-admin            { type: place|mark|reading, id, action }
import { getStore } from "@netlify/blobs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const C = require("../lib/marks-core.js");
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  const want = process.env.ADMIN_KEY || process.env.PUSH_RUN_KEY;
  if (!want) return json({ error: "ADMIN_KEY not configured" }, 503);
  if (req.headers.get("x-admin-key") !== want) return json({ error: "unauthorized" }, 401);
  const S = { places: getStore("marks-places"), marks: getStore("marks-marks"), readings: getStore("marks-readings"), ratelimit: getStore("marks-ratelimit"), photos: getStore("marks-photos") };
  try {
    const url = new URL(req.url), pid = url.searchParams.get("photo");
    if (req.method === "GET" && pid) { const r = await C.photoFor(S, "", true, pid); if (r.error) return json(r, r.status || 404); return new Response(r.buf, { status: 200, headers: { "content-type": "image/jpeg", "cache-control": "private, no-store" } }); }
    if (req.method === "GET") return json({ ok: true, ...(await C.queue(S)) });
    if (req.method === "POST") { let body = {}; try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); } const r = await C.act(S, body); return json(r, r.error ? (r.status || 400) : 200); }
    return json({ error: "method" }, 405);
  } catch (e) { return json({ error: String(e && e.message || e) }, 500); }
};

export const config = { path: "/api/marks-admin" };
