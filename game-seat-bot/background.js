const ALARM_PREFIX = "seat-check:";
const SITE = "orion.iku.edu.tr";
const testInProgress = new Set();
let jobsWrite = Promise.resolve();
let migration;

const alarmName = (tabId) => `${ALARM_PREFIX}${tabId}`;

function ensureMigrated() {
  if (!migration) migration = (async () => {
    const data = await chrome.storage.local.get(["jobs", "job", "selectedSavedCourseId"]);
    if (data.jobs) return;
    const jobs = {};
    if (data.job?.tabId) jobs[data.job.tabId] = data.job;
    const values = { jobs };
    if (data.job?.tabId && data.selectedSavedCourseId) values[`selectedSavedCourseId:${data.job.tabId}`] = data.selectedSavedCourseId;
    await chrome.storage.local.set(values);
    await chrome.alarms.clear("seat-check");
    if (data.job?.active) await ensureAlarm(data.job);
  })().catch((error) => { migration = null; throw error; });
  return migration;
}

function validTab(tab) {
  try {
    const url = new URL(tab.url);
    return url.protocol === "https:" && url.hostname === SITE && url.port === "8443";
  } catch {
    return false;
  }
}

function validateConfig(config) {
  const mode = config?.selectionMode || "labTheory";
  if (!config || !/^[A-Z0-9* ]{3,32}$/.test(config.courseCode) || !config.courseName ||
      !["labTheory", "theoryOnly", "single"].includes(mode) ||
      (config.labTime && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(config.labTime)) ||
      (config.theoryTime && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(config.theoryTime)) ||
      (config.sectionCode && (!config.sectionCode.startsWith(`${config.courseCode}-`) || !/^[A-Z0-9]+$/.test(config.sectionCode.slice(config.courseCode.length + 1)))) ||
      !Number.isInteger(config.intervalSeconds) || config.intervalSeconds < 30 || config.intervalSeconds > 3600) {
    throw new Error("Check the course, section, times, and refresh interval.");
  }
}

async function getAllJobs() {
  await ensureMigrated();
  await jobsWrite;
  return (await chrome.storage.local.get("jobs")).jobs || {};
}

async function getJob(tabId) {
  if (!Number.isInteger(tabId)) return null;
  return (await getAllJobs())[tabId] || null;
}

function updateJobs(update) {
  const task = jobsWrite.then(async () => {
    await ensureMigrated();
    const jobs = { ...(await chrome.storage.local.get("jobs")).jobs };
    update(jobs);
    await chrome.storage.local.set({ jobs });
    return jobs;
  });
  jobsWrite = task.then(() => {}, () => {});
  return task;
}

async function setBadge(job) {
  const text = job?.phase === "success" ? "✓" : job?.active ? "ON" : job?.phase === "paused" ? "!" : "";
  await chrome.action.setBadgeText({ tabId: job.tabId, text });
  await chrome.action.setBadgeBackgroundColor({ tabId: job.tabId, color: job?.phase === "success" ? "#17803d" : job?.active ? "#1565c0" : "#b64536" });
}

async function saveJob(job) {
  await updateJobs((jobs) => { jobs[job.tabId] = job; });
  await setBadge(job);
}

async function pause(job, message) {
  await chrome.alarms.clear(alarmName(job.tabId));
  await saveJob({ ...job, active: false, phase: "paused", message, updatedAt: Date.now() });
  await notify(`${job.courseCode} needs attention`, message);
}

async function ensureAlarm(job) {
  if (!job?.active) return;
  await chrome.alarms.create(alarmName(job.tabId), { periodInMinutes: job.intervalSeconds / 60 });
}

async function notificationIcon() {
  const canvas = new OffscreenCanvas(128, 128);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#136ed8";
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.arc(64, 64, 40, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(64, 64, 10, 0, Math.PI * 2);
  ctx.fill();
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

async function notify(title, message) {
  try {
    await chrome.notifications.create({ type: "basic", iconUrl: await notificationIcon(), title, message, priority: 2 });
  } catch (error) { console.warn("Could not show notification", error); }
}

async function refreshTarget(tabId) {
  const job = await getJob(tabId);
  if (!job?.active) return;
  if (job.phase === "submitting") {
    if (Date.now() - job.attemptAt > 30000) await pause(job, "Submission result could not be confirmed. Check the basket before starting again.");
    return;
  }
  let tab;
  try { tab = await chrome.tabs.get(job.tabId); } catch { /* Closed tab. */ }
  if (!tab || !validTab(tab)) {
    await pause(job, "Target Orion tab is closed or has left the registration site. Open it and press Start again.");
    return;
  }
  await chrome.tabs.reload(tabId);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const tabId = Number(alarm.name.slice(ALARM_PREFIX.length));
  if (Number.isInteger(tabId)) refreshTarget(tabId).catch(console.error);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    await chrome.alarms.clear(alarmName(tabId));
    await updateJobs((jobs) => { delete jobs[tabId]; });
    await chrome.storage.local.remove(`selectedSavedCourseId:${tabId}`);
  })().catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "GET_JOB") {
      const tabId = sender.tab?.id ?? message.tabId;
      const job = await getJob(tabId);
      return sender.tab ? { job: job?.active ? job : null } : { job };
    }

    if (message.type === "START") {
      if (testInProgress.has(message.tabId)) throw new Error("Wait for this tab's test run to finish before starting the watcher.");
      const tab = await chrome.tabs.get(message.tabId);
      if (!validTab(tab)) throw new Error("Open the İKÜ Orion registration page in the active Chrome tab first.");
      if ((await getJob(tab.id))?.active) throw new Error("Stop this tab's watcher before starting a different course here.");
      const config = message.config;
      validateConfig(config);
      const job = {
        ...config,
        tabId: tab.id,
        token: crypto.randomUUID(),
        active: true,
        phase: "waiting",
        message: "Watching for a seat",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        lastCheckAt: null,
        attemptAt: null
      };
      await saveJob(job);
      await ensureAlarm(job);
      try { await chrome.tabs.sendMessage(tab.id, { type: "SCAN" }); }
      catch { await chrome.tabs.reload(tab.id); }
      return { job };
    }

    if (message.type === "TEST_RUN") {
      if (testInProgress.has(message.tabId)) throw new Error("A test run is already in progress in this tab.");
      testInProgress.add(message.tabId);
      try {
        const activeJob = await getJob(message.tabId);
        if (activeJob?.active) throw new Error("Stop the active watcher before running a test.");
        const tab = await chrome.tabs.get(message.tabId);
        if (!validTab(tab)) throw new Error("Open the İKÜ Orion registration page in the active Chrome tab first.");
        validateConfig(message.config);
        let result;
        try { result = await chrome.tabs.sendMessage(tab.id, { type: "TEST_RUN", config: message.config }); }
        catch { throw new Error("Refresh the Orion tab once, then try the test again."); }
        if (!result?.outcome) throw new Error("The test did not return a result. Check the basket before trying again.");
        const phase = result.outcome === "success" ? "success" : result.outcome === "full" ? "stopped" : "paused";
        await saveJob({ ...message.config, tabId: tab.id, active: false, phase, message: result.message, updatedAt: Date.now() });
        if (result.outcome === "success") await notify(`${message.config.courseCode} added to basket`, result.message);
        return result;
      }
      finally { testInProgress.delete(message.tabId); }
    }

    if (message.type === "STOP") {
      const job = await getJob(message.tabId);
      await chrome.alarms.clear(alarmName(message.tabId));
      if (job) await saveJob({ ...job, active: false, phase: "stopped", message: "Stopped", updatedAt: Date.now() });
      return { ok: true };
    }

    const job = await getJob(sender.tab?.id);
    if (!job?.active || sender.tab?.id !== job.tabId || message.token !== job.token) return { ok: false };

    if (message.type === "CHECKED") {
      if (job.phase !== "submitting") await saveJob({ ...job, phase: "waiting", message: message.message, lastCheckAt: Date.now(), updatedAt: Date.now() });
      return { ok: true };
    }

    if (message.type === "BLOCKED") {
      await pause(job, message.message);
      return { ok: true };
    }

    if (message.type === "BEGIN_ATTEMPT") {
      if (job.phase === "submitting") return { ok: false };
      await saveJob({ ...job, phase: "submitting", message: "Seat seen; adding to basket", attemptAt: Date.now(), lastCheckAt: Date.now(), updatedAt: Date.now() });
      return { ok: true };
    }

    if (message.type === "RESULT" && job.phase === "submitting") {
      if (message.outcome === "success") {
        await chrome.alarms.clear(alarmName(job.tabId));
        await saveJob({ ...job, active: false, phase: "success", message: "Added to registration basket", updatedAt: Date.now() });
        const selected = (job.selectionMode || "labTheory") === "labTheory" ? "Lab and theory" : "Section";
        await notify(`${job.courseCode} added to basket`, `${selected} selected. Verify your registration basket.`);
      } else if (message.outcome === "full") {
        await saveJob({ ...job, phase: "waiting", message: "Capacity filled before submission; watching again", updatedAt: Date.now() });
      } else {
        await pause(job, message.message || "Submission result is uncertain. Check the basket before restarting.");
      }
      return { ok: true };
    }
    return { ok: false };
  })().then(sendResponse).catch((error) => sendResponse({ error: error.message }));
  return true;
});

async function restore() {
  const jobs = await getAllJobs();
  await chrome.alarms.clear("seat-check");
  await chrome.action.setBadgeText({ text: "" });
  for (const job of Object.values(jobs)) {
    let tab;
    try { tab = await chrome.tabs.get(job.tabId); } catch { /* Closed tab. */ }
    if (!tab) {
      await chrome.alarms.clear(alarmName(job.tabId));
      await updateJobs((current) => { delete current[job.tabId]; });
      continue;
    }
    if (job.active) await ensureAlarm(job);
    await setBadge(job);
  }
}
chrome.runtime.onStartup.addListener(() => restore().catch(console.error));
chrome.runtime.onInstalled.addListener(() => restore().catch(console.error));
