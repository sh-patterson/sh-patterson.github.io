import { careerAtlas } from "./career-data.generated.js";
import { CareerAtlas } from "./controller.js";
import { ATLAS_GEOMETRY } from "./geometry.generated.js";
import { createRenderer } from "./renderer.js";

function conservativeWebGL2Support(reducedMotion) {
  if (reducedMotion || !("WebGL2RenderingContext" in window)) return false;
  const connection = navigator.connection;
  if (connection?.saveData) return false;
  if ((navigator.hardwareConcurrency ?? 2) < 4) return false;
  if ((navigator.deviceMemory ?? 4) < 4) return false;
  return (window.devicePixelRatio || 1) <= 2;
}

export function mountCareerAtlas(root = document.querySelector("[data-career-atlas]")) {
  if (!root) return null;
  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  return CareerAtlas.mount(root, {
    records: careerAtlas,
    geometry: ATLAS_GEOMETRY,
    reducedMotion: motionQuery,
    renderer({ reducedMotion, onError }) {
      return createRenderer({
        mode: reducedMotion ? "svg" : "auto",
        webgl2Supported: conservativeWebGL2Support(reducedMotion),
        dprCap: reducedMotion ? 1 : 1.5,
        webglBenchmarkFloor: 0.5,
        onError,
      }, window);
    },
  });
}

export { CareerAtlas };
