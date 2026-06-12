#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const command = process.argv[2] || "all";
const chromeCandidates = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function fail(message) {
  throw new Error(message);
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}=["']([^"']+)["']`, "i"));
  return match ? match[1] : "";
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".gstack" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

async function htmlFiles() {
  return (await walk(root)).filter((file) => file.endsWith(".html"));
}

function normalizeLocal(fromFile, rawUrl) {
  const clean = rawUrl.split("#")[0].split("?")[0];
  if (!clean || clean.startsWith("mailto:") || clean.startsWith("tel:") || clean.startsWith("javascript:")) return null;
  if (/^https?:\/\//i.test(clean)) {
    const parsed = new URL(clean);
    if (parsed.origin !== "https://sh-patterson.github.io") return null;
    return parsed.pathname === "/" ? path.join(root, "index.html") : path.join(root, parsed.pathname);
  }
  const base = path.dirname(fromFile);
  const resolved = clean.startsWith("/")
    ? path.join(root, clean)
    : path.resolve(base, clean);
  return resolved.endsWith(path.sep) ? path.join(resolved, "index.html") : resolved;
}

function extractLinks(file, html) {
  const links = [];
  const tagPattern = /<(a|link|script|meta)\b[^>]*>/gi;
  for (const match of html.matchAll(tagPattern)) {
    const tag = match[0];
    const name = match[1].toLowerCase();
    if (name === "a") {
      const href = attr(tag, "href");
      if (href) links.push({ file, kind: "anchor", url: href });
    } else if (name === "script") {
      const src = attr(tag, "src");
      if (src) links.push({ file, kind: "asset", url: src });
    } else if (name === "link") {
      const rel = attr(tag, "rel").toLowerCase();
      if (rel.includes("preconnect") || rel.includes("dns-prefetch")) continue;
      const href = attr(tag, "href");
      if (href) links.push({ file, kind: "asset", url: href });
    } else if (name === "meta") {
      const key = (attr(tag, "property") || attr(tag, "name")).toLowerCase();
      if (key === "og:image" || key === "twitter:image") {
        const content = attr(tag, "content");
        if (content) links.push({ file, kind: "image-meta", url: content });
      }
    }
  }
  return links;
}

async function fetchStatus(url) {
  const options = {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 sh-patterson-site-qa/1.0",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(12000),
  };
  try {
    let response = await fetch(url, { ...options, method: "HEAD" });
    if ([400, 403, 405, 999].includes(response.status)) {
      response = await fetch(url, { ...options, method: "GET" });
    }
    return { url, status: response.status, finalUrl: response.url };
  } catch (error) {
    return { url, error: error.name === "TimeoutError" ? "timeout" : error.message };
  }
}

async function checkLinks() {
  const files = await htmlFiles();
  const allLinks = [];
  const allHtml = [];
  for (const file of files) {
    const html = await readFile(file, "utf8");
    allHtml.push(html);
    allLinks.push(...extractLinks(file, html));
  }

  const failures = [];
  const warnings = [];
  for (const link of allLinks) {
    const local = normalizeLocal(link.file, link.url);
    if (local) {
      const finalPath = existsSync(local) ? local : path.join(local, "index.html");
      if (!existsSync(finalPath)) failures.push(`Missing local ${link.kind}: ${link.url} from ${path.relative(root, link.file)}`);
      continue;
    }

    if (!/^https?:\/\//i.test(link.url)) continue;
    const result = await fetchStatus(link.url);
    if (result.error) {
      warnings.push(`External check warning: ${link.url} (${result.error})`);
      continue;
    }
    const status = result.status;
    if (link.url.includes("linkedin.com") && status >= 400) {
      warnings.push(`External source guarded ${status}: ${link.url}`);
    } else if (status === 404 || status === 410 || status >= 500 || (status >= 400 && status < 500 && ![401, 403, 999].includes(status))) {
      failures.push(`External link failed ${status}: ${link.url}`);
    } else if (status === 401 || status === 403 || status === 999) {
      warnings.push(`External source guarded ${status}: ${link.url}`);
    }
  }

  for (const warning of warnings) console.warn(warning);
  if (failures.length) fail(`Link check failed:\n${failures.join("\n")}`);
  console.log(`Link check passed: ${allLinks.length} links/assets across ${files.length} HTML files.`);
}

function findChrome() {
  const chrome = chromeCandidates.find((candidate) => candidate && existsSync(candidate));
  if (!chrome) fail("Google Chrome or Chromium was not found. Set CHROME_PATH to run render and bench checks.");
  return chrome;
}

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const decoded = decodeURIComponent(url.pathname);
      const requested = path.normalize(decoded === "/" ? "/index.html" : decoded);
      const full = path.join(root, requested);
      if (!full.startsWith(root)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      let file = full;
      const info = await stat(file).catch(() => null);
      if (info?.isDirectory()) file = path.join(file, "index.html");
      const body = await readFile(file);
      response.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function launchChrome() {
  const debugServer = createServer();
  await new Promise((resolve) => debugServer.listen(0, "127.0.0.1", resolve));
  const { port } = debugServer.address();
  await new Promise((resolve) => debugServer.close(resolve));

  const profile = path.join(tmpdir(), `sh-patterson-site-qa-${process.pid}-${Date.now()}`);
  const chrome = spawn(findChrome(), [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const stderr = [];
  chrome.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return { port, chrome, stderr };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  chrome.kill();
  fail(`Chrome did not start on port ${port}.\n${stderr.join("")}`);
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result || {});
      } else if (message.method) {
        this.events.push(message);
      }
    };
  }

  async send(method, params = {}) {
    await this.opened;
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async waitFor(method, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.events.some((event) => event.method === method)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    fail(`Timed out waiting for ${method}`);
  }

  close() {
    this.ws.close();
  }
}

async function newPage(chromePort) {
  const target = await fetch(`http://127.0.0.1:${chromePort}/json/new`, { method: "PUT" }).then((response) => response.json());
  return new Cdp(target.webSocketDebuggerUrl);
}

function metricMap(metrics) {
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

async function withBrowser(callback) {
  const server = await startStaticServer();
  const browser = await launchChrome();
  try {
    return await callback(server.url, browser.port);
  } finally {
    browser.chrome.kill();
    await server.close();
  }
}

async function renderCase(baseUrl, chromePort, label, metrics) {
  const page = await newPage(chromePort);
  await page.send("Page.enable");
  await page.send("Network.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  await page.send("Emulation.setDeviceMetricsOverride", metrics);
  await page.send("Page.navigate", { url: baseUrl });
  await page.waitFor("Page.loadEventFired");
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const expression = `(() => {
    const skip = document.querySelector(".skip-link");
    skip.focus();
    const overflowing = [...document.querySelectorAll("body *")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { tag: el.tagName.toLowerCase(), cls: el.className || "", left: Math.round(rect.left), right: Math.round(rect.right) };
      })
      .filter((item) => item.right > window.innerWidth + 1 || item.left < -1)
      .filter((item) => !["folio-section", "site-footer"].some((allowed) => String(item.cls).includes(allowed)));
    return {
      title: document.title,
      h1: document.querySelector("h1")?.textContent.trim(),
      hasProjects: document.body.textContent.includes("legiscan-mcp") &&
        document.body.textContent.includes("fec-mcp-server") &&
        document.body.textContent.includes("fcc-opif-extractor"),
      skipFocused: document.activeElement === skip,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      overflowing,
      canvas: (() => {
        const canvas = document.querySelector("#atlas-canvas");
        const rect = canvas.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height), attrWidth: canvas.width, attrHeight: canvas.height };
      })()
    };
  })()`;
  const result = (await page.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  const screenshot = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const screenshotPath = path.join(tmpdir(), `sh-patterson-${label}.png`);
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));

  const errors = page.events
    .filter((event) => event.method === "Runtime.exceptionThrown" || (event.method === "Log.entryAdded" && event.params?.entry?.level === "error"))
    .map((event) => event.params);
  const localOrigin = new URL(baseUrl).origin;
  const thirdPartyRequests = page.events
    .filter((event) => event.method === "Network.requestWillBeSent")
    .map((event) => event.params?.request?.url)
    .filter(Boolean)
    .filter((url) => {
      if (url === "about:blank" || url.startsWith("data:") || url.startsWith("blob:")) return false;
      try {
        return new URL(url).origin !== localOrigin;
      } catch {
        return false;
      }
    });
  await page.send("Page.close").catch(() => {});
  page.close();

  if (!result.title.includes("Shawn Patterson")) fail(`${label}: wrong page title`);
  if (result.h1 !== "Shawn Patterson") fail(`${label}: missing hero heading`);
  if (!result.hasProjects) fail(`${label}: project entries missing`);
  if (!result.skipFocused) fail(`${label}: skip link did not receive focus`);
  if (result.scrollWidth > result.innerWidth + 1) fail(`${label}: document has horizontal overflow`);
  if (result.overflowing.length) fail(`${label}: elements overflow viewport: ${JSON.stringify(result.overflowing)}`);
  if (!result.canvas.width || !result.canvas.height) fail(`${label}: canvas did not size correctly`);
  if (errors.length) fail(`${label}: console/runtime errors: ${JSON.stringify(errors.slice(0, 3))}`);
  if (thirdPartyRequests.length) fail(`${label}: third-party page-load requests: ${thirdPartyRequests.join(", ")}`);
  return { label, screenshotPath, result };
}

async function smokeRender() {
  const results = await withBrowser(async (baseUrl, chromePort) => [
    await renderCase(baseUrl, chromePort, "desktop", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false }),
    await renderCase(baseUrl, chromePort, "mobile", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }),
  ]);
  for (const result of results) console.log(`${result.label} render passed: ${result.screenshotPath}`);
}

async function benchCase(baseUrl, chromePort, label, metrics, options = {}) {
  const page = await newPage(chromePort);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Performance.enable");
  await page.send("Emulation.setDeviceMetricsOverride", metrics);
  if (options.reducedMotion) {
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
  }
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const original = window.requestAnimationFrame;
      window.__qaRaf = { scheduled: 0, callbacks: 0 };
      window.requestAnimationFrame = function(callback) {
        window.__qaRaf.scheduled += 1;
        return original.call(this, function(time) {
          window.__qaRaf.callbacks += 1;
          return callback(time);
        });
      };
    })();`,
  });
  await page.send("Page.navigate", { url: baseUrl });
  await page.waitFor("Page.loadEventFired");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const start = metricMap((await page.send("Performance.getMetrics")).metrics);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const end = metricMap((await page.send("Performance.getMetrics")).metrics);
  const raf = (await page.send("Runtime.evaluate", {
    expression: "window.__qaRaf",
    returnByValue: true,
  })).result.value;

  await page.send("Page.close").catch(() => {});
  page.close();

  const result = {
    label,
    taskDuration: Number(((end.TaskDuration || 0) - (start.TaskDuration || 0)).toFixed(4)),
    scriptDuration: Number(((end.ScriptDuration || 0) - (start.ScriptDuration || 0)).toFixed(4)),
    raf,
  };
  const budget = options.reducedMotion
    ? { task: 0.05, script: 0.02, raf: 3 }
    : options.mobile
      ? { task: 1.4, script: 0.8, raf: 380 }
      : { task: 2.0, script: 1.1, raf: 380 };
  if (result.taskDuration > budget.task) fail(`${label}: task duration ${result.taskDuration}s exceeds ${budget.task}s`);
  if (result.scriptDuration > budget.script) fail(`${label}: script duration ${result.scriptDuration}s exceeds ${budget.script}s`);
  if (result.raf.callbacks > budget.raf) fail(`${label}: RAF callbacks ${result.raf.callbacks} exceeds ${budget.raf}`);
  return result;
}

async function benchCanvas() {
  const results = await withBrowser(async (baseUrl, chromePort) => [
    await benchCase(baseUrl, chromePort, "desktop", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false }),
    await benchCase(baseUrl, chromePort, "mobile", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, { mobile: true }),
    await benchCase(baseUrl, chromePort, "reduced-motion", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false }, { reducedMotion: true }),
  ]);
  for (const result of results) {
    console.log(`${result.label} bench passed: task=${result.taskDuration}s script=${result.scriptDuration}s raf=${result.raf.callbacks}`);
  }
}

try {
  if (command === "links") await checkLinks();
  else if (command === "render") await smokeRender();
  else if (command === "bench") await benchCanvas();
  else if (command === "all") {
    await checkLinks();
    await smokeRender();
    await benchCanvas();
  } else {
    fail(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
