// Depth marks API (one function, several routes):
//   GET  /api/marks?spot=<key>       marks visible to this device (approved + its own pending)
//   POST /api/marks                  { spot, name, ref, ladder:[{label,h}], lat, lon }
//   GET  /api/places                 user-added places visible to this device
//   POST /api/places                 { name, mile, lat, lon, note }
//   GET  /api/readings?mark=<id>     readings + fitted curve/ladder for a mark
//   POST /api/readings               { mark, kind, depth|rung|rung2, t, branch, note }
// Every request carries x-device (a random id the page keeps in localStorage).
import { getStore } from "@netlify/blobs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const C = require("../lib/marks-core.js");
const E = require("../lib/engine-node.js");
const REPO = "blythe-river-reach/blythe-river-reach";
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const stores = () => ({ places: getStore("marks-places"), marks: getStore("marks-marks"), readings: getStore("marks-readings"), ratelimit: getStore("marks-ratelimit") });

// Engine on the freshest data for this branch; cached per warm function instance.
let cache = { branch: null, at: 0, ctx: null, data: null };
async function engineFor(branch) {
  if (cache.ctx && cache.branch === branch && Date.now() - cache.at < 5 * 60000) return cache;
  const file = branch === "main" ? "data/riverdata.json" : "data/riverdata-" + branch + ".json";
  const r = await fetch("https://raw.githubusercontent.com/" + REPO + "/" + branch + "/" + file + "?t=" + Date.now(), { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("data fetch " + r.status);
  const data = await r.json(); const ctx = E.makeContext(); E.loadData(ctx, data);
  cache = { branch, at: Date.now(), ctx, data }; return cache;
}

export default async (req) => {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, "");
  const device = String(req.headers.get("x-device") || "");
  if (!C.DEVICE_RE.test(device)) return json({ error: "device id required" }, 400);
  const S = stores();
  let body = {}; if (req.method === "POST") { try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); } }
  const send = (r) => json(r, r && r.error ? (r.status || 400) : 200);
  try {
    if (path.endsWith("/places")) {
      if (req.method === "GET") return json({ ok: true, places: await C.listPlaces(S, device, false) });
      if (req.method === "POST") return send(await C.createPlace(S, device, body));
    } else if (path.endsWith("/marks")) {
      if (req.method === "GET") return json({ ok: true, marks: await C.listMarks(S, device, false, url.searchParams.get("spot") || "") });
      if (req.method === "POST") return send(await C.createMark(S, device, body));
    } else if (path.endsWith("/readings")) {
      if (req.method === "GET") return send(await C.listReadings(S, device, false, url.searchParams.get("mark") || ""));
      if (req.method === "POST") {
        const branch = /^[a-z0-9-]{1,40}$/.test(String(body.branch || "")) ? body.branch : "main";
        const levelFn = async (mark, t) => {
          const eng = await engineFor(branch);
          let spot = mark.spot;
          if (spot.startsWith("u:")) { spot = await S.places.get(spot.slice(2), { type: "json" }).catch(() => null); if (!spot) return null; }
          return E.levelAt(eng.ctx, spot, t);
        };
        return send(await C.createReading(S, device, body, levelFn));
      }
    }
    return json({ error: "not found" }, 404);
  } catch (e) { return json({ error: String(e && e.message || e) }, 500); }
};

export const config = { path: ["/api/marks", "/api/places", "/api/readings"] };
