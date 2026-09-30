// One stored record per device (push endpoint), holding a settings block per
// spot: { subscription, spots:{ <spotKey>: {prefs, sent, updatedAt} }, ... }.
// Older records carried a single spot/prefs/sent at the top level; spotsOf
// reads both shapes.
"use strict";
const MAX_SPOTS = 6;

function spotsOf(rec) {
  if (!rec) return {};
  if (rec.spots && typeof rec.spots === "object") return rec.spots;
  if (rec.spot) return { [rec.spot]: { prefs: rec.prefs || {}, sent: rec.sent || {}, updatedAt: rec.updatedAt || null } };
  return {};
}

// Flatten records into one virtual subscription per spot for the rules engine.
// The "data outage" alert is device-wide, so only the first spot carries it.
function expand(rec, key) {
  const spots = spotsOf(rec), out = [];
  Object.keys(spots).forEach((spot, i) => {
    const s = spots[spot] || {};
    const prefs = Object.assign({}, s.prefs || {});
    if (i > 0) prefs.stale = false;
    out.push({ subscription: rec.subscription, spot, prefs, sent: s.sent || {}, _key: key, _rec: rec });
  });
  return out;
}

module.exports = { MAX_SPOTS, spotsOf, expand };
