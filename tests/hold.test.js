/* Held factions (scraper/overrides/hold.json): published data kept, audit skips them instead of failing. */
const test = require("node:test"), assert = require("node:assert");
const P = require("../app/data/points.json"), H = require("../scraper/overrides/hold.json");
const { audit } = require("../audit/check_points.js");
test("held factions are marked in points.json and skipped by the points audit", () => {
  for (const fid of Object.keys(H.factions)) {
    const f = P.factions.find((x) => x.id === fid);
    assert.ok(f && f.held, fid);
    const r = audit({ factions: { [fid]: { units: [], detachments: [], unknown: ["would fail"] } } }, P, 1);
    assert.equal(r.issues.filter((x) => JSON.stringify(x).includes(fid)).length, 0); assert.ok(r.info.some((x) => /HELD/.test(x)));
  }
});
