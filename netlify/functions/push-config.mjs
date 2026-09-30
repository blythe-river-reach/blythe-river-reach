// GET -> { enabled, publicKey } so the page can subscribe (public VAPID key only).
export default async () => {
  const pub = process.env.VAPID_PUBLIC_KEY || null, priv = process.env.VAPID_PRIVATE_KEY || null;
  return new Response(JSON.stringify({ enabled: !!(pub && priv), publicKey: pub }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
};
export const config = { path: "/api/push/config" };
