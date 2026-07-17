import { careerAtlas } from "./career-data.generated.js";
import { CareerAtlas } from "./controller.js";
import { ATLAS_GEOMETRY } from "./geometry.generated.js";
import { createRenderer } from "./renderer.js";

export function mountCareerAtlas(root = document.querySelector("[data-career-atlas]")) {
  if (!root) return null;
  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  return CareerAtlas.mount(root, {
    records: careerAtlas,
    geometry: ATLAS_GEOMETRY,
    reducedMotion: motionQuery,
    renderer({ onError }) {
      return createRenderer({
        mode: "svg",
        onError,
      }, window);
    },
  });
}

export { CareerAtlas };
