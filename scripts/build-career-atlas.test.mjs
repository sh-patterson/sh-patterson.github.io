import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  HTML_MARKERS,
  deriveRecordStates,
  renderCareerHtml,
  renderCareerMarkdown,
  renderRuntimeModule,
  replaceMarkedSection,
  validateCareerAtlas
} from "./build-career-atlas.mjs";

const data = JSON.parse(await readFile(new URL("../data/career-atlas.json", import.meta.url), "utf8"));

test("canonical career data validates", () => {
  assert.deepEqual(validateCareerAtlas(data), []);
});

test("canonical receipts retain their source text and links", () => {
  assert.deepEqual(data.receipts.map(({ quote, url }) => [quote, url]), [
    [
      "Democratic Sen. Joe Manchin has won re-election in West Virginia in the heart of Trump country, dispatching Republican state Attorney General Patrick Morrisey.",
      "https://rollcall.com/2018/11/06/west-virginias-joe-manchin-stays-put-in-trump-country/"
    ],
    [
      "Democrats won both Georgia Senate seats and with them, the U.S. Senate majority, serving President Donald Trump a stunning defeat in his last days in office.",
      "https://www.pbs.org/newshour/politics/ossoff-wins-in-georgia-tipping-senate-control-to-democrats"
    ],
    [
      "No Democratic president with control of the Senate has ever duplicated the achievement of picking up Senate seats, or even holding steady, in a midterm election. Until now?",
      "https://www.theatlantic.com/newsletters/archive/2022/11/democrats-biggest-midterm-shock-polls/672055/"
    ],
    [
      "Final election results: 2023 was the closest Mississippi governor's race since 1999.",
      "https://mississippitoday.org/2023/11/22/final-election-results-2023-mississippi-governors-race/"
    ],
    [
      "Ruben Gallego outperformed Harris, dominated with Latinos and won Arizona.",
      "https://www.nbcnews.com/politics/2024-elections/arizona-senate-results"
    ],
    [
      "the everyday miracle of living in a state that regularly makes the improbable seem inevitable.",
      "https://calmatters.org/politics/2026/06/california-primary-governor-becerra/"
    ]
  ]);
});

test("canonical records preserve public summaries independently of outcomes", () => {
  const summaries = Object.fromEntries(data.records.map(({ id, summary }) => [id, summary]));
  assert.equal(summaries["2018-wv-manchin"], "I executed embedded video research and rapid-response operations directly from the trail in a high-exposure defense cycle, authoring the debate briefings, tracking opponent event vulnerabilities, and intercepting hostile media pitches in the heart of Trump country.");
  assert.equal(summaries["2023-ms-presley"], "I ran a dual-desk campaign war room, authoring a comprehensive policy platform while deploying custom AI scrapers to convert 20 years of scanned paper records into digital datasets linking travel logs and state contracts to a public corruption narrative.");
  assert.equal(summaries["2024-az-gallego"], "I directed the core research operation for a top-tier battleground state. My team managed full-scale contingency planning, conducted legal and property audits, and built a rapid-response department that secured over 20 successful fact-checks against multi-million-dollar attack ads.");
  assert.match(summaries["2020-dscc-senate-portfolio"], /Georgia, Iowa, Kansas, Michigan, and New Hampshire/);
  assert.match(summaries["2022-dccc-rocky-mountains"], /portfolio won seven of nine/);
  assert.match(summaries["2026-ca-becerra"], /single-digit polling to first place/);
  assert.equal(data.records.find(({ id }) => id === "2023-ms-presley").outcome, "The closest Mississippi governor's race since 1999.");
  assert.equal(data.records.find(({ id }) => id === "2023-ms-presley").resultType, "loss");
});

test("receipt kinds distinguish cycle-level evidence", () => {
  assert.deepEqual(data.receipts.map(({ id, kind }) => [id, kind]), [
    ["receipt-2018-manchin", "receipt"],
    ["receipt-2020-dscc", "cycle-receipt"],
    ["receipt-2022-dccc", "cycle-receipt"],
    ["receipt-2023-presley", "receipt"],
    ["receipt-2024-gallego", "receipt"],
    ["receipt-2026-becerra", "receipt"]
  ]);

  const invalid = structuredClone(data);
  invalid.receipts.find(({ id }) => id === "receipt-2020-dscc").kind = "receipt";
  assert.ok(validateCareerAtlas(invalid).includes("receipt-2020-dscc kind must be cycle-receipt"));
});

test("HTML and Markdown fragments are deterministic and accessible", () => {
  const html = renderCareerHtml(data);
  const markdown = renderCareerMarkdown(data);

  assert.equal(html, renderCareerHtml(structuredClone(data)));
  assert.equal(markdown, renderCareerMarkdown(structuredClone(data)));
  assert.match(html, /<article id="career-2026-ca" data-career-id="2026-ca-becerra"/);
  assert.match(html, /id="career-2026-ca"/);
  assert.match(html, /data-career-states="NV OR WA KS NE AZ MT"/);
  assert.match(html, /<h3>Becerra for Governor \/ Research Consultant<\/h3>/);
  assert.match(html, /<blockquote>[\s\S]*<cite><a href="https:\/\/calmatters\.org/);
  assert.match(html, /Additional coverage:<\/strong> Arizona off-year coverage \(no result claim\); Montana regional coverage \(no result claim\)\./);
  assert.match(markdown, /^### 2026 — Becerra for Governor \/ Research Consultant/m);
  assert.match(markdown, /Additional coverage: Arizona off-year coverage \(no result claim\); Montana regional coverage \(no result claim\)\./);
  assert.equal((html.match(/<span class="receipt-label">Cycle Receipt<\/span>/g) || []).length, 2);
  assert.equal((html.match(/<span class="receipt-label">Receipt<\/span>/g) || []).length, 4);
  assert.equal((markdown.match(/^Cycle Receipt$/gm) || []).length, 2);
  assert.doesNotMatch(html, /2022-dccc-arizona-coverage|2022-dccc-montana-coverage/);
});

test("runtime module includes receipts, references, evidence, summaries, and states", () => {
  const runtime = renderRuntimeModule(data);
  assert.equal(runtime, renderRuntimeModule(structuredClone(data)));
  assert.match(runtime, /^\/\/ Generated by/);
  assert.match(runtime, /"receiptId": "receipt-2020-dscc"/);
  assert.match(runtime, /"evidenceNote": "The two-seat victory claim/);
  assert.match(runtime, /"summary": "I wrote comprehensive opposition research books/);
  assert.match(runtime, /"receipts": \[/);
  assert.match(runtime, /"attribution": "Roll Call"/);
  assert.match(runtime, /"NV-01"/);
  assert.match(runtime, /"activeStates": \[\n        "GA",\n        "IA",\n        "KS",\n        "MI",\n        "NH"/);
});

test("active states derive deterministically from structured assignments and coverage", () => {
  const dscc = data.records.find(({ id }) => id === "2020-dscc-senate-portfolio");
  const dccc = data.records.find(({ id }) => id === "2022-dccc-rocky-mountains");
  const arizonaCoverage = data.records.find(({ id }) => id === "2022-dccc-arizona-coverage");
  assert.deepEqual(deriveRecordStates(dscc, data.records), ["GA", "IA", "KS", "MI", "NH"]);
  assert.deepEqual(deriveRecordStates(dccc, data.records), ["NV", "OR", "WA", "KS", "NE", "AZ", "MT"]);
  assert.deepEqual(deriveRecordStates(arizonaCoverage, data.records), ["AZ"]);
});

test("validation rejects result claims on coverage records", () => {
  const invalid = structuredClone(data);
  const coverage = invalid.records.find((record) => record.scopeType === "off-year-coverage");
  coverage.outcome = "Won";
  coverage.resultType = "win";
  assert.deepEqual(validateCareerAtlas(invalid).filter((error) => error.includes("coverage must")), [
    "2022-dccc-arizona-coverage coverage must use resultType no-claim",
    "2022-dccc-arizona-coverage coverage must not make an outcome claim"
  ]);
});

test("validation enforces the DCCC nine-district, seven-win ledger", () => {
  const invalid = structuredClone(data);
  invalid.records.find((record) => record.id === "2022-dccc-rocky-mountains").outcome.wins.pop();
  assert.ok(validateCareerAtlas(invalid).some((error) => error.includes("canonical seven assignments")));
});

test("fragment replacement requires explicit markers", () => {
  assert.throws(
    () => replaceMarkedSection("<main></main>", HTML_MARKERS, "fragment", "index.html"),
    /missing ordered career atlas markers.*career-atlas:start.*career-atlas:end/
  );
  assert.equal(
    replaceMarkedSection(`${HTML_MARKERS[0]}\nold\n${HTML_MARKERS[1]}`, HTML_MARKERS, "new", "index.html"),
    `${HTML_MARKERS[0]}\nnew\n${HTML_MARKERS[1]}`
  );
});
