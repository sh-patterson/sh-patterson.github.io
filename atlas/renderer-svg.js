import { ATLAS_PALETTE } from "./config.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function statePresentation(activeStates, code) {
  if (!activeStates) return null;
  if (activeStates instanceof Map) return activeStates.get(code) ?? null;
  if (activeStates instanceof Set) return activeStates.has(code) ? {} : null;
  if (Array.isArray(activeStates)) return activeStates.includes(code) ? {} : null;
  if (typeof activeStates === "object") return activeStates[code] ?? null;
  return null;
}

function token(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

export class SvgAtlasRenderer {
  constructor() {
    this.svg = null;
    this.geometry = null;
    this.group = null;
    this.paths = new Map();
  }

  init(surface, geometry, options = {}) {
    const svg = surface?.svg ?? surface;
    if (!svg?.ownerDocument || typeof svg.setAttribute !== "function") {
      throw new TypeError("SVG renderer requires an SVGElement or { svg } surface");
    }
    this.svg = svg;
    this.geometry = geometry;
    const document = svg.ownerDocument;
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("data-atlas-renderer", "svg");
    group.setAttribute("aria-hidden", "true");
    group.setAttribute("fill-rule", "evenodd");
    group.setAttribute("class", "atlas-map");
    const viewBox = geometry.viewBox.join(" ");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("preserveAspectRatio", options.preserveAspectRatio ?? "xMidYMid meet");
    svg.setAttribute("aria-hidden", "true");
    for (const state of geometry.states) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", state.path);
      path.setAttribute("data-state", state.code);
      path.setAttribute("data-fips", state.fips);
      path.setAttribute("class", "atlas-state");
      path.setAttribute("vector-effect", "non-scaling-stroke");
      path.setAttribute("pointer-events", "all");
      path.setAttribute("fill", options.contextFill ?? ATLAS_PALETTE.gold);
      path.setAttribute("fill-opacity", "0.075");
      path.setAttribute("stroke", options.contextStroke ?? ATLAS_PALETTE.ink);
      path.setAttribute("stroke-opacity", "0.2");
      path.setAttribute("stroke-width", "0.7");
      group.appendChild(path);
      this.paths.set(state.code, path);
    }
    svg.appendChild(group);
    this.group = group;
    return true;
  }

  resize(width, height) {
    if (!this.svg) return;
    if (Number.isFinite(width)) this.svg.setAttribute("width", String(Math.max(0, width)));
    if (Number.isFinite(height)) this.svg.setAttribute("height", String(Math.max(0, height)));
  }

  render({ activeStates, selectedState = null, transition = {} } = {}) {
    if (!this.group) return;
    const globalYear = transition?.year;
    const globalScope = transition?.scope;
    for (const state of this.geometry.states) {
      const path = this.paths.get(state.code);
      const presentation = statePresentation(activeStates, state.code);
      const detail = presentation && typeof presentation === "object" ? presentation : {};
      const year = detail.year ?? globalYear;
      const scope = detail.scope ?? globalScope;
      const classes = ["atlas-state"];
      if (presentation !== null) classes.push("is-active");
      if (state.code === selectedState) classes.push("is-selected");
      if (year !== undefined && year !== null && presentation !== null) classes.push(`atlas-year-${token(year)}`);
      if (scope && presentation !== null) classes.push(`atlas-scope-${token(scope)}`);
      path.setAttribute("class", classes.join(" "));
      path.setAttribute("fill-opacity", state.code === selectedState ? "0.3" : presentation !== null ? "0.16" : "0.075");
      path.setAttribute("stroke-opacity", state.code === selectedState ? "0.85" : presentation !== null ? "0.42" : "0.2");
      path.setAttribute("stroke-width", state.code === selectedState ? "1.5" : "0.7");
      path.setAttribute("stroke", state.code === selectedState ? ATLAS_PALETTE.cyan : ATLAS_PALETTE.ink);
      if (year !== undefined && year !== null && presentation !== null) path.setAttribute("data-year", String(year));
      else path.removeAttribute("data-year");
      if (scope && presentation !== null) path.setAttribute("data-scope", String(scope));
      else path.removeAttribute("data-scope");
      path.setAttribute("aria-hidden", "true");
    }
  }

  hitTest(x, y) {
    if (!this.svg || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const document = this.svg.ownerDocument;
    if (typeof document.elementFromPoint === "function") {
      const element = document.elementFromPoint(x, y);
      const target = element?.closest?.("[data-state]");
      if (target && this.group?.contains(target)) return target.getAttribute("data-state");
    }
    if (typeof this.svg.createSVGPoint === "function") {
      const point = this.svg.createSVGPoint();
      point.x = x;
      point.y = y;
      for (const [code, path] of this.paths) {
        if (typeof path.isPointInFill === "function" && path.isPointInFill(point)) return code;
      }
    }
    return null;
  }

  destroy() {
    this.group?.remove();
    this.paths.clear();
    this.group = null;
    this.svg = null;
    this.geometry = null;
  }
}

export function createSvgRenderer() {
  return new SvgAtlasRenderer();
}
