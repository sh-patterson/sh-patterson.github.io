import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ATLAS_GEOMETRY } from "./geometry.generated.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("generated geometry contains exactly 50 uniquely identified states", () => {
  const expectedCodes = "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
  assert.equal(ATLAS_GEOMETRY.states.length, 50);
  assert.equal(new Set(ATLAS_GEOMETRY.states.map((state) => state.code)).size, 50);
  assert.equal(new Set(ATLAS_GEOMETRY.states.map((state) => state.fips)).size, 50);
  assert.deepEqual(ATLAS_GEOMETRY.states.map((state) => state.code).sort(), expectedCodes.sort());
  assert.deepEqual(ATLAS_GEOMETRY.viewBox, [0, 0, 1000, 620]);
  for (const state of ATLAS_GEOMETRY.states) {
    assert.match(state.code, /^[A-Z]{2}$/);
    assert.match(state.fips, /^\d{2}$/);
    assert.ok(state.path.startsWith("M"));
    assert.equal(state.hitPath, state.path);
    assert.equal(state.glyphPoints.length, 28);
    assert.ok(state.centroid.every(Number.isFinite), `${state.code} centroid must be finite`);
    assert.ok(state.bounds.every(Number.isFinite), `${state.code} bounds must be finite`);
  }
});

test("geometry provenance is pinned", () => {
  assert.equal(ATLAS_GEOMETRY.source.sha256, "efddd884f1442ef233b1ba9c12dddbd66b6fdf94da6a373e1556aefe3dbc5751");
  assert.equal(ATLAS_GEOMETRY.generatorVersion, "field-atlas-geometry/1.0.0");
});

test("generated runtime module is byte-stable and stays under the gzip budget", async () => {
  const source = await readFile(path.join(root, "atlas", "geometry.generated.js"));
  assert.equal(createHash("sha256").update(source).digest("hex"), "4faefba6a4db7d4399109ac30ad6f311eb488328d0854cf51f589cf39ab5c565");
  assert.ok(gzipSync(source, { level: 9 }).byteLength < 80 * 1024);
});
