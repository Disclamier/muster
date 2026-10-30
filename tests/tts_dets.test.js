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
  assert.match(app, /makeArmyAndReturnCode\?filename=/);
  assert.match(app, /"ys-copy": \(\) => ysCopy\(\)/);
});

test("detachment picker options have an eye that previews without selecting", () => {
  assert.match(app, /data-action="det-pop"[^>]*data-testid="det-eye"/);
  const h = app.slice(app.indexOf('"det-pop": (t, ev) =>'), app.indexOf('"ys-copy": ()'));
  assert.match(h, /ev\.preventDefault\(\)/);
  assert.match(h, /ev\.stopPropagation\(\)/);
  assert.doesNotMatch(h, /mutate\(/);
});
