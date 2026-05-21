(() => {
  const canvas = document.getElementById("atlas-canvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d", { alpha: true });
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const dense = "#%@";

  const colors = {
    blue: "#0055ff",
    white: "#ffffff",
    red: "#ff0000",
    green: "#00ff00",
    yellow: "#ffff00",
    gold: "#c9a45d",
    cyan: "#5ff7e0",
    violet: "#b978ff",
    ember: "#ff6a00",
    ink: "#f3eadb",
  };

  const palette = {};
  for (const k in colors) {
    const v = parseInt(colors[k].slice(1), 16);
    palette[k] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const inkRgb = palette.gold;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let fontSize = 9;
  let cols = 0;
  let rows = 0;
  let frame = 0;
  let last = 0;
  let running = true;
  let formationProgress = 0;
  let scrollProgress = 0;
  let effectiveWipe = 0;
  let wipeSettled = false;
  let settledFrame = null;
  let settledTime = null;
  let scrollFrame = 0;
  let heroHeight = 0;
  let isReversing = false;
  let animationFrame = 0;

  function clamp(value, min = 0, max = 1) {
    return Math.min(Math.max(value, min), max);
  }

  function smoothstep(edge0, edge1, value) {
    const x = clamp((value - edge0) / (edge1 - edge0 || 1));
    return x * x * (3 - 2 * x);
  }

  function hash(seed) {
    return Math.abs(Math.sin(seed * 12.9898) * 43758.5453) % 1;
  }

  function metrics() {
    const isMobile = width < 700;
    const radiusScale = isMobile ? 0.34 : 0.40;
    return {
      isMobile,
      cx: isMobile ? width * 0.92 : width * 0.90,
      cy: isMobile ? height * 0.12 : height * 0.30,
      radius: Math.min(width, height) * radiusScale,
    };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    fontSize = width < 700 ? 6 : 9;
    cols = Math.ceil(width / (fontSize * 0.6));
    rows = Math.ceil(height / fontSize);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `${fontSize}px "JetBrains Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const heroEl = document.querySelector(".hero");
    heroHeight = heroEl ? heroEl.getBoundingClientRect().height : height;
    scrollProgress = heroWipeProgress();
    effectiveWipe = scrollProgress;
    draw(performance.now(), true);
  }

  function drawGrid(t) {
    const gap = width < 700 ? 34 : 46;
    ctx.strokeStyle = "rgba(243, 234, 219, 0.052)";
    ctx.lineWidth = 1;

    for (let x = (frame * 0.03) % gap; x < width; x += gap) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    for (let y = 0; y < height; y += gap) {
      const wobble = Math.sin(t * 0.001 + y) * 2;
      ctx.beginPath();
      ctx.moveTo(0, y + wobble);
      ctx.lineTo(width, y + wobble);
      ctx.stroke();
    }
  }

  function pickPetalKey(angle) {
    const q = Math.floor(((angle + Math.PI) / (Math.PI * 2)) * 4) % 4;
    if (q === 0) return "blue";
    if (q === 1) return "yellow";
    if (q === 2) return "red";
    return "green";
  }

  function near(value, target, width) {
    return Math.abs(value - target) < width;
  }

  function ring(r, inner, outer) {
    return r >= inner && r < outer;
  }

  function cardinalGate(a, b, outer, halfWidth, depth) {
    return Math.abs(a) < halfWidth && Math.abs(b) > outer - depth;
  }

  function drawMandalaCell(u, v, r, theta, thetaRot, squareCos, squareSin, form, seed) {
    if (r >= form * 1.22) return null;

    const sqU = u * squareCos - v * squareSin;
    const sqV = u * squareSin + v * squareCos;
    const rSquare = Math.max(Math.abs(sqU), Math.abs(sqV));
    const absU = Math.abs(sqU);
    const absV = Math.abs(sqV);
    const petal16 = Math.abs(Math.sin(thetaRot * 16));
    const petal32 = Math.abs(Math.sin(thetaRot * 32));
    const spoke8 = Math.abs(Math.sin(thetaRot * 8));
    const spoke16 = petal16;
    const shimmer = hash(seed + frame * 0.041);

    if (r < 0.12) {
      if (r < 0.035) return { char: "@", colorKey: "white" };
      if (near(r, 0.08, 0.013)) return { char: shimmer > 0.5 ? "%" : "#", colorKey: "gold" };
      if (spoke8 > 0.92 || petal16 < 0.18) return { char: "+", colorKey: "cyan" };
      return { char: dense[Math.floor(shimmer * dense.length)] || "#", colorKey: pickPetalKey(thetaRot) };
    }

    if (ring(r, 0.12, 0.26)) {
      const lotusEdge = 0.22 + petal16 * 0.035;
      if (r < lotusEdge) {
        const ch = near(r, lotusEdge, 0.014) ? "%" : petal32 > 0.8 ? "#" : "+";
        return { char: ch, colorKey: pickPetalKey(thetaRot + 0.35) };
      }
      if (near(r, 0.245, 0.012)) return { char: petal32 > 0.55 ? "*" : ".", colorKey: "gold" };
    }

    if (ring(r, 0.26, 0.38)) {
      if (spoke16 > 0.9) return { char: "|", colorKey: "white" };
      if (near(r, 0.315, 0.018)) return { char: petal32 > 0.42 ? "<" : ">", colorKey: "violet" };
      if (hash(seed + 2.7) > 0.88) return { char: ".", colorKey: "gold" };
    }

    if (rSquare < 0.62) {
      const gate =
        cardinalGate(sqU, sqV, 0.62, 0.115, 0.19) ||
        cardinalGate(sqV, sqU, 0.62, 0.115, 0.19);
      const innerGate =
        cardinalGate(sqU, sqV, 0.49, 0.065, 0.11) ||
        cardinalGate(sqV, sqU, 0.49, 0.065, 0.11);
      if (gate && rSquare > 0.47) {
        if (near(absU, 0.055, 0.012) || near(absV, 0.055, 0.012)) return { char: "|", colorKey: "white" };
        return { char: shimmer > 0.35 ? "@" : "%", colorKey: "gold" };
      }
      if (innerGate) return { char: "+", colorKey: "cyan" };
      if (rSquare > 0.565 || near(rSquare, 0.43, 0.012)) return { char: "%", colorKey: "white" };
      if (rSquare > 0.49) {
        const checker = (Math.floor(sqU * 42) + Math.floor(sqV * 42)) % 2 === 0;
        return { char: checker ? "#" : "+", colorKey: checker ? "red" : "blue" };
      }
      if (near(absU, absV, 0.012) && rSquare > 0.22) return { char: "\\", colorKey: "green" };
      if (near(absU + absV, 0.48, 0.012)) return { char: "/", colorKey: "yellow" };
      if (absU > 0.34 && absV > 0.34 && rSquare < 0.49) return { char: shimmer > 0.5 ? "0" : "1", colorKey: "gold" };
      if (hash(seed + 8.3) > 0.93) return { char: ".", colorKey: "gold" };
    }

    if (ring(r, 0.62, 0.77)) {
      const lotusRim = 0.7 + petal32 * 0.045;
      if (r < lotusRim && r > 0.625) {
        if (near(r, lotusRim, 0.015)) return { char: "}", colorKey: pickPetalKey(thetaRot) };
        return { char: petal32 > 0.72 ? ":" : ";", colorKey: "green" };
      }
    }

    if (ring(r, 0.77, 0.88)) {
      const vajra = Math.abs(Math.sin(thetaRot * 24));
      if (near(r, 0.815, 0.014)) return { char: vajra > 0.62 ? "<" : ">", colorKey: "cyan" };
      if (near(r, 0.86, 0.01) || vajra > 0.95) return { char: "+", colorKey: "white" };
    }

    if (ring(r, 0.88, 1.05)) {
      const flame = Math.sin(theta * 48 - frame * 0.13) + Math.sin(r * 42 + thetaRot * 6);
      if (flame > 0.36) {
        const warm = shimmer > 0.58 ? "ember" : shimmer > 0.24 ? "red" : "gold";
        return { char: shimmer > 0.62 ? "~" : shimmer > 0.35 ? "*" : "^", colorKey: warm };
      }
      if (near(r, 0.99, 0.012) && petal32 > 0.52) return { char: ".", colorKey: "gold" };
    }

    return null;
  }

  function drawAsciiField(t) {
    const m = metrics();
    const wipe = effectiveWipe;

    const radiusProgress = smoothstep(0, 0.6, wipe);
    const collapseScale = 1 - radiusProgress * 0.93;
    const collapsedRadius = m.radius * collapseScale;

    const desatT = (isReversing && wipe < 0.7) ? 0 : radiusProgress;

    const mandalaAlpha = (1 - smoothstep(0.85, 1.0, wipe)) * (reduceMotion.matches ? 0.6 : 1);
    if (mandalaAlpha < 0.005) return;

    const form = reduceMotion.matches ? 1 : formationProgress;
    const artTime = reduceMotion.matches ? 0 : t;
    const rot = artTime * 0.0005 * (1 - radiusProgress * 0.85);
    const rotCos = Math.cos(rot);
    const rotSin = Math.sin(rot);
    const squareAngle = -rot * 0.16;
    const squareCos = Math.cos(squareAngle);
    const squareSin = Math.sin(squareAngle);
    const cellW = fontSize * 0.6;
    const reach = collapsedRadius * Math.min(1.3, Math.max(form * 1.22, 0.08));
    const minCol = Math.max(0, Math.floor((m.cx - reach) / cellW) - 1);
    const maxCol = Math.min(cols - 1, Math.ceil((m.cx + reach) / cellW) + 1);
    const minRow = Math.max(0, Math.floor((m.cy - reach) / fontSize) - 1);
    const maxRow = Math.min(rows - 1, Math.ceil((m.cy + reach) / fontSize) + 1);

    ctx.font = `${fontSize}px "JetBrains Mono", monospace`;

    for (let y = minRow; y <= maxRow; y += 1) {
      for (let x = minCol; x <= maxCol; x += 1) {
        const px = x * cellW + cellW * 0.5;
        const py = y * fontSize + fontSize * 0.5;
        const u = (px - m.cx) / collapsedRadius;
        const v = (py - m.cy) / collapsedRadius;
        const r = Math.sqrt(u * u + v * v);
        if (r > 1.3) continue;

        const theta = Math.atan2(v, u);
        const rotU = u * rotCos - v * rotSin;
        const rotV = u * rotSin + v * rotCos;
        const thetaRot = Math.atan2(rotV, rotU);
        const seed = x * 1.77 + y * 9.31;

        const cell = drawMandalaCell(u, v, r, theta, thetaRot, squareCos, squareSin, form, seed);
        if (!cell) continue;

        const rgb = palette[cell.colorKey];
        const fr = rgb[0] + (inkRgb[0] - rgb[0]) * desatT;
        const fg = rgb[1] + (inkRgb[1] - rgb[1]) * desatT;
        const fb = rgb[2] + (inkRgb[2] - rgb[2]) * desatT;
        ctx.globalAlpha = mandalaAlpha;
        ctx.fillStyle = `rgb(${fr | 0},${fg | 0},${fb | 0})`;
        ctx.fillText(cell.char, px, py);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawSignal() {
    const m = metrics();
    const wipe = effectiveWipe;
    const traceAlpha = smoothstep(0.55, 0.98, wipe) * 0.40;
    if (traceAlpha < 0.01) return;
    const size = 3 + smoothstep(0.55, 0.98, wipe) * 3;
    ctx.strokeStyle = `rgba(243, 234, 219, ${traceAlpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(m.cx - size, m.cy);
    ctx.lineTo(m.cx + size, m.cy);
    ctx.moveTo(m.cx, m.cy - size);
    ctx.lineTo(m.cx, m.cy + size);
    ctx.stroke();
  }

  function shouldAnimate() {
    return running &&
      !reduceMotion.matches &&
      (!wipeSettled || formationProgress < 1 || Math.abs(scrollProgress - effectiveWipe) > 0.0008);
  }

  function scheduleDraw() {
    if (animationFrame || !shouldAnimate()) return;
    animationFrame = requestAnimationFrame(draw);
  }

  function heroWipeProgress() {
    const isMobile = width < 700;
    const cyRatio = isMobile ? 0.12 : 0.30;
    const cy = height * cyRatio;
    const distance = Math.max(heroHeight - cy, 1);
    return clamp(window.scrollY / distance, 0, 1.05);
  }

  function draw(t, force = false) {
    if (!force) animationFrame = 0;
    if (!running && !force) return;
    if (!force && t - last < 33) {
      scheduleDraw();
      return;
    }
    last = t;

    const rawTarget = reduceMotion.matches ? Math.min(scrollProgress, 0.45) : scrollProgress;
    if (reduceMotion.matches) {
      effectiveWipe = rawTarget;
      isReversing = false;
    } else {
      const delta = rawTarget - effectiveWipe;
      isReversing = delta < -0.002;
      const rate = delta > 0 ? 0.16 : 0.42;
      effectiveWipe += delta * rate;
      if (Math.abs(delta) < 0.0008) effectiveWipe = rawTarget;
    }

    if (!wipeSettled && effectiveWipe > 0.97 && !reduceMotion.matches) {
      wipeSettled = true;
      settledFrame = frame;
      settledTime = t;
    } else if (wipeSettled && effectiveWipe < 0.92) {
      wipeSettled = false;
      settledFrame = null;
      settledTime = null;
    }
    if (!wipeSettled) frame += 1;
    const animT = wipeSettled ? settledTime : t;

    if (formationProgress < 1) formationProgress += reduceMotion.matches ? 1 : 0.012;

    ctx.clearRect(0, 0, width, height);
    drawGrid(animT);
    drawAsciiField(animT);
    drawSignal();

    scheduleDraw();
  }

  function updateScrollProgress() {
    scrollFrame = 0;
    scrollProgress = heroWipeProgress();
    if (reduceMotion.matches) draw(performance.now(), true);
    else scheduleDraw();
  }

  function requestScrollUpdate() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(updateScrollProgress);
  }

  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    scheduleDraw();
  });

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(([entry]) => {
      running = entry.isIntersecting && !document.hidden;
      scheduleDraw();
    });
    observer.observe(canvas);
  }

  reduceMotion.addEventListener("change", () => {
    formationProgress = 1;
    if (reduceMotion.matches) {
      draw(performance.now(), true);
    } else {
      scheduleDraw();
    }
  });

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("scroll", requestScrollUpdate, { passive: true });
  resize();
  updateScrollProgress();
  scheduleDraw();
})();
