import assert from "node:assert/strict";
import test from "node:test";
import { ATLAS_RENDERERS } from "./config.js";
import { createRenderer, selectRendererMode } from "./renderer.js";

function environment({ reduced = false, forced = false, saveData = false } = {}) {
  return {
    matchMedia(query) {
      return { matches: (reduced && query.includes("reduced-motion")) || (forced && query.includes("forced-colors")) };
    },
    navigator: { connection: { saveData } },
  };
}

class FakeElement {
  constructor(name, document) {
    this.tagName = name;
    this.ownerDocument = document;
    this.attributes = new Map();
    this.children = [];
    this.parent = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  contains(child) { return this.children.includes(child) || this.children.some((node) => node.contains?.(child)); }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  closest(selector) {
    return selector === "[data-state]" && this.attributes.has("data-state") ? this : this.parent?.closest?.(selector) ?? null;
  }
}

function fakeSvg() {
  const document = {
    createElementNS(_namespace, name) { return new FakeElement(name, document); },
    elementFromPoint() { return null; },
  };
  return new FakeElement("svg", document);
}

const geometry = {
  viewBox: [0, 0, 100, 60],
  states: [
    { code: "AA", fips: "01", path: "M0 0L10 0L10 10Z", centroid: [5, 5], glyphPoints: [[0, 0]], bounds: [0, 0, 10, 10] },
    { code: "BB", fips: "02", path: "M20 0L30 0L30 10Z", centroid: [25, 5], glyphPoints: [[20, 0]], bounds: [20, 0, 30, 10] },
  ],
};

test("selector forces SVG for accessibility and data constraints", () => {
  assert.equal(selectRendererMode({ mode: "auto" }, environment({ reduced: true })), ATLAS_RENDERERS.SVG);
  assert.equal(selectRendererMode({ mode: "webgl2" }, environment({ forced: true })), ATLAS_RENDERERS.SVG);
  assert.equal(selectRendererMode({ mode: "auto" }, environment({ saveData: true })), ATLAS_RENDERERS.SVG);
  assert.equal(selectRendererMode({ mode: "auto", benchmark: () => 0.1 }, environment()), ATLAS_RENDERERS.SVG);
  assert.equal(selectRendererMode({ mode: "auto", benchmark: () => 1 }, environment()), ATLAS_RENDERERS.WEBGL2);
  assert.equal(selectRendererMode({ mode: "webgpu" }, environment()), ATLAS_RENDERERS.SVG);
});

test("SVG renderer stays decorative and encodes exact multi-year combinations", () => {
  const svg = fakeSvg();
  const renderer = createRenderer({ mode: "svg" }, environment());
  assert.equal(renderer.init({ svg }, geometry), ATLAS_RENDERERS.SVG);
  renderer.render({
    activeStates: {
      AA: { year: "2020-2022", scope: "multi-year" },
      BB: { year: "2022-2024", scope: "multi-year" },
    },
    selectedState: "AA",
  });
  const group = svg.children[0];
  assert.equal(svg.getAttribute("aria-hidden"), "true");
  assert.equal(svg.getAttribute("focusable"), "false");
  assert.equal(group.getAttribute("aria-hidden"), "true");
  assert.equal(group.children.length, 2);
  assert.equal(group.children.some((child) => child.tagName === "text"), false);
  assert.match(group.children[0].getAttribute("class"), /is-active/);
  assert.match(group.children[0].getAttribute("class"), /is-selected/);
  assert.match(group.children[0].getAttribute("class"), /atlas-year-2020-2022/);
  assert.match(group.children[0].getAttribute("class"), /atlas-scope-multi-year/);
  assert.equal(group.children[0].getAttribute("data-year"), "2020-2022");
  assert.equal(group.children[0].getAttribute("data-state"), "AA");
  assert.match(group.children[1].getAttribute("class"), /atlas-year-2022-2024/);
  assert.equal(group.children[1].getAttribute("data-year"), "2022-2024");
  renderer.destroy();
  assert.equal(svg.children.length, 0);
});

test("WebGL2 initialization failure downgrades cleanly to SVG", () => {
  const svg = fakeSvg();
  let failure = null;
  const canvas = { getContext: () => null, addEventListener() {}, removeEventListener() {} };
  const renderer = createRenderer({ mode: "webgl2", onError: (error) => { failure = error; } }, environment());
  assert.equal(renderer.init({ svg, canvas }, geometry), ATLAS_RENDERERS.SVG);
  assert.match(failure.message, /WebGL2 is unavailable/);
  renderer.render({ activeStates: new Set(["AA"]) });
  assert.match(svg.children[0].children[0].getAttribute("class"), /is-active/);
  renderer.destroy();
});
