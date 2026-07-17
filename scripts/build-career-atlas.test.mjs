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
      "…It was a surprising and swift ascent for the mild-mannered career politician who was previously part of a crop of lower-polling Democratic candidates that party chair Rusty Hicks was publicly pressuring to drop out of the race.",
      "https://calmatters.org/politics/2026/06/california-primary-governor-becerra/"
    ]
  ]);
});

test("canonical records preserve the approved public roles and coverage", () => {
  const roles = Object.fromEntries(data.records.map(({ id, role }) => [id, role]));
  assert.deepEqual(roles, {
    "2018-wv-manchin": "Tracker and Research Analyst",
    "2020-dscc-senate-portfolio": "Research Associate",
    "2022-dccc-rocky-mountains": "Regional Research Director",
    "2023-ms-presley": "Research and Policy Director",
    "2024-az-gallego": "Research Director",
    "2026-ca-becerra": "Strategic Messaging Consultant"
  });
  assert.match(data.records.find(({ id }) => id === "2022-dccc-rocky-mountains").summary, /twelve competitive/);
  assert.equal(data.records.find(({ id }) => id === "2026-ca-becerra").summary, "Strategic messaging consulting for Xavier Becerra’s 2026 campaign for governor.");
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
  assert.match(html, /data-career-states="NV AZ KS MT NE OR WA"/);
  assert.match(html, /<h3>Strategic Messaging Consultant · Xavier Becerra for Governor<\/h3>/);
  assert.match(html, /<blockquote>[\s\S]*<cite><a href="https:\/\/calmatters\.org/);
  assert.match(html, /AZ-01 · AZ-06 · KS-03 · MT-02 · NE-02 · NV-01 · NV-03 · NV-04 · OR-04 · OR-05 · OR-06 · WA-08/);
  assert.match(markdown, /^### 2026 — Strategic Messaging Consultant · Xavier Becerra for Governor/m);
  assert.match(markdown, /^### 2020 — Research Associate · DSCC/m);
  assert.doesNotMatch(html, /record-summary|receipt-label|Additional coverage/);
  assert.doesNotMatch(markdown, /^Receipt$|^Cycle Receipt$|Additional coverage/gm);
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

test("active states derive deterministically from structured assignments", () => {
  const dscc = data.records.find(({ id }) => id === "2020-dscc-senate-portfolio");
  const dccc = data.records.find(({ id }) => id === "2022-dccc-rocky-mountains");
  assert.deepEqual(deriveRecordStates(dscc, data.records), ["GA", "IA", "KS", "MI", "NH"]);
  assert.deepEqual(deriveRecordStates(dccc, data.records), ["NV", "AZ", "KS", "MT", "NE", "OR", "WA"]);
});

test("validation rejects result claims on coverage records", () => {
  const invalid = structuredClone(data);
  const coverage = invalid.records.find((record) => record.id === "2022-dccc-rocky-mountains");
  coverage.scopeType = "off-year-coverage";
  coverage.outcome = "Won";
  coverage.resultType = "win";
  coverage.receiptId = null;
  assert.deepEqual(validateCareerAtlas(invalid).filter((error) => error.includes("coverage must")), [
    "2022-dccc-rocky-mountains coverage must use resultType no-claim",
    "2022-dccc-rocky-mountains coverage must not make an outcome claim"
  ]);
});

test("validation enforces the DCCC twelve-district roster", () => {
  const invalid = structuredClone(data);
  invalid.records.find((record) => record.id === "2022-dccc-rocky-mountains").roster.pop();
  assert.ok(validateCareerAtlas(invalid).some((error) => error.includes("canonical twelve districts")));
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
