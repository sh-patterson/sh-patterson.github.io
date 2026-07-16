#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://www2.census.gov/geo/tiger/GENZ2025/kml/cb_2025_us_state_20m.zip";
const SOURCE_SHA256 = "efddd884f1442ef233b1ba9c12dddbd66b6fdf94da6a373e1556aefe3dbc5751";
const GENERATOR_VERSION = "field-atlas-geometry/1.0.0";
const VIEW_BOX = [0, 0, 1000, 620];
const STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
]);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outputPath = path.join(root, "atlas", "geometry.generated.js");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const archiveArg = args.find((arg) => !arg.startsWith("--"));
const archivePath = path.resolve(archiveArg || "/tmp/cb_2025_us_state_20m.zip");

function extractKml(buffer) {
  const result = spawnSync("unzip", ["-p", archivePath, "cb_2025_us_state_20m.kml"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Unable to extract Census KML: ${result.stderr.trim()}`);
  return result.stdout;
}

function attr(block, name) {
  const match = block.match(new RegExp(`<SimpleData name="${name}">([^<]*)<\\/SimpleData>`));
  return match?.[1]?.replaceAll("&amp;", "&") ?? "";
}

function coordinates(text) {
  return text.trim().split(/\s+/).map((tuple) => {
    const [lon, lat] = tuple.split(",").map(Number);
    return [lon, lat];
  }).filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

function parseKml(kml) {
  const states = [];
  for (const match of kml.matchAll(/<Placemark\b[\s\S]*?<\/Placemark>/g)) {
    const block = match[0];
    const code = attr(block, "STUSPS");
    if (!STATE_CODES.has(code)) continue;
    const polygons = [];
    for (const polygonMatch of block.matchAll(/<Polygon\b[\s\S]*?<\/Polygon>/g)) {
      const polygon = polygonMatch[0];
      const rings = [];
      const outer = polygon.match(/<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/outerBoundaryIs>/);
      if (outer) rings.push(coordinates(outer[1]));
      for (const inner of polygon.matchAll(/<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/innerBoundaryIs>/g)) {
        rings.push(coordinates(inner[1]));
      }
      if (rings[0]?.length >= 4) polygons.push(rings);
    }
    states.push({ code, name: attr(block, "NAME"), fips: attr(block, "STATEFP"), polygons });
  }
  states.sort((a, b) => a.fips.localeCompare(b.fips));
  return states;
}

// Spherical Albers equal-area conic, tuned to the lower 48.
function albers([longitude, latitude]) {
  const radians = Math.PI / 180;
  const phi1 = 29.5 * radians;
  const phi2 = 45.5 * radians;
  const phi0 = 37.5 * radians;
  const lambda0 = -96 * radians;
  const n = 0.5 * (Math.sin(phi1) + Math.sin(phi2));
  const c = Math.cos(phi1) ** 2 + 2 * n * Math.sin(phi1);
  const rho0 = Math.sqrt(c - 2 * n * Math.sin(phi0)) / n;
  const phi = latitude * radians;
  const theta = n * (longitude * radians - lambda0);
  const rho = Math.sqrt(Math.max(0, c - 2 * n * Math.sin(phi))) / n;
  return [rho * Math.sin(theta), rho0 - rho * Math.cos(theta)];
}

function projectedState(state) {
  return state.polygons.map((polygon) => polygon.map((ring) => ring.map(albers)));
}

function boundsOf(polygons) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const polygon of polygons) for (const ring of polygon) for (const [x, y] of ring) {
    bounds[0] = Math.min(bounds[0], x);
    bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x);
    bounds[3] = Math.max(bounds[3], y);
  }
  return bounds;
}

function mergeBounds(items) {
  return items.reduce((out, item) => {
    const b = boundsOf(item);
    return [Math.min(out[0], b[0]), Math.min(out[1], b[1]), Math.max(out[2], b[2]), Math.max(out[3], b[3])];
  }, [Infinity, Infinity, -Infinity, -Infinity]);
}

function fitTransform(source, target, padding = 0) {
  const [x0, y0, x1, y1] = source;
  const [tx, ty, tw, th] = target;
  const scale = Math.min((tw - padding * 2) / (x1 - x0), (th - padding * 2) / (y1 - y0));
  const ox = tx + (tw - (x1 - x0) * scale) / 2 - x0 * scale;
  // Projection y grows north; SVG y grows down.
  const oy = ty + (th + (y1 - y0) * scale) / 2 + y0 * scale;
  return ([x, y]) => [ox + x * scale, oy - y * scale];
}

function transformPolygons(polygons, transform) {
  return polygons.map((polygon) => polygon.map((ring) => ring.map(transform)));
}

function simplifyRing(ring, tolerance = 0.28) {
  const points = ring.slice(0, -1);
  if (points.length < 5) return ring;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const toleranceSquared = tolerance * tolerance;
  while (stack.length) {
    const [first, last] = stack.pop();
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    let farthest = -1;
    let maxDistance = toleranceSquared;
    for (let i = first + 1; i < last; i += 1) {
      const [px, py] = points[i];
      const t = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
      const ex = px - (ax + t * dx);
      const ey = py - (ay + t * dy);
      const distance = ex * ex + ey * ey;
      if (distance > maxDistance) {
        maxDistance = distance;
        farthest = i;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  const simplified = points.filter((_, index) => keep[index]);
  if (simplified.length < 3) return ring;
  simplified.push(simplified[0]);
  return simplified;
}

function simplifyPolygons(polygons) {
  return polygons.map((polygon) => polygon.map((ring) => simplifyRing(ring)));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function pathData(polygons) {
  return polygons.map((polygon) => polygon.map((ring) => {
    const points = ring.map(([x, y], index) => `${index ? "L" : "M"}${round(x)} ${round(y)}`);
    return `${points.join("")}Z`;
  }).join("")).join("");
}

function centroid(polygons) {
  let areaSum = 0;
  let xSum = 0;
  let ySum = 0;
  for (const polygon of polygons) for (const ring of polygon) {
    let twiceArea = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[i + 1];
      const cross = x0 * y1 - x1 * y0;
      twiceArea += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    const area = twiceArea / 2;
    if (Math.abs(area) < 1e-8) continue;
    areaSum += area;
    xSum += cx / 6;
    ySum += cy / 6;
  }
  if (Math.abs(areaSum) < 1e-8) {
    const b = boundsOf(polygons);
    return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  }
  return [xSum / areaSum, ySum / areaSum];
}

function glyphPoints(polygons, count = 28) {
  const segments = [];
  let perimeter = 0;
  for (const polygon of polygons) for (const ring of polygon) for (let i = 0; i < ring.length - 1; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > 0) {
      segments.push({ a, b, start: perimeter, length });
      perimeter += length;
    }
  }
  const points = [];
  let segmentIndex = 0;
  for (let i = 0; i < count; i += 1) {
    const distance = perimeter * ((i + 0.5) / count);
    while (segmentIndex < segments.length - 1 && segments[segmentIndex].start + segments[segmentIndex].length < distance) segmentIndex += 1;
    const segment = segments[segmentIndex];
    const t = Math.max(0, Math.min(1, (distance - segment.start) / segment.length));
    points.push([round(segment.a[0] + (segment.b[0] - segment.a[0]) * t), round(segment.a[1] + (segment.b[1] - segment.a[1]) * t)]);
  }
  return points;
}

function assertGeometry(states) {
  if (states.length !== 50) throw new Error(`Expected exactly 50 states, found ${states.length}`);
  if (new Set(states.map((state) => state.code)).size !== 50) throw new Error("State codes are not unique");
  if (new Set(states.map((state) => state.fips)).size !== 50) throw new Error("State FIPS ids are not unique");
  for (const state of states) {
    if (!state.polygons.length) throw new Error(`${state.code} has no polygons`);
    if (!state.centroid.every(Number.isFinite)) throw new Error(`${state.code} has a non-finite centroid`);
  }
}

function serialize(states) {
  const compact = states.map(({ polygons: _polygons, ...state }) => state);
  const payload = {
    generatorVersion: GENERATOR_VERSION,
    source: { url: SOURCE_URL, sha256: SOURCE_SHA256 },
    viewBox: VIEW_BOX,
    states: compact,
  };
  return `// Generated by scripts/build-atlas-geometry.mjs. Do not edit.\nexport const ATLAS_GEOMETRY = Object.freeze(${JSON.stringify(payload)});\nexport default ATLAS_GEOMETRY;\n`;
}

async function main() {
  const archive = await readFile(archivePath);
  const hash = createHash("sha256").update(archive).digest("hex");
  if (hash !== SOURCE_SHA256) throw new Error(`Census archive SHA-256 mismatch: ${hash}`);
  const parsed = parseKml(extractKml(archive));
  if (parsed.length !== 50) throw new Error(`Expected 50 state placemarks after filtering, found ${parsed.length}`);
  const projected = new Map(parsed.map((state) => [state.code, projectedState(state)]));
  const lower48 = parsed.filter((state) => state.code !== "AK" && state.code !== "HI");
  const lowerTransform = fitTransform(mergeBounds(lower48.map((state) => projected.get(state.code))), [25, 20, 950, 500], 4);
  const insetTargets = { AK: [42, 458, 215, 135], HI: [282, 500, 150, 72] };
  const states = parsed.map((state) => {
    const raw = projected.get(state.code);
    const transform = insetTargets[state.code] ? fitTransform(boundsOf(raw), insetTargets[state.code], 2) : lowerTransform;
    const polygons = simplifyPolygons(transformPolygons(raw, transform));
    const b = boundsOf(polygons).map(round);
    const c = centroid(polygons).map(round);
    const path = pathData(polygons);
    return { code: state.code, name: state.name, fips: state.fips, path, hitPath: path, centroid: c, glyphPoints: glyphPoints(polygons), bounds: b, polygons };
  });
  assertGeometry(states);
  const output = serialize(states);
  if (checkOnly) {
    const existing = await readFile(outputPath, "utf8");
    if (existing !== output) throw new Error("Generated geometry is stale; run scripts/build-atlas-geometry.mjs");
  } else {
    await writeFile(outputPath, output);
  }
  process.stdout.write(`${checkOnly ? "Verified" : "Wrote"} ${outputPath} (${Buffer.byteLength(output)} bytes)\n`);
}

await main();
