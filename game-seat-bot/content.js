(() => {
  if (location.hostname !== "orion.iku.edu.tr" || location.port !== "8443") return;

  let job = null;
  let scanTimer = null;
  let deadlineTimer = null;
  let attempting = false;
  let attemptFinishedThisLoad = false;
  let checkedThisLoad = false;
  let startedAt = Date.now();
  let courseClickAt = 0;
  let observer = null;
  let testAttempting = false;

  const normalize = (text) => (text || "").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
  const sameTime = (text, time) => normalize(text).includes(time);
  const modeFor = (config) => config.selectionMode || "labTheory";
  const matchesTime = (text, time) => !time || sameTime(text, time);
  const belongsToCourse = (section, config) => section.startsWith(`${config.courseCode}-`) &&
    /^[A-Z0-9]+$/.test(section.slice(config.courseCode.length + 1));
  const hasSeat = (entry) => {
    if (!entry?.green) return false;
    const match = entry.availability.match(/^(\d+)(?:\s*Yer)?$/iu);
    return !!match && Number(match[1]) > 0;
  };

  function rows(config = job) {
    let group = "";
    return [...document.querySelectorAll("#lineItemList-tblBody > tr")].flatMap((row) => {
      const heading = row.querySelector(".sapMGHLITitle");
      if (heading) { group = normalize(heading.textContent); return []; }
      const section = [...row.querySelectorAll("a.sapMLnk")].map((a) => normalize(a.textContent)).find((s) => belongsToCourse(s, config));
      const number = row.querySelector(".sapMObjectNumber");
      return [{
        row,
        group,
        section,
        time: normalize(row.textContent),
        availability: normalize(number?.querySelector(".sapMObjectNumberText")?.textContent),
        green: !!number?.classList.contains("sapMObjectNumberStatusSuccess"),
        radio: row.querySelector('[role="radio"]')
      }];
    });
  }

  function courseIsSelected(config = job) {
    const title = normalize(document.querySelector("li.sapMLIBSelected .sapMObjLTitle")?.textContent);
    return titleMatches(title, config);
  }

  function titleMatches(title, config = job) {
    const match = title.match(/^(.+?)\s+-\s+(.+)$/);
    return !!match && match[1] === config.courseCode && match[2].toLocaleLowerCase("tr-TR") === normalize(config.courseName).toLocaleLowerCase("tr-TR");
  }

  function chooseCourse(config = job) {
    const matches = [...document.querySelectorAll("li.sapMObjLItem")].filter((li) =>
      titleMatches(normalize(li.querySelector(".sapMObjLTitle")?.textContent), config));
    if (matches.length !== 1) return false;
    matches[0].click();
    return true;
  }

  async function send(type, extra = {}) {
    try { return await chrome.runtime.sendMessage({ type, token: job.token, ...extra }); }
    catch { return { ok: false }; }
  }

  function report(message) {
    if (checkedThisLoad) return;
    checkedThisLoad = true;
    send("CHECKED", { message });
  }

  function responseInText(text, config = job) {
    text = normalize(text);
    if (text.toLocaleLowerCase("tr-TR").includes(`${config.courseName} kayıt sepetine eklendi`.toLocaleLowerCase("tr-TR"))) return "success";
    if (/dersinin şubesi için kapasite doldu|kapasite doldu, seçim yapamazsınız/i.test(text)) return "full";
    return null;
  }

  function visibleResponse(config = job) {
    // SAP renders transient messages under #sap-ui-static. That container has
    // zero dimensions, so its messages are absent from document.body.innerText.
    return responseInText(document.querySelector("#sap-ui-static")?.textContent, config) ||
      responseInText(document.body?.innerText, config);
  }

  function pressBasketButton(button) {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random()}`;
      const timer = setTimeout(() => finish({ ok: false, error: "SAP did not acknowledge the basket press" }), 2000);
      function onMessage(event) {
        if (event.source !== window || event.origin !== location.origin ||
            event.data?.type !== "iku-seat-bot:press-result" || event.data.requestId !== requestId) return;
        finish({ ok: !!event.data.ok, error: event.data.error });
      }
      function finish(result) {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(result);
      }
      window.addEventListener("message", onMessage);
      window.postMessage({ type: "iku-seat-bot:press-basket", id: button.id, requestId }, location.origin);
    });
  }

  function matchingTarget(config, section = config.sectionCode) {
    const all = rows(config);
    const mode = modeFor(config);
    const primaryGroup = mode === "labTheory" ? "Laboratuvar" : mode === "theoryOnly" ? "Teori" : null;
    const primaryTime = mode === "labTheory" ? config.labTime : config.theoryTime;
    const primary = all.filter((r) => r.radio && r.section && (!section || r.section === section) &&
      (!primaryGroup || r.group === primaryGroup) && matchesTime(r.time, primaryTime));
    if (primary.length !== 1) return null;
    if (mode !== "labTheory") return { primary: primary[0], secondary: null };
    const theory = all.filter((r) => r.group === "Teori" && r.section === primary[0].section && matchesTime(r.time, config.theoryTime));
    return theory.length === 1 ? { primary: primary[0], secondary: theory[0] } : null;
  }

  async function selectTarget(config, section) {
    const selected = (kind) => matchingTarget(config, section)?.[kind]?.radio?.getAttribute("aria-checked") === "true";
    async function select(kind) {
      if (selected(kind)) return true;
      // Orion's SAP radio has a clickable wrapper and inner control. Its rows can
      // be replaced after a click, so always find the current element again.
      for (const selector of [null, ".sapMRbB", "input[type=radio]"]) {
        const radio = matchingTarget(config, section)?.[kind]?.radio;
        const target = selector ? radio?.querySelector(selector) : radio;
        if (!target) continue;
        target.click();
        if (await waitFor(() => selected(kind), 1000)) return true;
      }
      const radio = matchingTarget(config, section)?.[kind]?.radio;
      if (radio?.id) {
        window.postMessage({ type: "iku-seat-bot:select-radio", id: radio.id }, location.origin);
        if (await waitFor(() => selected(kind), 1000)) return true;
      }
      return false;
    }
    if (!await select("primary")) return { ok: false, primarySelected: false, secondarySelected: !!selected("secondary") };
    if (!matchingTarget(config, section)?.secondary) return { ok: selected("primary"), primarySelected: selected("primary"), secondarySelected: null };
    // Lab selection usually selects theory automatically. Use its exact row if needed.
    if (!await waitFor(() => selected("secondary"), 1000)) await select("secondary");
    return { ok: selected("primary") && selected("secondary"), primarySelected: selected("primary"), secondarySelected: selected("secondary") };
  }

  function selectionFailure(result, config) {
    const state = modeFor(config) === "labTheory"
      ? `Lab: ${result.primarySelected ? "selected" : "not selected"}; theory: ${result.secondarySelected ? "selected" : "not selected"}.`
      : `Section: ${result.primarySelected ? "selected" : "not selected"}.`;
    return `${state} Basket submission was skipped. Review the selected rows in Orion.`;
  }

  async function submit(primary) {
    attempting = true;
    const begun = await send("BEGIN_ATTEMPT");
    if (!begun?.ok) { attempting = false; return; }

    // Recheck after the service worker grants the single-attempt lock.
    const latest = matchingTarget(job, primary.section);
    if (!latest || !hasSeat(latest.primary) || !courseIsSelected()) {
      await send("RESULT", { outcome: "full" });
      attemptFinishedThisLoad = true;
      return;
    }

    const selection = await selectTarget(job, primary.section);
    if (!selection.ok) {
      await send("RESULT", { outcome: "uncertain", message: selectionFailure(selection, job) });
      return;
    }

    const buttons = [...document.querySelectorAll("button")].filter((button) => normalize(button.textContent) === "Kayıt sepetine ekle");
    if (buttons.length !== 1 || buttons[0].disabled) {
      await send("RESULT", { outcome: "uncertain", message: "The basket button was unavailable. Review the page before restarting." });
      return;
    }
    const latestJob = await chrome.runtime.sendMessage({ type: "GET_JOB" });
    if (latestJob?.job?.token !== job.token) return;
    const pressed = await pressBasketButton(buttons[0]);
    if (attemptFinishedThisLoad || !job?.active) return;
    if (!pressed.ok) {
      await send("RESULT", { outcome: "uncertain", message: `The basket action was not triggered: ${pressed.error}. Review the page before restarting.` });
      return;
    }
    const immediate = visibleResponse();
    if (immediate) {
      attempting = false;
      attemptFinishedThisLoad = true;
      await send("RESULT", { outcome: immediate });
      return;
    }
    deadlineTimer = setTimeout(() => {
      attempting = false;
      attemptFinishedThisLoad = true;
      send("RESULT", { outcome: "uncertain", message: "No clear response after submission. Check the basket before restarting." });
    }, 20000);
  }

  function scan() {
    if (!job?.active) return;
    if (attempting) {
      const response = visibleResponse();
      if (response) {
        clearTimeout(deadlineTimer);
        attempting = false;
        attemptFinishedThisLoad = true;
        send("RESULT", { outcome: response });
      }
      return;
    }
    if (attemptFinishedThisLoad) return;
    if (!courseIsSelected()) {
      if (Date.now() - startedAt > 12000) {
        attemptFinishedThisLoad = true;
        send("BLOCKED", { message: `Could not open ${job.courseCode}. Check the course list and restart.` });
      } else if (Date.now() - courseClickAt > 2000 && chooseCourse()) courseClickAt = Date.now();
      return;
    }
    const target = matchingTarget(job);
    if (!target) {
      if (Date.now() - startedAt > 12000) {
        attemptFinishedThisLoad = true;
        send("BLOCKED", { message: "The requested section could not be identified uniquely. Check its type, code, and optional times." });
      }
      return;
    }
    if (!hasSeat(target.primary)) {
      report("No seat in the requested section");
      return;
    }
    submit(target.primary).catch((error) => send("RESULT", { outcome: "uncertain", message: `Page interaction failed: ${error.message}` }));
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 100);
  }

  async function waitFor(predicate, timeoutMs = 10000, intervalMs = 100) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
  }

  async function waitForBasketResponse(config, button) {
    // A prior capacity toast can still be on screen. Let it clear so the next
    // identical toast is attributed to this click, rather than to the old one.
    if (visibleResponse(config) && !await waitFor(() => !visibleResponse(config), 5000, 50)) return "old-response";
    const pressed = await pressBasketButton(button);
    if (!pressed.ok) return "press-failed";
    return await waitFor(() => visibleResponse(config), 20000, 50) || "uncertain";
  }

  async function testRun(config) {
    if (testAttempting) return { ok: false, outcome: "uncertain", message: "A test run is already in progress." };
    testAttempting = true;
    try {
    if (!courseIsSelected(config)) {
      const found = await waitFor(() => chooseCourse(config), 8000);
      if (!found) return { ok: false, message: `Could not find ${config.courseCode} — ${config.courseName} in the course list.` };
      if (!await waitFor(() => courseIsSelected(config), 8000)) return { ok: false, message: "The course did not open." };
    }
    const matched = await waitFor(() => {
      return matchingTarget(config);
    }, 8000);
    if (!matched) return { ok: false, message: "The section type, code, and optional times did not identify one matching selection." };
    const selection = await selectTarget(config, matched.primary.section);
    if (!selection.ok) return { ok: false, outcome: "selection-failed", message: selectionFailure(selection, config) };
    const buttons = [...document.querySelectorAll("button")].filter((button) => normalize(button.textContent) === "Kayıt sepetine ekle");
    if (buttons.length !== 1 || buttons[0].disabled || !courseIsSelected(config)) {
      return { ok: false, outcome: "selection-failed", message: "The selected course or basket button changed. Basket submission was skipped." };
    }
    const outcome = await waitForBasketResponse(config, buttons[0]);
    if (outcome === "old-response") return { ok: false, outcome, message: "An earlier Orion result is still visible. No new basket attempt was made; retry after it disappears." };
    if (outcome === "press-failed") return { ok: false, outcome, message: "Orion did not acknowledge the SAP basket button action. No submission was confirmed." };
    if (outcome === "success") return { ok: true, outcome, message: `${config.courseName} was added to the registration basket. Check Orion for any final enrollment step.` };
    if (outcome === "full") return { ok: true, outcome, message: "The requested section was selected and the basket button was pressed. Orion says it is full, so nothing was added." };
    return { ok: false, outcome, message: "Orion's SAP basket press event ran, but no success or capacity message appeared. Check your basket before trying again." };
    } finally { testAttempting = false; }
  }

  async function initialize() {
    const response = await chrome.runtime.sendMessage({ type: "GET_JOB" });
    const nextJob = response?.job || null;
    if (nextJob?.token !== job?.token) {
      attempting = false;
      attemptFinishedThisLoad = false;
      checkedThisLoad = false;
      startedAt = Date.now();
    }
    job = nextJob;
    if (!job) return;
    if (!observer) {
      observer = new MutationObserver(scheduleScan);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-checked", "class"] });
    }
    scheduleScan();
    setTimeout(scheduleScan, 12500);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "SCAN") {
      startedAt = Date.now();
      checkedThisLoad = false;
      initialize().catch(console.error);
    }
    if (message.type === "TEST_RUN") {
      testRun(message.config).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
      return true;
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.jobs || !job) return;
    const current = Object.values(changes.jobs.newValue || {}).find((item) => item.token === job.token);
    if (!current?.active) {
      job = null;
      clearTimeout(scanTimer);
      clearTimeout(deadlineTimer);
      observer?.disconnect();
      observer = null;
    }
  });
  initialize().catch(console.error);
})();
