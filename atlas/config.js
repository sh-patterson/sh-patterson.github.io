export const ATLAS_VIEW_BOX = Object.freeze([0, 0, 1000, 620]);

export const ATLAS_PALETTE = Object.freeze({
  background: "#0b0c0e",
  ink: "#f3eadb",
  muted: "#8f8678",
  gold: "#c9a45d",
  cyan: "#5ff7e0",
});

export const ATLAS_RENDERERS = Object.freeze({
  AUTO: "auto",
  SVG: "svg",
  WEBGL2: "webgl2",
  // Reserved for a future implementation. Selection deliberately rejects it.
  WEBGPU: "webgpu",
});

export const ATLAS_RENDERER_DEFAULTS = Object.freeze({
  mode: ATLAS_RENDERERS.AUTO,
  dprCap: 2,
  glyphsPerState: 28,
  webgpuEnabled: false,
  webglBenchmarkFloor: 0.35,
});
