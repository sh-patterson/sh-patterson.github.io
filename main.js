(() => {
  const canvas = document.getElementById("atlas-canvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d", { alpha: true });
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const chars = [".", ":", "+", "o", "x", "0", "1"];
  let width = 0;
  let height = 0;
  let dpr = 1;
  let frame = 0;
  let last = 0;
  let running = true;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `${width < 700 ? 9 : 11}px "JetBrains Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    draw(0, true);
  }

  function drawGrid(t) {
    const gap = width < 700 ? 34 : 46;
    ctx.strokeStyle = "rgba(243, 234, 219, 0.055)";
    ctx.lineWidth = 1;

    for (let x = (frame * 0.03) % gap; x < width; x += gap) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    for (let y = 0; y < height; y += gap) {
      ctx.beginPath();
      ctx.moveTo(0, y + Math.sin(t * 0.001 + y) * 2);
      ctx.lineTo(width, y + Math.sin(t * 0.001 + y) * 2);
      ctx.stroke();
    }
  }

  function drawConstellation(t) {
    const cx = width * 0.72;
    const cy = height * 0.34;
    const count = width < 700 ? 18 : 32;
    const nodes = [];

    for (let i = 0; i < count; i += 1) {
      const angle = i * 2.399 + Math.sin(t * 0.00014) * 0.18;
      const radius = 35 + (i % 8) * 26 + Math.sin(i + t * 0.00045) * 10;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius * 0.74;
      nodes.push({ x, y });
    }

    ctx.strokeStyle = "rgba(243, 234, 219, 0.14)";
    ctx.fillStyle = "rgba(243, 234, 219, 0.34)";
    ctx.lineWidth = 1;

    nodes.forEach((node, index) => {
      const next = nodes[(index + 5) % nodes.length];
      if (index % 2 === 0) {
        ctx.beginPath();
        ctx.moveTo(node.x, node.y);
        ctx.lineTo(next.x, next.y);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, index % 5 === 0 ? 3 : 2, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.strokeStyle = "rgba(95, 247, 224, 0.65)";
    ctx.beginPath();
    ctx.moveTo(cx - 18, cy);
    ctx.lineTo(cx + 18, cy);
    ctx.moveTo(cx, cy - 18);
    ctx.lineTo(cx, cy + 18);
    ctx.stroke();
  }

  function drawGlyphField(t) {
    const centerX = width * 0.42;
    const centerY = height * 0.28;
    const columns = Math.ceil(width / 15);
    const rows = Math.ceil(height / 18);
    ctx.fillStyle = "rgba(201, 164, 93, 0.13)";

    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        const px = x * 15;
        const py = y * 18;
        const dx = (px - centerX) / Math.max(width, 1);
        const dy = (py - centerY) / Math.max(height, 1);
        const distance = Math.sqrt(dx * dx + dy * dy);
        const ring = Math.sin(distance * 52 - t * 0.0008);

        if (ring > 0.76 && Math.random() > 0.72) {
          const char = chars[(x + y + frame) % chars.length];
          ctx.fillText(char, px, py);
        }
      }
    }
  }

  function draw(t, force = false) {
    if (!running && !force) return;
    if (!force && t - last < 33) {
      requestAnimationFrame(draw);
      return;
    }

    last = t;
    frame += 1;
    ctx.clearRect(0, 0, width, height);
    drawGrid(t);
    drawGlyphField(t);
    drawConstellation(t);

    if (!reduceMotion.matches) requestAnimationFrame(draw);
  }

  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    if (running && !reduceMotion.matches) requestAnimationFrame(draw);
  });

  reduceMotion.addEventListener("change", () => {
    if (reduceMotion.matches) {
      draw(performance.now(), true);
    } else {
      requestAnimationFrame(draw);
    }
  });

  window.addEventListener("resize", resize, { passive: true });
  resize();
  if (!reduceMotion.matches) requestAnimationFrame(draw);
})();
