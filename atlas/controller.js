const STORAGE_KEY = "career-atlas-reduce-effects";
const COVERAGE_TYPES = new Set(["regional-coverage", "off-year-coverage"]);

function stateCode(assignment = "") {
  return String(assignment).match(/^([A-Z]{2})(?:-\d{2})?$/)?.[1] ?? null;
}

function recordMatchesState(record, code) {
  return record.state === code || record.roster?.some((assignment) => stateCode(assignment) === code);
}

function emit(root, type, detail) {
  root.dispatchEvent(new CustomEvent(`career-atlas:${type}`, { bubbles: true, detail }));
}

function node(document, tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function appendLabeledText(document, parent, label, text, className = "case-line") {
  const line = node(document, "p", className);
  line.append(node(document, "strong", "", label), document.createTextNode(text));
  parent.append(line);
}

function normalizeData(input) {
  if (Array.isArray(input)) return { records: input, receipts: [], years: ["Overview", ...new Set(input.map(({ year }) => year))] };
  if (input && Array.isArray(input.records)) return input;
  throw new TypeError("CareerAtlas.mount requires canonical career records");
}

function reducedValue(value) {
  return typeof value === "boolean" ? value : Boolean(value?.matches);
}

function storageRead() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function storageWrite(value) {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Storage is an enhancement. Private browsing and policy blocks are harmless.
  }
}

function parseHash(hash, years, activeByYear) {
  const match = String(hash).match(/^#career-(overview|\d{4})(?:-([a-z]{2}))?$/i);
  if (!match) return { year: "Overview", selectedState: null };
  const year = match[1].toLowerCase() === "overview" ? "Overview" : match[1];
  const selectedState = match[2]?.toUpperCase() ?? null;
  if (!years.includes(year)) return { year: "Overview", selectedState: null };
  if (selectedState && !activeByYear(year).has(selectedState)) return { year: "Overview", selectedState: null };
  return { year, selectedState };
}

function hashFor(year, selectedState) {
  const cycle = year === "Overview" ? "overview" : year;
  return `#career-${cycle}${selectedState ? `-${selectedState.toLowerCase()}` : ""}`;
}

function injectPatterns(svg) {
  const document = svg.ownerDocument;
  const namespace = "http://www.w3.org/2000/svg";
  const defs = document.createElementNS(namespace, "defs");
  for (const [id, groundYear, stripeYear] of [
    ["atlas-years-2020-2022", "2020", "2022"],
    ["atlas-years-2022-2024", "2022", "2024"],
  ]) {
    const pattern = document.createElementNS(namespace, "pattern");
    pattern.setAttribute("id", id);
    pattern.setAttribute("width", "12");
    pattern.setAttribute("height", "12");
    pattern.setAttribute("patternUnits", "userSpaceOnUse");
    pattern.setAttribute("patternTransform", "rotate(35)");
    const ground = document.createElementNS(namespace, "rect");
    ground.setAttribute("width", "12");
    ground.setAttribute("height", "12");
    ground.setAttribute("class", `atlas-pattern-year-${groundYear}`);
    const stripe = document.createElementNS(namespace, "rect");
    stripe.setAttribute("width", "5");
    stripe.setAttribute("height", "12");
    stripe.setAttribute("class", `atlas-pattern-year-${stripeYear}`);
    pattern.append(ground, stripe);
    defs.append(pattern);
  }
  svg.append(defs);
  return defs;
}

export const CareerAtlas = Object.freeze({
  mount(root, options = {}) {
    if (!root?.querySelector) throw new TypeError("CareerAtlas.mount requires a root element");
    const data = normalizeData(options.records);
    const geometry = options.geometry;
    if (!geometry?.states?.length) throw new TypeError("CareerAtlas.mount requires map geometry");

    const document = root.ownerDocument;
    const window = document.defaultView;
    const svg = root.querySelector("[data-atlas-svg]");
    const canvas = root.querySelector("[data-atlas-webgl]");
    const stage = root.querySelector("[data-atlas-map-stage]");
    const stateList = root.querySelector("[data-atlas-state-list]");
    const count = root.querySelector("[data-atlas-count]");
    const caseFile = root.querySelector("[data-atlas-case]");
    const caseContent = root.querySelector("[data-atlas-case-content]");
    const closeButton = root.querySelector("[data-atlas-close]");
    const effectsControl = root.querySelector("[data-atlas-effects]");
    const rendererStatus = root.querySelector(".atlas-renderer-status");
    const anchor = root.querySelector("[data-atlas-anchor]");
    const ledger = root.querySelector(".atlas-ledger");
    const yearInputs = [...root.querySelectorAll('input[name="career-year"]')];
    if (![svg, canvas, stage, stateList, caseFile, caseContent, effectsControl, anchor].every(Boolean)) {
      throw new Error("Career atlas interface is incomplete");
    }

    const receipts = new Map((data.receipts ?? []).map((receipt) => [receipt.id, receipt]));
    const stateNames = new Map(geometry.states.map((state) => [state.code, state.name]));
    const stateGeometry = new Map(geometry.states.map((state) => [state.code, state]));
    const years = data.years ?? ["Overview", ...new Set(data.records.map(({ year }) => year))];
    const cleanup = [];
    let renderer = null;
    let rendererMode = "svg";
    let lastInvoker = null;
    let focusRestoreRequested = false;
    let destroyed = false;
    let reduceEffects = reducedValue(options.reducedMotion) || storageRead();
    const printMedia = window.matchMedia?.("print") ?? null;
    let ledgerOpenBeforePrint = null;

    const matchingRecords = (year, code) => data.records.filter((record) =>
      (year === "Overview" || record.year === year) && recordMatchesState(record, code)
    );
    const activeByYear = (year) => new Set(geometry.states
      .filter(({ code }) => matchingRecords(year, code).length)
      .map(({ code }) => code));
    const initial = parseHash(window.location.hash, years, activeByYear);
    let currentYear = initial.year;
    let selectedState = initial.selectedState;

    function reportError(error) {
      const detail = { error: error instanceof Error ? error : new Error(String(error)) };
      rendererMode = "svg";
      root.dataset.renderer = rendererMode;
      rendererStatus.textContent = "Renderer: SVG fallback";
      emit(root, "rendererchange", { mode: rendererMode, reducedEffects: reduceEffects });
      emit(root, "error", detail);
    }

    function initializeRenderer() {
      renderer?.destroy?.();
      const source = options.renderer;
      renderer = typeof source === "function"
        ? source({ reducedMotion: reduceEffects, onError: reportError })
        : source;
      if (!renderer?.init) throw new TypeError("CareerAtlas.mount requires a renderer instance or factory");
      rendererMode = renderer.init({ svg, canvas }, geometry, {
        dprCap: reduceEffects ? 1 : 1.5,
        onError: reportError,
      });
      root.dataset.renderer = rendererMode;
      rendererStatus.textContent = `Renderer: ${rendererMode === "webgl2" ? "WebGL2 + SVG" : "SVG"}`;
      emit(root, "rendererchange", { mode: rendererMode, reducedEffects: reduceEffects });
    }

    function presentation() {
      const active = new Map();
      for (const { code } of geometry.states) {
        const records = matchingRecords(currentYear, code);
        if (!records.length) continue;
        const recordYears = [...new Set(records.map(({ year }) => year))].sort((a, b) => Number(a) - Number(b));
        const coverageOnly = records.every((record) => COVERAGE_TYPES.has(record.scopeType));
        active.set(code, {
          year: recordYears.join("-"),
          years: recordYears,
          scope: currentYear === "Overview" && recordYears.length > 1
            ? "multi-year"
            : coverageOnly ? "coverage" : "assignment",
        });
      }
      return active;
    }

    function positionAnchor() {
      const selected = stateGeometry.get(selectedState);
      if (!selected) {
        anchor.hidden = true;
        return;
      }
      const rect = stage.getBoundingClientRect();
      const [viewX, viewY, viewWidth, viewHeight] = geometry.viewBox;
      const scale = Math.min(rect.width / viewWidth, rect.height / viewHeight);
      const left = (rect.width - viewWidth * scale) / 2 + (selected.centroid[0] - viewX) * scale;
      const top = (rect.height - viewHeight * scale) / 2 + (selected.centroid[1] - viewY) * scale;
      anchor.style.left = `${left}px`;
      anchor.style.top = `${top}px`;
      anchor.hidden = false;
    }

    function resize() {
      const rect = stage.getBoundingClientRect();
      renderer.resize(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, reduceEffects ? 1 : 1.5));
      positionAnchor();
    }

    function stateEvidence(record, code) {
      if (COVERAGE_TYPES.has(record.scopeType)) {
        return `${stateNames.get(code)} was a coverage assignment only. No electoral result claim is made.`;
      }
      if (record.id === "2020-dscc-senate-portfolio") {
        return record.outcome?.stateClaims?.[code]
          ?? `${stateNames.get(code)} was within the five-state assignment scope. No state result claim is made.`;
      }
      if (record.id === "2022-dccc-rocky-mountains") {
        const assignments = record.roster.filter((assignment) => stateCode(assignment) === code);
        const wins = record.outcome.wins.filter((assignment) => stateCode(assignment) === code);
        const losses = record.outcome.losses.filter((assignment) => stateCode(assignment) === code);
        return `${assignments.length} ${assignments.length === 1 ? "assignment" : "assignments"}: ${assignments.join(", ")}. ${wins.length} ${wins.length === 1 ? "win" : "wins"}, ${losses.length} ${losses.length === 1 ? "loss" : "losses"}.`;
      }
      return typeof record.outcome === "string" ? record.outcome : record.evidenceNote;
    }

    function receiptFor(record) {
      const direct = receipts.get(record.receiptId);
      if (direct) return { receipt: direct, contextual: false };
      if (record.year === "2022" && COVERAGE_TYPES.has(record.scopeType)) {
        const cycle = data.records.find((candidate) => candidate.id === "2022-dccc-rocky-mountains");
        return { receipt: receipts.get(cycle?.receiptId), contextual: true };
      }
      return { receipt: null, contextual: false };
    }

    function caseRecord(record, code) {
      const article = node(document, "article", "case-record");
      const heading = node(document, "h4", "case-record-title", `${record.organization} / ${record.role}`);
      const meta = node(document, "p", "case-record-meta", `${record.year} · ${record.campaign}`);
      article.append(heading, meta);
      appendLabeledText(document, article, "Scope: ", record.summary);
      appendLabeledText(document, article, "State evidence: ", stateEvidence(record, code), "case-line case-evidence");
      if (record.roster?.length && record.id !== "2022-dccc-rocky-mountains") {
        const stateRoster = record.roster.filter((assignment) => stateCode(assignment) === code);
        if (stateRoster.length) appendLabeledText(document, article, "Assignments: ", stateRoster.join(", "));
      }
      const { receipt, contextual } = receiptFor(record);
      const dsccContext = record.id === "2020-dscc-senate-portfolio" && code !== "GA";
      if (receipt) {
        const proof = node(document, "blockquote", "case-receipt");
        const label = receipt.kind === "cycle-receipt" ? "Cycle Receipt" : "Receipt";
        const contextLabel = dsccContext
          ? `${label} · Georgia context, not a result in ${stateNames.get(code)}`
          : contextual ? `${label} · cycle context, not a state result` : label;
        proof.append(node(document, "span", "receipt-label", contextLabel));
        proof.append(node(document, "p", "", receipt.quote));
        const cite = node(document, "cite");
        const link = node(document, "a", "", receipt.attribution);
        link.href = receipt.url;
        cite.append(link);
        proof.append(cite);
        article.append(proof);
      }
      return article;
    }

    function renderCase(code) {
      caseContent.replaceChildren();
      const name = stateNames.get(code);
      const header = node(document, "header", "case-header");
      header.append(node(document, "p", "case-kicker", "Case file"), node(document, "h3", "", `${name} / ${currentYear}`));
      caseContent.append(header);
      for (const record of matchingRecords(currentYear, code)) caseContent.append(caseRecord(record, code));
    }

    function restoreInvoker() {
      if (lastInvoker?.isConnected) lastInvoker.focus({ preventScroll: true });
    }

    function dismissCase({ restoreFocus = false } = {}) {
      if (typeof caseFile.hidePopover === "function" && caseFile.matches(":popover-open")) {
        focusRestoreRequested = restoreFocus;
        caseFile.hidePopover();
      } else if (caseFile.classList.contains("is-open")) {
        caseFile.classList.remove("is-open");
        if (restoreFocus) restoreInvoker();
      }
    }

    function showCase() {
      if (typeof caseFile.showPopover === "function") {
        if (!caseFile.matches(":popover-open")) caseFile.showPopover();
      } else {
        caseFile.classList.add("is-open");
      }
    }

    function updateUrl() {
      window.history.replaceState(window.history.state, "", hashFor(currentYear, selectedState));
    }

    function renderStateList(activeStates) {
      const active = [...activeStates.keys()].sort((a, b) => stateNames.get(a).localeCompare(stateNames.get(b)));
      stateList.replaceChildren();
      count.textContent = `${active.length} ${active.length === 1 ? "state" : "states"}`;
      for (const code of active) {
        const years = activeStates.get(code).years.join(" + ");
        const button = node(document, "button", "atlas-state-button");
        button.type = "button";
        button.dataset.state = code;
        button.setAttribute("aria-pressed", String(code === selectedState));
        button.append(
          node(document, "span", "atlas-state-code", code),
          node(document, "span", "atlas-state-name", stateNames.get(code)),
          node(document, "span", "atlas-state-years", years),
        );
        stateList.append(button);
      }
      lastInvoker = selectedState ? stateList.querySelector(`[data-state="${selectedState}"]`) : null;
    }

    function updateStateSelection() {
      for (const button of stateList.querySelectorAll("button[data-state]")) {
        button.setAttribute("aria-pressed", String(button.dataset.state === selectedState));
      }
    }

    function render({ transition = false, rebuildStateList = false } = {}) {
      const activeStates = presentation();
      const work = () => {
        root.dataset.year = currentYear;
        for (const input of yearInputs) input.checked = input.value === currentYear;
        if (rebuildStateList) renderStateList(activeStates);
        else updateStateSelection();
        renderer.render({
          activeStates,
          selectedState,
          transition: { year: currentYear, resolve: reduceEffects ? 1 : transition ? 0 : 1 },
        });
        positionAnchor();
      };
      if (transition && !reduceEffects && typeof document.startViewTransition === "function") document.startViewTransition(work);
      else work();
    }

    function selectState(code, invoker = null, { passive = false } = {}) {
      const normalized = String(code || "").toUpperCase();
      if (!activeByYear(currentYear).has(normalized)) return false;
      selectedState = normalized;
      lastInvoker = invoker ?? stateList.querySelector(`[data-state="${normalized}"]`) ?? lastInvoker;
      render({ transition: !passive });
      renderCase(normalized);
      showCase();
      if (!passive) updateUrl();
      emit(root, "statechange", { year: currentYear, state: selectedState, passive });
      return true;
    }

    function setYear(year, { passive = false } = {}) {
      const normalized = String(year);
      if (!years.includes(normalized)) return false;
      const yearChanged = normalized !== currentYear;
      currentYear = normalized;
      if (selectedState && !activeByYear(currentYear).has(selectedState)) {
        selectedState = null;
        dismissCase({ restoreFocus: false });
      } else if (selectedState) {
        renderCase(selectedState);
      }
      render({ transition: !passive, rebuildStateList: yearChanged });
      if (!passive) updateUrl();
      emit(root, "yearchange", { year: currentYear, state: selectedState, passive });
      return true;
    }

    function onYearChange(event) {
      if (event.target.matches('input[name="career-year"]')) setYear(event.target.value);
    }

    function onStateClick(event) {
      const button = event.target.closest("button[data-state]");
      if (button && stateList.contains(button)) selectState(button.dataset.state, button);
    }

    function onMapClick(event) {
      const path = event.target.closest("path[data-state]");
      if (!path || !svg.contains(path) || !presentation().has(path.dataset.state)) return;
      const invoker = stateList.querySelector(`[data-state="${path.dataset.state}"]`);
      selectState(path.dataset.state, invoker);
    }

    function onEffectsChange() {
      const requested = effectsControl.checked;
      reduceEffects = requested || reducedValue(options.reducedMotion);
      storageWrite(requested);
      effectsControl.checked = reduceEffects;
      root.classList.toggle("atlas-reduced-effects", reduceEffects);
      try {
        initializeRenderer();
        resize();
        render();
      } catch (error) {
        reportError(error);
      }
    }

    function onHashChange() {
      const next = parseHash(window.location.hash, years, activeByYear);
      selectedState = null;
      dismissCase({ restoreFocus: false });
      setYear(next.year, { passive: true });
      if (next.selectedState) selectState(next.selectedState, null, { passive: true });
    }

    function onClose() {
      dismissCase({ restoreFocus: true });
    }

    function onCaseKeydown(event) {
      const open = typeof caseFile.showPopover === "function"
        ? caseFile.matches(":popover-open")
        : caseFile.classList.contains("is-open");
      if (event.key !== "Escape" || !open) return;
      event.preventDefault();
      dismissCase({ restoreFocus: true });
    }

    function enterPrintMode() {
      if (!ledger) return;
      if (ledgerOpenBeforePrint === null) ledgerOpenBeforePrint = ledger.open;
      ledger.open = true;
    }

    function exitPrintMode() {
      if (!ledger || ledgerOpenBeforePrint === null) return;
      ledger.open = ledgerOpenBeforePrint;
      ledgerOpenBeforePrint = null;
    }

    function onPrintMediaChange(event) {
      if (event.matches) enterPrintMode();
      else exitPrintMode();
    }

    const patternDefinitions = injectPatterns(svg);
    effectsControl.checked = reduceEffects;
    root.classList.toggle("atlas-reduced-effects", reduceEffects);
    initializeRenderer();

    const resizeObserver = "ResizeObserver" in window ? new window.ResizeObserver(resize) : null;
    resizeObserver?.observe(stage);
    if (!resizeObserver) {
      window.addEventListener("resize", resize, { passive: true });
      cleanup.push(() => window.removeEventListener("resize", resize));
    }
    root.addEventListener("change", onYearChange);
    stateList.addEventListener("click", onStateClick);
    svg.addEventListener("click", onMapClick);
    effectsControl.addEventListener("change", onEffectsChange);
    closeButton?.addEventListener("click", onClose);
    document.addEventListener("keydown", onCaseKeydown);
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("beforeprint", enterPrintMode);
    window.addEventListener("afterprint", exitPrintMode);
    printMedia?.addEventListener?.("change", onPrintMediaChange);
    cleanup.push(
      () => root.removeEventListener("change", onYearChange),
      () => stateList.removeEventListener("click", onStateClick),
      () => svg.removeEventListener("click", onMapClick),
      () => effectsControl.removeEventListener("change", onEffectsChange),
      () => closeButton?.removeEventListener("click", onClose),
      () => document.removeEventListener("keydown", onCaseKeydown),
      () => window.removeEventListener("hashchange", onHashChange),
      () => window.removeEventListener("beforeprint", enterPrintMode),
      () => window.removeEventListener("afterprint", exitPrintMode),
      () => printMedia?.removeEventListener?.("change", onPrintMediaChange),
      () => resizeObserver?.disconnect(),
      () => patternDefinitions.remove(),
    );

    if (options.reducedMotion?.addEventListener) {
      const onMotionChange = () => {
        reduceEffects = reducedValue(options.reducedMotion) || storageRead();
        effectsControl.checked = reduceEffects;
        root.classList.toggle("atlas-reduced-effects", reduceEffects);
        try {
          initializeRenderer();
          resize();
          render();
        } catch (error) {
          reportError(error);
        }
      };
      options.reducedMotion.addEventListener("change", onMotionChange);
      cleanup.push(() => options.reducedMotion.removeEventListener("change", onMotionChange));
    }

    if (typeof caseFile.showPopover === "function") {
      const onToggle = (event) => {
        if (event.newState !== "closed") return;
        if (focusRestoreRequested) restoreInvoker();
        focusRestoreRequested = false;
      };
      caseFile.addEventListener("toggle", onToggle);
      cleanup.push(() => caseFile.removeEventListener("toggle", onToggle));
    } else {
      const onOutside = (event) => {
        if (caseFile.classList.contains("is-open") && !caseFile.contains(event.target) && !event.target.closest("[data-state]")) dismissCase();
      };
      document.addEventListener("pointerdown", onOutside);
      cleanup.push(
        () => document.removeEventListener("pointerdown", onOutside),
      );
    }

    render({ rebuildStateList: true });
    resize();
    if (selectedState) selectState(selectedState, null, { passive: true });
    root.dataset.mounted = "true";
    if (ledger) ledger.open = false;
    if (printMedia?.matches) enterPrintMode();

    return Object.freeze({
      setYear,
      selectState,
      getState() {
        return Object.freeze({ year: currentYear, selectedState, rendererMode, reducedEffects: reduceEffects });
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        dismissCase({ restoreFocus: false });
        for (const dispose of cleanup.splice(0)) dispose();
        renderer?.destroy?.();
        root.removeAttribute("data-mounted");
        root.removeAttribute("data-renderer");
        ledgerOpenBeforePrint = null;
        if (ledger) ledger.open = true;
      },
    });
  },
});

export default CareerAtlas;
