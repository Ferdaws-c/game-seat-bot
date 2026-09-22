const $ = (id) => document.getElementById(id);
const defaults = {
  courseCode: "SEN0416",
  courseName: "GAME PROGRAMMING",
  selectionMode: "labTheory",
  sectionCode: "SEN0416-1",
  labTime: "11:00-13:00",
  theoryTime: "09:00-11:00",
  intervalSeconds: 60
};

let savedCourses = [];
let loadedCourseId = null;
let currentJob = null;
let currentTabId = null;
const selectionKey = () => `selectedSavedCourseId:${currentTabId}`;

function labelFor(entry) {
  const c = entry.config;
  return `${c.courseCode} — ${c.courseName} · ${c.sectionCode || "any section"} · ${c.selectionMode === "single" ? "single" : c.selectionMode === "theoryOnly" ? "theory" : "lab + theory"}`;
}

function updateModeFields() {
  const mode = $("selectionMode").value;
  $("labTimeField").hidden = mode !== "labTheory";
  $("theoryTimeLabel").textContent = mode === "single" ? "Section time" : "Theory time";
}

function showTab(name) {
  const saved = name === "saved";
  $("coursePanel").hidden = saved;
  $("savedPanel").hidden = !saved;
  $("courseTab").setAttribute("aria-selected", String(!saved));
  $("savedTab").setAttribute("aria-selected", String(saved));
}

function setForm(config) {
  for (const key of Object.keys(defaults)) $(key).value = config?.[key] ?? defaults[key];
  updateModeFields();
}

function configFromForm() {
  let courseCode = $("courseCode").value.replace(/\s+/g, " ").trim().toUpperCase();
  let sectionCode = $("sectionCode").value.replace(/\s+/g, " ").trim().toUpperCase();
  const fullSection = courseCode.match(/^(.+)-([A-Z0-9]+)$/);
  if (fullSection && (!sectionCode || sectionCode === courseCode)) {
    sectionCode = courseCode;
    courseCode = fullSection[1];
  }
  const selectionMode = $("selectionMode").value || "labTheory";
  return {
    courseCode,
    courseName: $("courseName").value.replace(/\s+/g, " ").trim(),
    selectionMode,
    sectionCode,
    labTime: selectionMode === "labTheory" ? $("labTime").value.trim() : "",
    theoryTime: $("theoryTime").value.trim(),
    intervalSeconds: Number($("intervalSeconds").value)
  };
}

function validConfigFromForm() {
  if (!$("form").reportValidity()) throw new Error("Complete the course settings first.");
  const config = configFromForm();
  if (!/^[A-Z0-9* ]{3,32}$/.test(config.courseCode) || !config.courseName ||
      !["labTheory", "theoryOnly", "single"].includes(config.selectionMode) ||
      (config.sectionCode && (!config.sectionCode.startsWith(`${config.courseCode}-`) || !/^[A-Z0-9]+$/.test(config.sectionCode.slice(config.courseCode.length + 1)))) ||
      (config.labTime && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(config.labTime)) ||
      (config.theoryTime && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(config.theoryTime)) ||
      !Number.isInteger(config.intervalSeconds) || config.intervalSeconds < 30 || config.intervalSeconds > 3600) {
    throw new Error("Check the course code, section, optional times, and refresh interval.");
  }
  return config;
}

function render(job) {
  currentJob = job;
  $("state").textContent = job?.phase === "success" ? "Added to basket" : job?.active ? "Watching" : job?.phase === "paused" ? "Needs attention" : "Stopped";
  $("detail").textContent = job?.message ? `${job.courseCode}: ${job.message}` : "Configure a course and press Start.";
  $("dot").className = job?.phase === "success" ? "success" : job?.active ? "active" : job?.phase === "paused" ? "paused" : "";
  $("test").disabled = !!job?.active;
  $("start").disabled = !!job?.active;
  renderSaved();
}

function renderSaved() {
  const select = $("savedCourseSelect");
  const previous = select.value;
  select.replaceChildren();
  if (!savedCourses.length) {
    select.add(new Option("No saved courses", ""));
  } else {
    for (const entry of savedCourses) select.add(new Option(labelFor(entry), entry.id));
  }
  const chosen = [previous, loadedCourseId, savedCourses[0]?.id].find((id) => savedCourses.some((entry) => entry.id === id));
  select.value = chosen || "";
  const entry = savedCourses.find((item) => item.id === select.value);
  $("savedCount").textContent = String(savedCourses.length);
  $("savedSummary").textContent = entry
    ? `${entry.config.courseName} (${entry.config.courseCode})\nSection: ${entry.config.sectionCode || "any"}\nType: ${entry.config.selectionMode === "single" ? "single / online" : entry.config.selectionMode === "theoryOnly" ? "theory only" : "lab + theory"}\nLab: ${entry.config.labTime || "any time"} · Theory/section: ${entry.config.theoryTime || "any time"}\nRefresh: ${entry.config.intervalSeconds} seconds`
    : "Save a course from the Course tab to see it here.";
  $("savedCourseSelect").disabled = !entry;
  $("useSaved").disabled = !entry || !!currentJob?.active;
  $("deleteSaved").disabled = !entry;
  const loaded = savedCourses.find((item) => item.id === loadedCourseId);
  $("editingSaved").textContent = loaded ? `Loaded saved course: ${labelFor(loaded)}` : "Current course is not saved.";
  $("updateSaved").disabled = !loaded;
}

async function persistSaved() {
  await chrome.storage.local.set({ savedCourses, [selectionKey()]: loadedCourseId });
  renderSaved();
}

async function refreshSaved() {
  const { savedCourses: latest } = await chrome.storage.local.get("savedCourses");
  savedCourses = Array.isArray(latest) ? latest : [];
}

function clearMessages() {
  $("error").textContent = "";
  $("saveMessage").textContent = "";
}

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  const { job } = currentTabId === null ? { job: null } : await chrome.runtime.sendMessage({ type: "GET_JOB", tabId: currentTabId });
  const storedData = await chrome.storage.local.get(["savedCourses", selectionKey()]);
  const stored = storedData.savedCourses;
  const selectedSavedCourseId = storedData[selectionKey()];
  savedCourses = Array.isArray(stored) ? stored.filter((entry) => entry?.id && entry?.config?.courseCode) : [];
  loadedCourseId = savedCourses.some((entry) => entry.id === selectedSavedCourseId) ? selectedSavedCourseId : null;
  const selected = savedCourses.find((entry) => entry.id === loadedCourseId);
  if (job?.active && JSON.stringify(configFromJob(job)) !== JSON.stringify(selected?.config)) loadedCourseId = null;
  setForm(job?.active ? job : selected?.config || job || defaults);
  render(job);
}

function configFromJob(job) {
  return Object.fromEntries(Object.keys(defaults).map((key) => [key, job[key]]));
}

$("courseTab").addEventListener("click", () => showTab("course"));
$("savedTab").addEventListener("click", () => showTab("saved"));
$("selectionMode").addEventListener("change", updateModeFields);
$("savedCourseSelect").addEventListener("change", renderSaved);

$("saveNew").addEventListener("click", async () => {
  clearMessages();
  try {
    const config = validConfigFromForm();
    await refreshSaved();
    if (savedCourses.some((entry) => JSON.stringify(entry.config) === JSON.stringify(config))) {
      throw new Error("This exact course setup is already saved. Select it from Saved courses or update it.");
    }
    const now = Date.now();
    const entry = { id: crypto.randomUUID(), config, createdAt: now, updatedAt: now };
    savedCourses.unshift(entry);
    loadedCourseId = entry.id;
    await persistSaved();
    $("savedCourseSelect").value = entry.id;
    renderSaved();
    $("saveMessage").textContent = "Course saved. You can choose it from Saved courses anytime.";
  } catch (error) { $("error").textContent = error.message; }
});

$("updateSaved").addEventListener("click", async () => {
  clearMessages();
  try {
    await refreshSaved();
    const index = savedCourses.findIndex((entry) => entry.id === loadedCourseId);
    if (index < 0) throw new Error("Choose a saved course to update first.");
    const config = validConfigFromForm();
    const entry = { ...savedCourses[index], config, updatedAt: Date.now() };
    savedCourses.splice(index, 1);
    savedCourses.unshift(entry);
    await persistSaved();
    $("savedCourseSelect").value = entry.id;
    renderSaved();
    $("saveMessage").textContent = "Saved course updated.";
  } catch (error) { $("error").textContent = error.message; }
});

$("useSaved").addEventListener("click", async () => {
  clearMessages();
  try {
    if (currentJob?.active) throw new Error("Stop the watcher before switching courses.");
    await refreshSaved();
    const entry = savedCourses.find((item) => item.id === $("savedCourseSelect").value);
    if (!entry) throw new Error("Choose a saved course first.");
    loadedCourseId = entry.id;
    setForm(entry.config);
    await chrome.storage.local.set({ [selectionKey()]: loadedCourseId });
    renderSaved();
    showTab("course");
    $("saveMessage").textContent = `${entry.config.courseCode} loaded. You can start watching or run a test.`;
  } catch (error) { $("error").textContent = error.message; }
});

$("deleteSaved").addEventListener("click", async () => {
  clearMessages();
  try {
    await refreshSaved();
    const entry = savedCourses.find((item) => item.id === $("savedCourseSelect").value);
    if (!entry) throw new Error("Choose a saved course first.");
    if (!confirm(`Delete saved course ${labelFor(entry)}?`)) return;
    savedCourses = savedCourses.filter((item) => item.id !== entry.id);
    if (loadedCourseId === entry.id) loadedCourseId = null;
    await persistSaved();
    $("saveMessage").textContent = "Saved course deleted. The current form was left as it is.";
  } catch (error) { $("error").textContent = error.message; }
});

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();
  try {
    const config = validConfigFromForm();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab found.");
    const result = await chrome.runtime.sendMessage({ type: "START", tabId: tab.id, config });
    if (result.error) throw new Error(result.error);
    render(result.job);
  } catch (error) { $("error").textContent = error.message; }
});

$("test").addEventListener("click", async () => {
  clearMessages();
  $("testResult").textContent = "Checking the course and section selection…";
  $("test").disabled = true;
  try {
    const config = validConfigFromForm();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab found.");
    const result = await chrome.runtime.sendMessage({ type: "TEST_RUN", tabId: tab.id, config });
    if (result.error) throw new Error(result.error);
    if (!result.ok) throw new Error(result.message || "The test returned no clear result.");
    $("testResult").textContent = result.message;
  } catch (error) {
    $("testResult").textContent = "";
    $("error").textContent = error.message;
  } finally {
    const { job } = await chrome.runtime.sendMessage({ type: "GET_JOB", tabId: currentTabId });
    render(job);
  }
});

$("stop").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "STOP", tabId: currentTabId });
  if (result.error) $("error").textContent = result.error;
  else await load();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.jobs && currentTabId !== null) render(changes.jobs.newValue?.[currentTabId] || null);
  if (changes.savedCourses) {
    savedCourses = Array.isArray(changes.savedCourses.newValue) ? changes.savedCourses.newValue : [];
    renderSaved();
  }
});
load().catch((error) => { $("error").textContent = error.message; });
