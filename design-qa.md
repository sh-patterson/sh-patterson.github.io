# Design QA

## Comparison target

- Source visual truth: Codex thread 019f6cb9-d423-77e1-87dc-471efc62b5bd, image generation exec-a1b74dfb-8e1f-496b-bfe4-b55aac345503.
- Implementation: /mnt/c/Users/shawn/.codex/visualizations/2026/07/16/019f6cb9-d423-77e1-87dc-471efc62b5bd/qa-artifacts/39-source-match-hero.png.
- Viewport and state: 1600 × 1003, desktop, Overview, default motion and color settings.
- Exact-viewport evidence: the source and implementation were opened together in one comparison input on 2026-07-17.

## Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: The implementation preserves the source's editorial serif/sans/mono hierarchy, compact navigation, readable body measure, and strong name/map-title scale. The mixed-case name is an intentional humanizing deviation from the mockup's all-caps treatment; hierarchy and wrapping remain equivalent.
- Spacing and layout rhythm: The introductory block and campaign atlas now share the source's compact above-the-fold rhythm. The persistent state index makes the map footprint modestly smaller than the mockup, but it is an intentional keyboard-accessible alternate navigation surface and does not obscure the map or move it below the fold.
- Colors and tokens: Warm paper, black ink, thin rules, and muted chronological year colors match the selected direction. The palette avoids red/blue partisan semantics. Multi-year states use the exact years as stripes.
- Image and asset fidelity: The primary visual is a crisp Census-derived 50-state SVG map with a pinned geometry provenance record. It remains sharp at desktop, tablet, mobile, print, and forced-colors sizes. No source illustration, logo, or photographic asset was replaced with a placeholder.
- Copy and content: The implementation uses Shawn-specific campaign roles, districts, outcomes, source receipts, tools, writing, and contact language. Generic concept slogans and case-file language were removed.
- Interaction and accessibility: Hover previews are restrained; clicks pin the full quote-bearing record. Year filters, state controls, URL hashes, Escape, focus restoration, Tab order, reduced motion, forced colors, print, and no-JavaScript fallbacks were exercised. Browser console/runtime errors and horizontal overflow are checked by the QA harness.

## Focused comparison evidence

- Compact hover treatment: /mnt/c/Users/shawn/.codex/visualizations/2026/07/16/019f6cb9-d423-77e1-87dc-471efc62b5bd/qa-artifacts/40-desktop-hover-2022-or.png.
- Pinned desktop record with quote: /mnt/c/Users/shawn/.codex/visualizations/2026/07/16/019f6cb9-d423-77e1-87dc-471efc62b5bd/qa-artifacts/20-desktop-case-2022-or.png.
- Mobile Overview: /mnt/c/Users/shawn/.codex/visualizations/2026/07/16/019f6cb9-d423-77e1-87dc-471efc62b5bd/qa-artifacts/29-mobile-overview.png.
- Mobile pinned record: /mnt/c/Users/shawn/.codex/visualizations/2026/07/16/019f6cb9-d423-77e1-87dc-471efc62b5bd/qa-artifacts/31-mobile-case-2022-or.png.
- Forced colors: /mnt/c/Users/shawn/.codex/visualizations/2026/07/16/019f6cb9-d423-77e1-87dc-471efc62b5bd/qa-artifacts/36-forced-colors-overview.png.
- Full visual manifest: /mnt/c/Users/shawn/.codex/visualizations/2026/07/16/019f6cb9-d423-77e1-87dc-471efc62b5bd/qa-artifacts/manifest.json (40 captures).

## Comparison history

### Pass 1

- P1: The initial hero occupied most of the viewport and pushed the map below the fold.
- P2: The circular initials mark, oversized uppercase name, duplicate legend treatment, and three-line mobile name drifted from the selected editorial mockup.
- Fix: Rebuilt the hero as a compact paper-and-ink masthead, restored the full-name mark, aligned the atlas title and year rail, removed duplicate visual legend weight, and corrected mobile scaling.
- Post-fix evidence: 01-desktop-hero.png, 29-mobile-overview.png, and the first source-to-browser comparison.

### Pass 2

- P2: The hover state contained the full narrative and receipt, reading like a case file rather than a news-graphics tooltip.
- P2: Closing a mobile record could immediately reopen it when focus returned to its invoker.
- P2: The forced-colors test still queried a retired legend implementation and then required a background fill even when the browser supplied a strong system outline.
- Fix: Split hover preview from pinned detail, suppressed preview during focus restoration, and asserted the actual active/context map and outline contrast.
- Post-fix evidence: 40-desktop-hover-2022-or.png, 31-mobile-case-2022-or.png, and 36-forced-colors-overview.png.

### Pass 3

- P1: The public text mirror, search metadata, structured data, and social card still carried superseded AI-first copy.
- P2: States outside the selected year retained a pointer affordance although the controller correctly rejected their interaction.
- P2: A hidden WebGL renderer was still initialized and animated behind the editorial SVG map.
- Fix: Migrated the public copy surfaces and social card, removed dead pointer events from filtered states, forced the production atlas to SVG, and added regression checks for both behaviors.
- Post-fix evidence: the updated 39-source-match-hero.png and 40-desktop-hover-2022-or.png, plus passing filtered-state and zero-WebGL-allocation browser assertions.

### Final pass

- Re-captured the implementation at the source's exact 1600 × 1003 viewport.
- Compared both artifacts together. No actionable P0, P1, or P2 differences remain.
- The complete visual matrix passed with 40 captures.

## Verification

- npm test components through smoke:atlas: passed. The combined shell reached the command runner's time limit as it entered the final benchmark; npm run bench:canvas then passed separately.
- npm run visual:atlas: passed.
- Unit tests: 16 passed.
- Link and asset check: 97 passed; guarded third-party 403/999 responses were handled as expected.
- Browser states: desktop, tablet, 390 px mobile, 320 px mobile, every campaign year, every state record, hover, click, keyboard, reduced motion, forced colors, print, no JavaScript, SVG-only rendering, and a no-WebGL-allocation guard.
- Console/runtime errors: checked and clear for expected production paths.

## Follow-up polish

- P3: If a later iteration prioritizes pure map scale over persistent alternate navigation, the desktop state index could move below the map. The current side index is retained for scanability and keyboard access.

final result: passed
