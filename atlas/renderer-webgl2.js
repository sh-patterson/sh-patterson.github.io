import { ATLAS_PALETTE, ATLAS_RENDERER_DEFAULTS } from "./config.js";

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_target;
layout(location=1) in float a_seed;
layout(location=2) in float a_active;
layout(location=3) in float a_selected;
uniform vec2 u_viewSize;
uniform vec2 u_surfaceSize;
uniform vec2 u_crosshair;
uniform vec2 u_focus;
uniform float u_resolve;
uniform float u_pulse;
out float v_alpha;
out float v_seed;
void main() {
  float angle = a_seed * 6.2831853;
  vec2 noise = vec2(cos(angle), sin(angle)) * (18.0 + fract(a_seed * 91.7) * 95.0);
  vec2 origin = u_crosshair + noise;
  float resolve = u_resolve * u_resolve * (3.0 - 2.0 * u_resolve);
  vec2 position = mix(origin, a_target, resolve);
  float scale = min(u_surfaceSize.x / u_viewSize.x, u_surfaceSize.y / u_viewSize.y);
  vec2 screen = (u_surfaceSize - u_viewSize * scale) * 0.5 + position * scale;
  vec2 clip = vec2(screen.x / u_surfaceSize.x * 2.0 - 1.0, 1.0 - screen.y / u_surfaceSize.y * 2.0);
  float lens = 1.0 - smoothstep(40.0, 190.0, distance(a_target, u_focus));
  float selected = max(a_selected, lens * 0.55);
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = 3.0 + a_active * 1.4 + selected * 2.1 + a_selected * u_pulse * 3.0;
  v_alpha = 0.16 + a_active * 0.27 + selected * 0.32 + a_selected * u_pulse * 0.24;
  v_seed = a_seed;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_glyphs;
uniform vec3 u_ink;
uniform vec3 u_accent;
in float v_alpha;
in float v_seed;
out vec4 outColor;
void main() {
  float glyph = floor(fract(v_seed * 17.0) * 4.0);
  vec2 uv = vec2((gl_PointCoord.x + glyph) * 0.25, gl_PointCoord.y);
  float alpha = texture(u_glyphs, uv).a;
  if (alpha < 0.08) discard;
  outColor = vec4(mix(u_ink, u_accent, step(0.78, v_alpha)), alpha * v_alpha);
}`;

function rgb(hex) {
  const number = Number.parseInt(hex.slice(1), 16);
  return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255];
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "shader compile failed";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function program(gl) {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const output = gl.createProgram();
  gl.attachShader(output, vertex);
  gl.attachShader(output, fragment);
  gl.linkProgram(output);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(output, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(output) || "program link failed";
    gl.deleteProgram(output);
    throw new Error(message);
  }
  return output;
}

function makeGlyphTexture(gl, canvas) {
  const document = canvas.ownerDocument;
  const glyphCanvas = document?.createElement?.("canvas");
  if (!glyphCanvas) return null;
  glyphCanvas.width = 128;
  glyphCanvas.height = 32;
  const context = glyphCanvas.getContext("2d");
  if (!context) return null;
  context.clearRect(0, 0, 128, 32);
  context.fillStyle = "#fff";
  context.font = '24px "JetBrains Mono", monospace';
  context.textAlign = "center";
  context.textBaseline = "middle";
  ["+", "%", "@", "#"].forEach((glyph, index) => context.fillText(glyph, index * 32 + 16, 16));
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, glyphCanvas);
  return texture;
}

function isActive(activeStates, code) {
  if (!activeStates) return false;
  if (activeStates instanceof Map || activeStates instanceof Set) return activeStates.has(code);
  if (Array.isArray(activeStates)) return activeStates.includes(code);
  return Boolean(activeStates[code]);
}

export class WebGL2AtlasRenderer {
  constructor() {
    this.canvas = null;
    this.gl = null;
    this.geometry = null;
    this.options = {};
    this.program = null;
    this.buffer = null;
    this.texture = null;
    this.vertexCount = 0;
    this.frame = 0;
    this.resolveStarted = 0;
    this.pulseStarted = -Infinity;
    this.selectedState = null;
    this.lastState = {};
    this.width = 1;
    this.height = 1;
    this.disabled = false;
    this.onContextLost = null;
  }

  init(surface, geometry, options = {}) {
    const canvas = surface?.canvas ?? surface;
    this.options = options;
    this.geometry = geometry;
    this.canvas = canvas;
    try {
      if (!canvas?.getContext) throw new TypeError("WebGL2 renderer requires a canvas or { canvas } surface");
      const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, depth: false, powerPreference: "low-power" });
      if (!gl) throw new Error("WebGL2 is unavailable");
      this.gl = gl;
      this.program = program(gl);
      this.buffer = gl.createBuffer();
      this.texture = makeGlyphTexture(gl, canvas);
      if (!this.texture) throw new Error("Unable to create local glyph texture");
      this.onContextLost = (event) => {
        event.preventDefault?.();
        this.disabled = true;
        this.cancelFrame();
        this.options.onError?.(new Error("WebGL context lost"));
      };
      canvas.addEventListener?.("webglcontextlost", this.onContextLost, false);
      this.configureProgram();
      return true;
    } catch (error) {
      this.disabled = true;
      this.options.onError?.(error);
      this.release();
      return false;
    }
  }

  configureProgram() {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const stride = 5 * Float32Array.BYTES_PER_ELEMENT;
    for (const [location, size, offset] of [[0, 2, 0], [1, 1, 2], [2, 1, 3], [3, 1, 4]]) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_glyphs"), 0);
    gl.uniform3fv(gl.getUniformLocation(this.program, "u_ink"), rgb(ATLAS_PALETTE.gold));
    gl.uniform3fv(gl.getUniformLocation(this.program, "u_accent"), rgb(ATLAS_PALETTE.cyan));
  }

  resize(width, height, dpr = 1) {
    if (!this.gl || this.disabled) return;
    const cap = this.options.dprCap ?? ATLAS_RENDERER_DEFAULTS.dprCap;
    const ratio = Math.max(1, Math.min(Number.isFinite(dpr) ? dpr : 1, cap, 2));
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.canvas.width = Math.max(1, Math.floor(width * ratio));
    this.canvas.height = Math.max(1, Math.floor(height * ratio));
    this.canvas.style && (this.canvas.style.width = `${width}px`);
    this.canvas.style && (this.canvas.style.height = `${height}px`);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.draw(performance.now());
  }

  render(state = {}) {
    if (!this.gl || this.disabled) return;
    const selected = state.selectedState ?? null;
    const now = performance.now();
    if (selected && selected !== this.selectedState) this.pulseStarted = now;
    this.selectedState = selected;
    this.lastState = state;
    if (Number(state.transition?.resolve ?? state.transition?.progress ?? 1) < 1) this.resolveStarted = now;
    this.uploadVertices(state.activeStates, selected);
    this.draw(now);
    if (this.needsAnimation(now)) this.scheduleFrame();
  }

  uploadVertices(activeStates, selected) {
    const values = [];
    let index = 0;
    for (const state of this.geometry.states) {
      const active = isActive(activeStates, state.code) ? 1 : 0;
      const selectedFlag = state.code === selected ? 1 : 0;
      for (const [x, y] of state.glyphPoints) {
        const seed = ((index * 2654435761) >>> 0) / 4294967296;
        values.push(x, y, seed, active, selectedFlag);
        index += 1;
      }
    }
    const data = new Float32Array(values);
    this.vertexCount = data.length / 5;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, data, this.gl.DYNAMIC_DRAW);
  }

  needsAnimation(now) {
    return now - this.resolveStarted < 700 || now - this.pulseStarted < 650;
  }

  scheduleFrame() {
    if (this.frame || this.disabled) return;
    const request = globalThis.requestAnimationFrame ?? ((callback) => setTimeout(() => callback(performance.now()), 16));
    this.frame = request((time) => {
      this.frame = 0;
      this.draw(time);
      if (this.needsAnimation(time)) this.scheduleFrame();
    });
  }

  cancelFrame() {
    if (!this.frame) return;
    const cancel = globalThis.cancelAnimationFrame ?? clearTimeout;
    cancel(this.frame);
    this.frame = 0;
  }

  draw(now) {
    const gl = this.gl;
    if (!gl || this.disabled || !this.vertexCount) return;
    const [,, viewWidth, viewHeight] = this.geometry.viewBox;
    const transitionValue = Number(this.lastState.transition?.resolve ?? this.lastState.transition?.progress ?? 1);
    const elapsed = Math.min(1, Math.max(0, (now - this.resolveStarted) / 700));
    const resolve = transitionValue < 1 ? Math.max(transitionValue, elapsed) : 1;
    const selectedGeometry = this.geometry.states.find((state) => state.code === this.selectedState);
    const focus = selectedGeometry?.centroid ?? [-10000, -10000];
    const pulseAge = Math.max(0, (now - this.pulseStarted) / 650);
    const pulse = pulseAge < 1 ? Math.sin(pulseAge * Math.PI) : 0;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(gl.getUniformLocation(this.program, "u_viewSize"), viewWidth, viewHeight);
    gl.uniform2f(gl.getUniformLocation(this.program, "u_surfaceSize"), this.width, this.height);
    gl.uniform2f(gl.getUniformLocation(this.program, "u_crosshair"), viewWidth * 0.9, viewHeight * 0.3);
    gl.uniform2f(gl.getUniformLocation(this.program, "u_focus"), focus[0], focus[1]);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_resolve"), resolve);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_pulse"), pulse);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.drawArrays(gl.POINTS, 0, this.vertexCount);
  }

  hitTest() {
    return null;
  }

  release() {
    const gl = this.gl;
    if (gl) {
      if (this.texture) gl.deleteTexture(this.texture);
      if (this.buffer) gl.deleteBuffer(this.buffer);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.texture = null;
    this.buffer = null;
    this.program = null;
    this.gl = null;
  }

  destroy() {
    this.cancelFrame();
    this.canvas?.removeEventListener?.("webglcontextlost", this.onContextLost, false);
    this.release();
    this.canvas = null;
    this.geometry = null;
    this.disabled = true;
  }
}

export function createWebGL2Renderer() {
  return new WebGL2AtlasRenderer();
}
