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
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
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
    await new Promise((resolve) => {
      if (browser.chrome.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 1500);
      browser.chrome.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (browser.chrome.exitCode === null) browser.chrome.kill("SIGKILL");
    await server.close();
  }
}

function same(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function check(condition, message) {
  if (!condition) fail(message);
}

async function evaluate(page, expression) {
  const response = await page.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) fail(`Browser evaluation failed: ${response.exceptionDetails.text}`);
  return response.result?.value;
}

async function waitForExpression(page, expression, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(page, expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  fail(`${label}: timed out`);
}

async function capture(page, filename) {
  await new Promise((resolve) => setTimeout(resolve, 700));
  const screenshot = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  const screenshotPath = path.join(tmpdir(), filename);
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  return screenshotPath;
}

function runtimeProblems(page) {
  return page.events
    .filter((event) => event.method === "Runtime.exceptionThrown" ||
      (event.method === "Log.entryAdded" && event.params?.entry?.level === "error"))
    .map((event) => event.params);
}

function thirdPartyRequests(page, baseUrl) {
  const localOrigin = new URL(baseUrl).origin;
  return page.events
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
}

const atlasEventCapture = `(() => {
  window.__atlasQaErrors = [];
  document.addEventListener("career-atlas:error", (event) => {
    window.__atlasQaErrors.push(String(event.detail?.error?.message || event.detail?.error || "unknown atlas error"));
  });
})();`;

async function openAtlasPage(baseUrl, chromePort, label, options = {}) {
  const page = await newPage(chromePort);
  await page.send("Page.enable");
  await page.send("Network.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  await page.send("Emulation.setDeviceMetricsOverride", options.metrics ?? {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (options.media) await page.send("Emulation.setEmulatedMedia", options.media);
  if (options.scriptDisabled) await page.send("Emulation.setScriptExecutionDisabled", { value: true });
  if (!options.scriptDisabled) {
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `${atlasEventCapture}\n${options.preload ?? ""}`,
    });
  }
  await page.send("Page.navigate", { url: `${baseUrl}${options.hash ?? ""}` });
  await page.waitFor("Page.loadEventFired");
  if (options.scriptDisabled) {
    await page.send("Emulation.setScriptExecutionDisabled", { value: false });
  }
  return { page, label, baseUrl };
}

async function closeAtlasPage(context, options = {}) {
  const { page, label, baseUrl } = context;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const problems = runtimeProblems(page);
  const external = thirdPartyRequests(page, baseUrl);
  const atlasErrors = options.scriptDisabled ? [] : await evaluate(page, "window.__atlasQaErrors || []");
  if (problems.length) fail(`${label}: console/runtime errors: ${JSON.stringify(problems.slice(0, 3))}`);
  if (external.length) fail(`${label}: third-party runtime requests: ${external.join(", ")}`);
  if (options.atlasError) {
    check(atlasErrors.some((message) => options.atlasError.test(message)),
      `${label}: expected atlas error ${options.atlasError}, received ${JSON.stringify(atlasErrors)}`);
  } else if (atlasErrors.length) {
    fail(`${label}: unexpected atlas errors: ${JSON.stringify(atlasErrors)}`);
  }
  await page.send("Page.close").catch(() => {});
  page.close();
}

async function scrollToAtlas(page, label) {
  await evaluate(page, `document.querySelector("[data-career-atlas]").scrollIntoView({ block: "start" }); true`);
  await waitForExpression(page, `document.querySelector("[data-career-atlas]")?.dataset.mounted === "true"`, `${label}: atlas mount`);
}

async function atlasOverflow(page) {
  return evaluate(page, `(() => {
    const root = document.querySelector("[data-career-atlas]");
    const overflowing = [...root.querySelectorAll("*")].filter((element) => {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
    }).map((element) => ({
      tag: element.tagName.toLowerCase(),
      className: typeof element.className === "string" ? element.className : element.getAttribute("class") || "",
      left: Math.round(element.getBoundingClientRect().left),
      right: Math.round(element.getBoundingClientRect().right),
    }));
    return { overflowing, rootScrollWidth: root.scrollWidth, rootClientWidth: root.clientWidth };
  })()`);
}

async function assertAtlasNoOverflow(page, label) {
  const result = await atlasOverflow(page);
  check(result.rootScrollWidth <= result.rootClientWidth + 1,
    `${label}: atlas root overflows ${result.rootScrollWidth}px > ${result.rootClientWidth}px`);
  check(!result.overflowing.length, `${label}: atlas elements overflow viewport: ${JSON.stringify(result.overflowing)}`);
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

async function smokeAtlas() {
  const screenshots = await withBrowser(async (baseUrl, chromePort) => {
    const paths = {};

    const desktop = await openAtlasPage(baseUrl, chromePort, "atlas desktop overview");
    await scrollToAtlas(desktop.page, desktop.label);
    const overview = await evaluate(desktop.page, `(() => {
      const root = document.querySelector("[data-career-atlas]");
      const ledger = root.querySelector(".atlas-ledger");
      return {
        pathCount: root.querySelectorAll("[data-atlas-svg] path[data-state]").length,
        buttonCount: root.querySelectorAll("[data-atlas-state-list] button[data-state]").length,
        interfaceVisible: getComputedStyle(root.querySelector(".atlas-interface")).display !== "none",
        ledgerOpen: ledger.open,
        ledgerVisible: getComputedStyle(ledger).display !== "none",
        year: root.dataset.year,
      };
    })()`);
    same(overview, {
      pathCount: 50,
      buttonCount: 14,
      interfaceVisible: true,
      ledgerOpen: false,
      ledgerVisible: true,
      year: "Overview",
    }, "atlas desktop overview mount");
    await assertAtlasNoOverflow(desktop.page, "atlas desktop after mount");
    paths.desktopOverview = await capture(desktop.page, "sh-patterson-atlas-desktop-overview.png");

    await evaluate(desktop.page, `document.querySelector('input[name="career-year"][value="2022"]').click(); true`);
    await waitForExpression(desktop.page, `document.querySelector("[data-career-atlas]")?.dataset.year === "2022"`, "atlas 2022 selection");
    const stateCodes = await evaluate(desktop.page, `[...document.querySelectorAll("[data-atlas-state-list] button[data-state]")].map((button) => button.dataset.state)`);
    same(stateCodes, ["AZ", "KS", "MT", "NE", "NV", "OR", "WA"], "atlas 2022 state list");
    await evaluate(desktop.page, `document.querySelector('[data-atlas-state-list] button[data-state="OR"]').click(); true`);
    await waitForExpression(desktop.page, `document.querySelector("[data-atlas-case]")?.matches(":popover-open") || document.querySelector("[data-atlas-case]")?.classList.contains("is-open")`, "atlas Oregon case open");
    const oregon = await evaluate(desktop.page, `(() => {
      const root = document.querySelector("[data-career-atlas]");
      const caseFile = root.querySelector("[data-atlas-case]");
      return {
        header: caseFile.querySelector(".case-header h3")?.textContent.trim(),
        recordCount: caseFile.querySelectorAll(".case-record").length,
        evidence: caseFile.querySelector(".case-evidence")?.textContent.replace(/^State evidence:\\s*/, "").trim(),
        receiptLabel: caseFile.querySelector(".receipt-label")?.textContent.trim(),
        hash: location.hash,
      };
    })()`);
    same(oregon, {
      header: "Oregon / 2022",
      recordCount: 1,
      evidence: "3 assignments: OR-04, OR-05, OR-06. 2 wins, 1 loss.",
      receiptLabel: "Cycle Receipt",
      hash: "#career-2022-or",
    }, "atlas Oregon evidence");
    await assertAtlasNoOverflow(desktop.page, "atlas desktop with case file");
    paths.desktopOregon = await capture(desktop.page, "sh-patterson-atlas-desktop-oregon.png");

    await desktop.page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await desktop.page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    await waitForExpression(desktop.page, `document.activeElement?.matches('[data-atlas-state-list] button[data-state="OR"]')`, "atlas Escape focus restoration");
    await evaluate(desktop.page, `document.querySelector('[data-atlas-state-list] button[data-state="OR"]').click(); true`);
    await waitForExpression(desktop.page, `document.querySelector("[data-atlas-case]")?.matches(":popover-open") || document.querySelector("[data-atlas-case]")?.classList.contains("is-open")`, "atlas Oregon reopen");
    await evaluate(desktop.page, `document.querySelector("[data-atlas-close]").click(); true`);
    await waitForExpression(desktop.page, `document.activeElement?.matches('[data-atlas-state-list] button[data-state="OR"]')`, "atlas Close focus restoration");

    await evaluate(desktop.page, `document.querySelector('[data-atlas-state-list] button[data-state="AZ"]').click(); true`);
    await waitForExpression(desktop.page, `document.querySelector("[data-atlas-case]")?.matches(":popover-open") || document.querySelector("[data-atlas-case]")?.classList.contains("is-open")`, "atlas Arizona case open");
    const arizona = await evaluate(desktop.page, `(() => {
      const caseFile = document.querySelector("[data-atlas-case]");
      return {
        recordCount: caseFile.querySelectorAll(".case-record").length,
        header: caseFile.querySelector(".case-header h3")?.textContent.trim(),
        evidence: caseFile.querySelector(".case-evidence")?.textContent.replace(/^State evidence:\\s*/, "").trim(),
        receiptLabel: caseFile.querySelector(".receipt-label")?.textContent.trim(),
        text: caseFile.textContent.replace(/\\s+/g, " ").trim(),
      };
    })()`);
    check(arizona.recordCount === 1 && arizona.header === "Arizona / 2022", "atlas Arizona must contain only its 2022 coverage record");
    check(arizona.evidence === "Arizona was a coverage assignment only. No electoral result claim is made.", "atlas Arizona must make no result claim");
    check(arizona.receiptLabel === "Cycle Receipt · cycle context, not a state result", "atlas Arizona must contextualize its cycle receipt");
    check(!/won|lost|loss|victory/i.test(arizona.evidence), "atlas Arizona evidence contains a result claim");
    await closeAtlasPage(desktop);

    const noJs = await openAtlasPage(baseUrl, chromePort, "atlas no-JS", { scriptDisabled: true });
    const noJsResult = await evaluate(noJs.page, `(() => {
      const root = document.querySelector("[data-career-atlas]");
      const ledger = root.querySelector(".atlas-ledger");
      const roster = root.querySelector('[data-career-id="2022-dccc-rocky-mountains"] .record-roster')?.textContent
        .replace(/^Assignments:\\s*/, "").split(",").map((item) => item.trim());
      return {
        interfaceHidden: getComputedStyle(root.querySelector(".atlas-interface")).display === "none",
        ledgerOpen: ledger.open,
        ledgerVisible: getComputedStyle(ledger.querySelector(".ledger")).display !== "none",
        visibleRecords: [...ledger.querySelectorAll("article[data-career-id]")].filter((article) => article.getBoundingClientRect().height > 0).length,
        roster,
      };
    })()`);
    same(noJsResult, {
      interfaceHidden: true,
      ledgerOpen: true,
      ledgerVisible: true,
      visibleRecords: 6,
      roster: ["NV-01", "NV-03", "NV-04", "OR-04", "OR-05", "OR-06", "WA-08", "KS-03", "NE-02"],
    }, "atlas no-JS fallback");
    await closeAtlasPage(noJs, { scriptDisabled: true });

    const deepLink = await openAtlasPage(baseUrl, chromePort, "atlas valid deep link", { hash: "#career-2022-or" });
    await waitForExpression(deepLink.page, `document.querySelector("[data-career-atlas]")?.dataset.mounted === "true"`, "atlas deep-link mount");
    const deepResult = await evaluate(deepLink.page, `(() => {
      const root = document.querySelector("[data-career-atlas]");
      const selected = root.querySelector('[data-atlas-state-list] button[data-state="OR"]');
      const caseFile = root.querySelector("[data-atlas-case]");
      return {
        year: root.dataset.year,
        yearChecked: root.querySelector('input[name="career-year"][value="2022"]').checked,
        selected: selected?.getAttribute("aria-pressed"),
        open: caseFile.matches(":popover-open") || caseFile.classList.contains("is-open"),
        hash: location.hash,
      };
    })()`);
    same(deepResult, { year: "2022", yearChecked: true, selected: "true", open: true, hash: "#career-2022-or" }, "atlas valid deep link");
    await closeAtlasPage(deepLink);

    const invalidLink = await openAtlasPage(baseUrl, chromePort, "atlas invalid deep link", { hash: "#career-2022-ca" });
    await waitForExpression(invalidLink.page, `document.querySelector("[data-career-atlas]")?.dataset.mounted === "true"`, "atlas invalid-link mount");
    const invalidResult = await evaluate(invalidLink.page, `(() => {
      const root = document.querySelector("[data-career-atlas]");
      const caseFile = root.querySelector("[data-atlas-case]");
      return {
        year: root.dataset.year,
        overviewChecked: root.querySelector('input[name="career-year"][value="Overview"]').checked,
        pressed: root.querySelectorAll('[data-atlas-state-list] button[aria-pressed="true"]').length,
        open: caseFile.matches(":popover-open") || caseFile.classList.contains("is-open"),
      };
    })()`);
    same(invalidResult, { year: "Overview", overviewChecked: true, pressed: 0, open: false }, "atlas invalid deep link fallback");
    await closeAtlasPage(invalidLink);

    const reduced = await openAtlasPage(baseUrl, chromePort, "atlas reduced motion", {
      media: { features: [{ name: "prefers-reduced-motion", value: "reduce" }] },
    });
    await scrollToAtlas(reduced.page, reduced.label);
    await evaluate(reduced.page, `(() => {
      window.__qaViewTransitions = 0;
      if (typeof document.startViewTransition === "function") {
        const original = document.startViewTransition.bind(document);
        document.startViewTransition = (...args) => { window.__qaViewTransitions += 1; return original(...args); };
      }
      document.querySelector('input[name="career-year"][value="2022"]').click();
      return true;
    })()`);
    const reducedResult = await evaluate(reduced.page, `(() => {
      const root = document.querySelector("[data-career-atlas]");
      const webgl = root.querySelector("[data-atlas-webgl]");
      return {
        renderer: root.dataset.renderer,
        checked: root.querySelector("[data-atlas-effects]").checked,
        reducedClass: root.classList.contains("atlas-reduced-effects"),
        webglDisplay: getComputedStyle(webgl).display,
        stateTransition: getComputedStyle(root.querySelector(".atlas-state")).transitionDuration,
        yearTransition: getComputedStyle(root.querySelector(".atlas-year-options span")).transitionDuration,
        viewTransitions: window.__qaViewTransitions,
      };
    })()`);
    check(reducedResult.renderer === "svg" && reducedResult.checked && reducedResult.reducedClass, "atlas reduced motion did not force SVG and checked Reduce effects");
    check(reducedResult.webglDisplay === "none", "atlas reduced motion did not hide the WebGL overlay");
    const hasNegligibleTransition = (durationList) => durationList.split(",").every((value) => {
      const duration = value.trim();
      const magnitude = Number.parseFloat(duration);
      return duration.endsWith("ms") ? magnitude <= 0.001 : duration.endsWith("s") && magnitude <= 0.000001;
    });
    check(hasNegligibleTransition(reducedResult.stateTransition) &&
      hasNegligibleTransition(reducedResult.yearTransition) && reducedResult.viewTransitions === 0,
    `atlas reduced motion did not disable map transitions: ${JSON.stringify(reducedResult)}`);
    await closeAtlasPage(reduced);

    const forcedFailure = await openAtlasPage(baseUrl, chromePort, "atlas forced WebGL failure", {
      preload: `(() => {
        Object.defineProperty(window, "WebGL2RenderingContext", { configurable: true, value: function WebGL2RenderingContext() {} });
        Object.defineProperty(navigator, "hardwareConcurrency", { configurable: true, get: () => 8 });
        Object.defineProperty(navigator, "deviceMemory", { configurable: true, get: () => 8 });
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, ...args) {
          if (type === "webgl2") return null;
          return original.call(this, type, ...args);
        };
      })();`,
    });
    await scrollToAtlas(forcedFailure.page, forcedFailure.label);
    const failureResult = await evaluate(forcedFailure.page, `(() => {
      const root = document.querySelector("[data-career-atlas]");
      return {
        renderer: root.dataset.renderer,
        paths: root.querySelectorAll("[data-atlas-svg] path[data-state]").length,
        webglDisplay: getComputedStyle(root.querySelector("[data-atlas-webgl]")).display,
        errors: window.__atlasQaErrors,
      };
    })()`);
    check(failureResult.renderer === "svg" && failureResult.paths === 50 && failureResult.webglDisplay === "none", "atlas WebGL failure did not retain a clean SVG fallback");
    await closeAtlasPage(forcedFailure, { atlasError: /WebGL2 is unavailable/ });

    const mobile = await openAtlasPage(baseUrl, chromePort, "atlas mobile", {
      metrics: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
    });
    await scrollToAtlas(mobile.page, mobile.label);
    await assertAtlasNoOverflow(mobile.page, "atlas mobile after mount");
    await evaluate(mobile.page, `document.querySelector('input[name="career-year"][value="2022"]').click(); document.querySelector('[data-atlas-state-list] button[data-state="OR"]').click(); true`);
    await waitForExpression(mobile.page, `document.querySelector("[data-atlas-case]")?.matches(":popover-open") || document.querySelector("[data-atlas-case]")?.classList.contains("is-open")`, "atlas mobile Oregon case open");
    await assertAtlasNoOverflow(mobile.page, "atlas mobile with case file");
    paths.mobileOregon = await capture(mobile.page, "sh-patterson-atlas-mobile-oregon.png");
    await closeAtlasPage(mobile);

    const print = await openAtlasPage(baseUrl, chromePort, "atlas print");
    await scrollToAtlas(print.page, print.label);
    await print.page.send("Emulation.setEmulatedMedia", { media: "print" });
    const printResult = await evaluate(print.page, `(() => {
      const root = document.querySelector("[data-career-atlas]");
      return {
        interfaceHidden: getComputedStyle(root.querySelector(".atlas-interface")).display === "none",
        recordDisplays: [...root.querySelectorAll(".atlas-ledger article[data-career-id]")].map((article) => ({
          display: getComputedStyle(article).display,
          height: article.getBoundingClientRect().height,
        })),
      };
    })()`);
    check(printResult.interfaceHidden, "atlas print media did not hide the interactive interface");
    check(printResult.recordDisplays.length === 6 && printResult.recordDisplays.every(({ display, height }) => display !== "none" && height > 0),
      `atlas print media did not keep all six ledger records visible: ${JSON.stringify(printResult.recordDisplays)}`);
    await closeAtlasPage(print);

    return paths;
  });

  console.log("Atlas smoke passed (Chrome launched with --disable-gpu; no positive hardware WebGL assertion).");
  console.log(`atlas desktop Overview screenshot: ${screenshots.desktopOverview}`);
  console.log(`atlas desktop Oregon screenshot: ${screenshots.desktopOregon}`);
  console.log(`atlas mobile Oregon screenshot: ${screenshots.mobileOregon}`);
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
  const warmupRaf = (await page.send("Runtime.evaluate", {
    expression: "window.__qaRaf",
    returnByValue: true,
  })).result.value;
  await page.send("Runtime.evaluate", {
    expression: "window.__qaRaf = { scheduled: 0, callbacks: 0 }",
  });
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
    warmupRaf,
    taskDuration: Number(((end.TaskDuration || 0) - (start.TaskDuration || 0)).toFixed(4)),
    scriptDuration: Number(((end.ScriptDuration || 0) - (start.ScriptDuration || 0)).toFixed(4)),
    raf,
  };
  const budget = options.reducedMotion
    ? { task: 0.05, script: 0.02, warmupRaf: 3, raf: 3 }
    : options.mobile
      ? { task: 1.4, script: 0.8, warmupRaf: 120, raf: 330 }
      : { task: 2.0, script: 1.1, warmupRaf: 120, raf: 330 };
  if (result.warmupRaf.callbacks > budget.warmupRaf) fail(`${label}: warmup RAF callbacks ${result.warmupRaf.callbacks} exceeds ${budget.warmupRaf}`);
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
    console.log(`${result.label} bench passed: task=${result.taskDuration}s script=${result.scriptDuration}s warmup-raf=${result.warmupRaf.callbacks} steady-raf=${result.raf.callbacks}`);
  }
}

try {
  if (command === "links") await checkLinks();
  else if (command === "render") await smokeRender();
  else if (command === "atlas") await smokeAtlas();
  else if (command === "bench") await benchCanvas();
  else if (command === "all") {
    await checkLinks();
    await smokeRender();
    await smokeAtlas();
    await benchCanvas();
  } else {
    fail(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
