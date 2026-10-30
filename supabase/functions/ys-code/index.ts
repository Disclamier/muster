// Muster -> Yellowscribe proxy: the browser can't read yellowscribe.link replies (no CORS headers), so the app
// POSTs its .rosz here and gets back Yellowscribe's {"code":"xxxxxxxx"} (the Tabletop Simulator paste code).
// Holds no secrets; only forwards to one fixed Yellowscribe endpoint. Called with the public anon key.
const YS = "https://yellowscribe.link/makeArmyAndReturnCode";
const ORIGINS = ["https://disclamier.github.io", "http://127.0.0.1:18768", "http://localhost:18768"];
const MAX = 2 * 1024 * 1024;

function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Vary": "Origin",
  };
}
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  const name = (new URL(req.url).searchParams.get("filename") || "army.rosz").replace(/[^\w.\- ]/g, "_").slice(0, 80);
  if (!/\.rosz$/i.test(name)) return json(req, 400, { error: "filename must end in .rosz" });
  const body = new Uint8Array(await req.arrayBuffer());
  if (!body.length || body.length > MAX) return json(req, 413, { error: "empty or too large" });
  if (body[0] !== 0x50 || body[1] !== 0x4b) return json(req, 400, { error: "not a .rosz (zip)" });
  try {
    const r = await fetch(`${YS}?filename=${encodeURIComponent(name)}`, { method: "POST", body });
    const t = await r.text();
    let code = "";
    try { code = String(JSON.parse(t).code || ""); } catch { /* not json */ }
    if (!r.ok || !/^[0-9a-z]{4,16}$/i.test(code)) return json(req, 502, { error: "Yellowscribe gave no code", status: r.status });
    return json(req, 200, { code });
  } catch (e) {
    return json(req, 502, { error: "Yellowscribe unreachable" });
  }
});
