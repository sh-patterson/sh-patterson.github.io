import { ATLAS_RENDERERS, ATLAS_RENDERER_DEFAULTS } from "./config.js";
import { createSvgRenderer } from "./renderer-svg.js";
import { createWebGL2Renderer } from "./renderer-webgl2.js";

function mediaMatches(environment, query) {
  try {
    return Boolean(environment?.matchMedia?.(query).matches);
  } catch {
    return false;
  }
}

export function selectRendererMode(options = {}, environment = globalThis) {
  const requested = String(options.mode ?? ATLAS_RENDERER_DEFAULTS.mode).toLowerCase();
  if (requested === ATLAS_RENDERERS.WEBGPU) return ATLAS_RENDERERS.SVG;
  if (![ATLAS_RENDERERS.AUTO, ATLAS_RENDERERS.SVG, ATLAS_RENDERERS.WEBGL2].includes(requested)) {
    throw new TypeError(`Unknown atlas renderer mode: ${requested}`);
  }
  const constrained =
    mediaMatches(environment, "(prefers-reduced-motion: reduce)") ||
    mediaMatches(environment, "(forced-colors: active)") ||
    Boolean(environment?.navigator?.connection?.saveData);
  if (requested === ATLAS_RENDERERS.SVG || constrained) return ATLAS_RENDERERS.SVG;
  if (options.webgl2Supported === false) return ATLAS_RENDERERS.SVG;
  if (typeof options.benchmark === "function") {
    try {
      const score = Number(options.benchmark());
      if (!Number.isFinite(score) || score < (options.webglBenchmarkFloor ?? ATLAS_RENDERER_DEFAULTS.webglBenchmarkFloor)) {
        return ATLAS_RENDERERS.SVG;
      }
    } catch {
      return ATLAS_RENDERERS.SVG;
    }
  }
  return ATLAS_RENDERERS.WEBGL2;
}

class AtlasRenderer {
  constructor(options = {}, environment = globalThis) {
    this.options = options;
    this.environment = environment;
    this.mode = selectRendererMode(options, environment);
    this.svg = null;
    this.overlay = null;
    this.surface = null;
    this.geometry = null;
  }

  init(surface, geometry, options = {}) {
    this.surface = surface;
    this.geometry = geometry;
    const merged = { ...this.options, ...options };
    if (surface?.svg || (surface?.ownerDocument && surface?.tagName?.toLowerCase?.() === "svg")) {
      this.svg = createSvgRenderer();
      this.svg.init(surface, geometry, merged);
    }
    if (this.mode === ATLAS_RENDERERS.WEBGL2) {
      this.overlay = createWebGL2Renderer();
      const initialized = this.overlay.init(surface, geometry, {
        ...merged,
        onError: (error) => {
          this.mode = ATLAS_RENDERERS.SVG;
          merged.onError?.(error);
        },
      });
      if (!initialized) {
        this.overlay.destroy();
        this.overlay = null;
        this.mode = ATLAS_RENDERERS.SVG;
      }
    }
    if (!this.svg && !this.overlay) throw new TypeError("Atlas surface must provide an svg and/or canvas element");
    return this.mode;
  }

  resize(width, height, dpr = 1) {
    this.svg?.resize(width, height, dpr);
    this.overlay?.resize(width, height, dpr);
  }

  render(state = {}) {
    this.svg?.render(state);
    this.overlay?.render(state);
  }

  hitTest(x, y) {
    return this.svg?.hitTest(x, y) ?? this.overlay?.hitTest(x, y) ?? null;
  }

  destroy() {
    this.overlay?.destroy();
    this.svg?.destroy();
    this.overlay = null;
    this.svg = null;
    this.surface = null;
    this.geometry = null;
  }
}

/**
 * Create an atlas renderer. The preferred surface is `{ svg, canvas }`: SVG is
 * the semantic-free pointer/hit layer and canvas is an optional decorative
 * WebGL2 overlay. Auto mode downgrades to SVG for constrained preferences,
 * failed benchmarks, missing WebGL2, initialization errors, or context loss.
 */
export function createRenderer(options = {}, environment = globalThis) {
  return new AtlasRenderer(options, environment);
}

export { createSvgRenderer, createWebGL2Renderer };
