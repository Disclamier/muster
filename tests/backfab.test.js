const test = require("node:test"), assert = require("node:assert");
const fs = require("fs"), path = require("path");
const app = fs.readFileSync(path.join(__dirname, "../app/js/app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../app/css/app.css"), "utf8");
test("no top-right X on dialogs/panels; boxed back arrow instead", () => {
  assert.doesNotMatch(app, /data-action="close-modal" title="Close">\$\{icon\("x"\)\}/);
  assert.doesNotMatch(app, /data-action="close-panel" title="Close">\$\{icon\("x"\)\}/);
  assert.match(app, /class="backfab" data-action="close-modal"[^>]*data-testid="back-btn">\$\{icon\("back"\)\}/);
  assert.match(app, /class="backfab" data-action="close-panel"[^>]*data-testid="back-btn">\$\{icon\("back"\)\}/);
  assert.match(css, /\.panel \.phead > \.backfab \{ position: absolute; right: 10px; bottom: 10px;/);
  assert.match(app, /ev\.key === "Escape"/);
});
