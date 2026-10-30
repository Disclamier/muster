const test = require("node:test"), assert = require("node:assert");
const fs = require("fs"), path = require("path");
const C = require("../app/js/core.js");
const app = fs.readFileSync(path.join(__dirname, "../app/js/app.js"), "utf8");

test("ysCodeFrom reads the Yellowscribe makeArmyAndReturnCode reply", () => {
  assert.strictEqual(C.ysCodeFrom('{ "code": "660b9701" }'), "660b9701");
  assert.strictEqual(C.ysCodeFrom({ code: " ab12cd34 " }), "ab12cd34");
  assert.strictEqual(C.ysCodeFrom("<html>error</html>"), null);
  assert.strictEqual(C.ysCodeFrom('{"err":"x"}'), null);
  assert.strictEqual(C.ysCodeFrom('{"code":"<script>"}'), null);
});

test("Yellowscribe export shows a copyable TTS code box", () => {
  assert.match(app, /data-testid="ys-code"/);
  assert.match(app, /data-action="ys-copy"/);
  assert.match(app, /functions\/v1\/ys-code/);
  assert.match(app, /"ys-copy": \(\) => ysCopy\(\)/);
});

test("detachment picker options have an eye that previews without selecting", () => {
  assert.match(app, /data-action="det-pop"[^>]*data-testid="det-eye"/);
  const h = app.slice(app.indexOf('"det-pop": (t, ev) =>'), app.indexOf('"ys-copy": ()'));
  assert.match(h, /ev\.preventDefault\(\)/);
  assert.match(h, /ev\.stopPropagation\(\)/);
  assert.doesNotMatch(h, /mutate\(/);
});

test("ysProxyCode: happy path goes through the Supabase ys-code function with the anon key only", async () => {
  const src = app.slice(app.indexOf("async function ysProxyCode"), app.indexOf("async function ysCopy"));
  const calls = [];
  const window = { MUSTER_CONFIG: { SUPABASE_URL: "https://x.supabase.co/", SUPABASE_ANON_KEY: "anonkey" } };
  const fetch = async (u, o) => { calls.push([u, o]); return { ok: true, text: async () => '{"code":"660b9701"}' }; };
  const f = new Function("window", "fetch", "C", "YS_URL", src + "; return ysProxyCode;")(window, fetch, C, "https://yellowscribe.link/");
  const code = await f({ filename: "My list.rosz", bytes: new Uint8Array([0x50, 0x4b]) });
  assert.strictEqual(code, "660b9701");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], "https://x.supabase.co/functions/v1/ys-code?filename=My%20list.rosz");
  assert.strictEqual(calls[0][1].headers.apikey, "anonkey");
  assert.doesNotMatch(app + fs.readFileSync(path.join(__dirname, "../supabase/functions/ys-code/index.ts"), "utf8"), /service_role/);
});

test("ysProxyCode falls back to direct Yellowscribe when the proxy fails", async () => {
  const src = app.slice(app.indexOf("async function ysProxyCode"), app.indexOf("async function ysCopy"));
  const urls = [];
  const fetch = async (u) => { urls.push(u); if (u.includes("supabase")) throw new Error("down"); return { ok: true, text: async () => '{"code":"abcd1234"}' }; };
  const f = new Function("window", "fetch", "C", "YS_URL", src + "; return ysProxyCode;")({ MUSTER_CONFIG: { SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "k" } }, fetch, C, "https://yellowscribe.link/");
  assert.strictEqual(await f({ filename: "a.rosz", bytes: new Uint8Array(2) }), "abcd1234");
  assert.match(urls[1], /yellowscribe\.link\/makeArmyAndReturnCode\?filename=a\.rosz/);
});
