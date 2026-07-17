#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataPath = path.join(root, "data", "career-atlas.json");
const htmlPath = path.join(root, "index.html");
const markdownPath = path.join(root, "website-text.md");
const runtimePath = path.join(root, "atlas", "career-data.generated.js");

export const CANONICAL_YEARS = Object.freeze(["Overview", "2018", "2020", "2022", "2023", "2024", "2026"]);
export const SCOPE_TYPES = Object.freeze(["campaign", "portfolio", "regional-coverage", "off-year-coverage"]);
export const RESULT_TYPES = Object.freeze(["win", "advanced", "portfolio-result", "context", "no-claim"]);
export const RECEIPT_KINDS = Object.freeze(["receipt", "cycle-receipt"]);
export const HTML_MARKERS = Object.freeze(["<!-- career-atlas:start -->", "<!-- career-atlas:end -->"]);
export const MARKDOWN_MARKERS = Object.freeze(["<!-- career-atlas:start -->", "<!-- career-atlas:end -->"]);

const STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
  "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT",
  "VA", "WA", "WV", "WI", "WY", "DC"
]);
const REQUIRED_RECORD_FIELDS = [
  "id", "year", "state", "organization", "campaign", "role", "scopeType", "roster", "outcome",
  "resultType", "receiptId", "evidenceNote", "summary"
];
const EXPECTED_ROLES = new Map([
  ["2018-wv-manchin", "Tracker and Research Analyst"],
  ["2020-dscc-senate-portfolio", "Research Associate"],
  ["2022-dccc-rocky-mountains", "Regional Research Director"],
  ["2023-ms-presley", "Research and Policy Director"],
  ["2024-az-gallego", "Research Director"],
  ["2026-ca-becerra", "Strategic Messaging Consultant"]
]);
const EXPECTED_RECEIPT_KINDS = new Map([
  ["receipt-2018-manchin", "receipt"],
  ["receipt-2020-dscc", "cycle-receipt"],
  ["receipt-2022-dccc", "cycle-receipt"],
  ["receipt-2023-presley", "receipt"],
  ["receipt-2024-gallego", "receipt"],
  ["receipt-2026-becerra", "receipt"]
]);

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

function recordTitle(record) {
  const campaign = ["DCCC", "DSCC"].includes(record.organization) ? record.organization : record.campaign;
  return `${record.role} · ${campaign}`;
}

function assertion(condition, message, errors) {
  if (!condition) errors.push(message);
}

export function validateCareerAtlas(data) {
  const errors = [];
  assertion(data && typeof data === "object", "career atlas must be an object", errors);
  if (!data || typeof data !== "object") return errors;

  assertion(JSON.stringify(data.years) === JSON.stringify(CANONICAL_YEARS), `years must be ${CANONICAL_YEARS.join(", ")}`, errors);
  assertion(Array.isArray(data.receipts), "receipts must be an array", errors);
  assertion(Array.isArray(data.records), "records must be an array", errors);
  if (!Array.isArray(data.receipts) || !Array.isArray(data.records)) return errors;

  const receiptIds = new Set();
  for (const receipt of data.receipts) {
    assertion(receipt && typeof receipt.id === "string" && receipt.id.length > 0, "every receipt needs an id", errors);
    if (!receipt?.id) continue;
    assertion(!receiptIds.has(receipt.id), `duplicate receipt id: ${receipt.id}`, errors);
    receiptIds.add(receipt.id);
    assertion(typeof receipt.quote === "string" && receipt.quote.length > 0, `${receipt.id} needs a quote`, errors);
    assertion(RECEIPT_KINDS.includes(receipt.kind), `${receipt.id} has an invalid kind: ${receipt.kind}`, errors);
    if (EXPECTED_RECEIPT_KINDS.has(receipt.id)) {
      assertion(receipt.kind === EXPECTED_RECEIPT_KINDS.get(receipt.id), `${receipt.id} kind must be ${EXPECTED_RECEIPT_KINDS.get(receipt.id)}`, errors);
    }
    assertion(typeof receipt.attribution === "string" && receipt.attribution.length > 0, `${receipt.id} needs an attribution`, errors);
    assertion(/^https:\/\//.test(receipt.url), `${receipt.id} needs an HTTPS URL`, errors);
  }

  const recordIds = new Set();
  const allowedYears = new Set(CANONICAL_YEARS.slice(1));
  for (const record of data.records) {
    const label = record?.id || "record with no id";
    for (const field of REQUIRED_RECORD_FIELDS) {
      assertion(Object.hasOwn(record || {}, field), `${label} is missing ${field}`, errors);
    }
    if (!record?.id) continue;
    assertion(!recordIds.has(record.id), `duplicate record id: ${record.id}`, errors);
    recordIds.add(record.id);
    assertion(allowedYears.has(record.year), `${label} has a non-canonical year: ${record.year}`, errors);
    assertion(STATE_CODES.has(record.state), `${label} has an invalid state code: ${record.state}`, errors);
    assertion(SCOPE_TYPES.includes(record.scopeType), `${label} has an invalid scopeType: ${record.scopeType}`, errors);
    assertion(RESULT_TYPES.includes(record.resultType), `${label} has an invalid resultType: ${record.resultType}`, errors);
    assertion(Array.isArray(record.roster), `${label} roster must be an array`, errors);
    assertion(typeof record.role === "string" && record.role.length > 0, `${label} needs a role`, errors);
    assertion(typeof record.summary === "string" && record.summary.trim().length > 0, `${label} needs a public summary`, errors);
    if (typeof record.summary === "string") {
      assertion(record.summary === record.summary.trim(), `${label} public summary must not have surrounding whitespace`, errors);
    }
    if (EXPECTED_ROLES.has(record.id)) {
      assertion(record.role === EXPECTED_ROLES.get(record.id), `${label} role must be ${EXPECTED_ROLES.get(record.id)}`, errors);
    }
    if (record.receiptId !== null) {
      assertion(receiptIds.has(record.receiptId), `${label} references unknown receipt ${record.receiptId}`, errors);
    }
    for (const assignment of record.roster || []) {
      const state = assignment.match(/^([A-Z]{2})(?:-\d{2})?$/)?.[1];
      assertion(Boolean(state && STATE_CODES.has(state)), `${label} has an invalid roster assignment: ${assignment}`, errors);
    }
    if (["regional-coverage", "off-year-coverage"].includes(record.scopeType)) {
      assertion(record.resultType === "no-claim", `${label} coverage must use resultType no-claim`, errors);
      assertion(record.outcome === null, `${label} coverage must not make an outcome claim`, errors);
      assertion(record.receiptId === null, `${label} coverage must not attach a result receipt`, errors);
    }
  }

  assertion(recordIds.size === EXPECTED_ROLES.size, `expected ${EXPECTED_ROLES.size} canonical records`, errors);
  for (const id of EXPECTED_ROLES.keys()) assertion(recordIds.has(id), `missing canonical record: ${id}`, errors);

  const dscc = data.records.find((record) => record.id === "2020-dscc-senate-portfolio");
  if (dscc) {
    assertion(JSON.stringify(dscc.roster) === JSON.stringify(["GA", "IA", "KS", "MI", "NH"]), "DSCC roster must be GA, IA, KS, MI, NH", errors);
    assertion(dscc.outcome?.summary?.includes("Georgia and Iowa were the primary focus"), "DSCC outcome must identify Georgia and Iowa as primary", errors);
    assertion(JSON.stringify(Object.keys(dscc.outcome?.stateClaims || {})) === JSON.stringify(["GA"]), "only Georgia may carry a DSCC result claim", errors);
  }

  const dccc = data.records.find((record) => record.id === "2022-dccc-rocky-mountains");
  if (dccc) {
    const expectedRoster = ["AZ-01", "AZ-06", "KS-03", "MT-02", "NE-02", "NV-01", "NV-03", "NV-04", "OR-04", "OR-05", "OR-06", "WA-08"];
    assertion(JSON.stringify(dccc.roster) === JSON.stringify(expectedRoster), "DCCC roster must contain the canonical twelve districts in order", errors);
  }

  return errors;
}

function assertValid(data) {
  const errors = validateCareerAtlas(data);
  if (errors.length) throw new Error(`Career atlas validation failed:\n- ${errors.join("\n- ")}`);
}

function groupedRenderableRecords(data) {
  const order = new Map(CANONICAL_YEARS.map((year, index) => [year, index]));
  return data.records
    .filter((record) => record.resultType !== "no-claim")
    .toSorted((a, b) => order.get(b.year) - order.get(a.year) || a.id.localeCompare(b.id));
}

function rosterState(assignment) {
  return assignment.match(/^([A-Z]{2})(?:-\d{2})?$/)?.[1] || null;
}

export function deriveRecordStates(record, records = []) {
  const relatedStates = record.scopeType === "portfolio"
    ? records
      .filter((candidate) => candidate.year === record.year
        && candidate.organization === record.organization
        && candidate.resultType === "no-claim")
      .map((candidate) => candidate.state)
    : [];
  return [...new Set([record.state, ...record.roster.map(rosterState), ...relatedStates].filter(Boolean))];
}

export function renderCareerHtml(data) {
  assertValid(data);
  const receipts = new Map(data.receipts.map((receipt) => [receipt.id, receipt]));
  return groupedRenderableRecords(data).map((record) => {
    const receipt = receipts.get(record.receiptId);
    const roster = record.roster.length
      ? `\n                        <p class="record-roster">${record.roster.map(escapeHtml).join(" · ")}</p>`
      : "";
    const states = deriveRecordStates(record, data.records);
    return `                <article id="career-${escapeHtml(record.year)}-${escapeHtml(record.state.toLowerCase())}" data-career-id="${escapeHtml(record.id)}" data-career-year="${escapeHtml(record.year)}" data-career-state="${escapeHtml(record.state)}" data-career-states="${escapeHtml(states.join(" "))}">
                    <div class="record-date">${escapeHtml(record.year)}</div>
                    <div>
                        <h3>${escapeHtml(recordTitle(record))}</h3>${roster}
                        <blockquote>
                            <p>${escapeHtml(receipt.quote)}</p>
                            <cite><a href="${escapeHtml(receipt.url)}">${escapeHtml(receipt.attribution)}</a></cite>
                        </blockquote>
                    </div>
                </article>`;
  }).join("\n");
}

export function renderCareerMarkdown(data) {
  assertValid(data);
  const receipts = new Map(data.receipts.map((receipt) => [receipt.id, receipt]));
  return groupedRenderableRecords(data).map((record) => {
    const receipt = receipts.get(record.receiptId);
    const roster = record.roster.length ? `\n\n${record.roster.join(" · ")}` : "";
    return `### ${record.year} — ${recordTitle(record)}${roster}\n\n"${receipt.quote}" — ${receipt.attribution}\n${receipt.url}`;
  }).join("\n\n");
}

export function renderRuntimeModule(data) {
  assertValid(data);
  const runtime = {
    years: data.years,
    receipts: data.receipts,
    records: data.records.map((record) => ({
      ...record,
      activeStates: deriveRecordStates(record, data.records)
    }))
  };
  return `// Generated by scripts/build-career-atlas.mjs. Do not edit.\nexport const careerAtlas = ${JSON.stringify(runtime, null, 2)};\n`;
}

export function replaceMarkedSection(source, markers, fragment, fileLabel) {
  const [start, end] = markers;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`${fileLabel} is missing ordered career atlas markers. Add ${start} and ${end} around the generated career section.`);
  }
  if (source.indexOf(start, startIndex + start.length) !== -1 || source.indexOf(end, endIndex + end.length) !== -1) {
    throw new Error(`${fileLabel} must contain exactly one career atlas marker pair.`);
  }
  const before = source.slice(0, startIndex + start.length);
  const after = source.slice(endIndex);
  return `${before}\n${fragment}\n${after}`;
}

export function generateOutputs(data, sources) {
  assertValid(data);
  return {
    html: replaceMarkedSection(sources.html, HTML_MARKERS, renderCareerHtml(data), "index.html"),
    markdown: replaceMarkedSection(sources.markdown, MARKDOWN_MARKERS, renderCareerMarkdown(data), "website-text.md"),
    runtime: renderRuntimeModule(data)
  };
}

async function run() {
  const write = process.argv.includes("--write");
  const check = process.argv.includes("--check");
  if (write === check) throw new Error("Use exactly one mode: --write or --check.");

  const [rawData, html, markdown] = await Promise.all([
    readFile(dataPath, "utf8"),
    readFile(htmlPath, "utf8"),
    readFile(markdownPath, "utf8")
  ]);
  const data = JSON.parse(rawData);
  const outputs = generateOutputs(data, { html, markdown });

  if (check) {
    const drift = [];
    if (outputs.html !== html) drift.push("index.html");
    if (outputs.markdown !== markdown) drift.push("website-text.md");
    let runtime = "";
    try {
      runtime = await readFile(runtimePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (outputs.runtime !== runtime) drift.push("atlas/career-data.generated.js");
    if (drift.length) throw new Error(`Generated career atlas drift detected in: ${drift.join(", ")}. Run npm run build:atlas.`);
    process.stdout.write("Career atlas generated files are current.\n");
    return;
  }

  await Promise.all([
    writeFile(htmlPath, outputs.html),
    writeFile(markdownPath, outputs.markdown),
    writeFile(runtimePath, outputs.runtime)
  ]);
  process.stdout.write("Wrote career atlas generated files.\n");
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
