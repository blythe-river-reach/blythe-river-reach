// Blob store namespaces. Netlify Blobs are site-wide, so without this the dev
// branch deploy and production would read and write the same places, marks,
// feedback, settings and push subscriptions. Production keeps the plain store
// names (existing subscribers stay put); every other deploy context gets a
// "<branch>--" prefix. The admin page can ask for the other set explicitly.
"use strict";
function deployInfo(context) {
  const c = (context && context.deploy && context.deploy.context) || process.env.CONTEXT || "";
  const branch = String(process.env.BRANCH || process.env.HEAD || "").trim();
  return { context: c || "unknown", branch, production: c === "production" };
}
function prefix(info, override) {
  if (override === "production") return "";
  const other = override === "branch" || !info.production;
  if (!other) return "";
  const b = (info.branch || "dev").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) || "dev";
  return b + "--";
}
function name(base, info, override) { return prefix(info, override) + base; }
module.exports = { deployInfo, prefix, name };
