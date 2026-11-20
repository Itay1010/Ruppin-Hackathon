/**
 * Background Service Worker for the Mood Blocker Chrome Extension.
 * Bridges AI site-recommendation requests (`ASK_AI`), manages Easy-mode
 * per-tab bypasses (`ALLOW_BYPASS`), tracks last safe URLs for reliable
 * "Go Back" navigation (`GO_BACK`), enforces optional Focus Timer
 * auto-deactivation via `chrome.alarms`, seeds default moods on install,
 * and redirects tabs visiting blocked domains to `blocked.html`.
 */

import { initDefaultMoods, getMoodData, setActiveMood } from "./storage.js";

const AI_ENDPOINT = "http://localhost:3001/api/chat";
const BYPASS_STORAGE_KEY = "easyModeBypassTabs";
const SAFE_URL_STORAGE_KEY = "lastSafeUrlByTab";
const TIMER_ALARM_NAME = "moodTimerEnd";
const FALLBACK_BACK_URL = "chrome://newtab/";

/** In-memory caches backed by `chrome.storage.session`. */
let bypassCache = null;
let safeUrlCache = null;

/**
 * Loads a session-stored map with in-memory fallback.
 *
 * @param {string} key
 * @returns {Promise<Record<string, any>>}
 */
async function readSessionMap(key) {
  if (chrome.storage?.session?.get) {
    try {
      const raw = await chrome.storage.session.get(key);
      if (raw && raw[key] && typeof raw[key] === "object") {
        return raw[key];
      }
    } catch {
      // Fallback to in-memory map if session storage is unavailable.
    }
  }
  return {};
}

/**
 * Persists a map to `chrome.storage.session` when available.
 *
 * @param {string} key
 * @param {Record<string, any>} map
 */
async function writeSessionMap(key, map) {
  if (chrome.storage?.session?.set) {
    try {
      await chrome.storage.session.set({ [key]: map });
    } catch {
      // In-memory cache still holds the latest state.
    }
  }
}

async function getBypassMap() {
  if (!bypassCache) {
    bypassCache = await readSessionMap(BYPASS_STORAGE_KEY);
  }
  return bypassCache;
}

async function saveBypassMap(map) {
  bypassCache = map;
  await writeSessionMap(BYPASS_STORAGE_KEY, map);
}

async function getSafeUrlMap() {
  if (!safeUrlCache) {
    safeUrlCache = await readSessionMap(SAFE_URL_STORAGE_KEY);
  }
  return safeUrlCache;
}

async function saveSafeUrlMap(map) {
  safeUrlCache = map;
  await writeSessionMap(SAFE_URL_STORAGE_KEY, map);
}

/**
 * Checks whether a URL is a valid non-extension page suitable to record as a "Go Back" target.
 *
 * @param {string | undefined} rawUrl
 * @returns {boolean}
 */
function isRecordableBackUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) {
    return false;
  }
  if (rawUrl.startsWith(chrome.runtime.getURL(""))) {
    return false;
  }
  return (
    rawUrl.startsWith("http://") ||
    rawUrl.startsWith("https://") ||
    rawUrl === "chrome://newtab/" ||
    rawUrl.startsWith("chrome://newtab")
  );
}

/**
 * Remembers the most recent non-blocked URL visited by a tab so "Go Back" skips the blocked URL.
 *
 * @param {number} tabId
 * @param {string} url
 */
async function recordSafeUrl(tabId, url) {
  if (typeof tabId !== "number" || !isRecordableBackUrl(url)) {
    return;
  }
  const map = await getSafeUrlMap();
  const key = String(tabId);
  if (map[key] === url) {
    return;
  }
  map[key] = url;
  await saveSafeUrlMap(map);
}

/**
 * Marks a domain as temporarily allowed in a specific tab (Easy mode only).
 *
 * @param {number} tabId
 * @param {string} domain
 */
async function allowBypassForTab(tabId, domain) {
  const cleanDomain = typeof domain === "string" ? domain.trim().toLowerCase() : "";
  if (typeof tabId !== "number" || !cleanDomain) {
    return;
  }

  const map = await getBypassMap();
  const key = String(tabId);
  const existing = new Set(Array.isArray(map[key]) ? map[key] : []);
  existing.add(cleanDomain);
  map[key] = Array.from(existing);
  await saveBypassMap(map);
}

/**
 * Checks whether a tab has an active Easy-mode bypass for a matched domain.
 *
 * @param {number} tabId
 * @param {string} matchedDomain
 * @returns {Promise<boolean>}
 */
async function isTabBypassed(tabId, matchedDomain) {
  const map = await getBypassMap();
  const allowed = map[String(tabId)];
  return Array.isArray(allowed) && allowed.includes(matchedDomain.toLowerCase());
}

/**
 * Clears all stored Easy-mode bypasses (e.g. when switching to Hard mode or deactivating).
 */
async function clearAllBypasses() {
  await saveBypassMap({});
}

/**
 * Schedules or clears the MV3 alarm that auto-deactivates the active mood when its timer ends.
 *
 * @param {string | null} activeMoodId
 * @param {number | null} timerEndAt
 */
async function syncFocusTimerAlarm(activeMoodId, timerEndAt) {
  if (!chrome.alarms) {
    return;
  }

  await chrome.alarms.clear(TIMER_ALARM_NAME);

  if (!activeMoodId || !timerEndAt) {
    return;
  }

  if (Date.now() >= timerEndAt) {
    console.log("[Mood Blocker] Focus timer already elapsed. Deactivating mood.");
    await setActiveMood(null);
    return;
  }

  chrome.alarms.create(TIMER_ALARM_NAME, { when: timerEndAt });
  const remainingSec = Math.max(1, Math.round((timerEndAt - Date.now()) / 1000));
  console.log(
    `[Mood Blocker] Focus timer scheduled for "${activeMoodId}" (${remainingSec}s remaining).`
  );
}

/**
 * Sends a user description to the local AI recommendation server and returns
 * an array of suggested URLs/domains.
 *
 * @param {string} message
 * @returns {Promise<string[]>}
 */
async function askAI(message) {
  let response;
  try {
    response = await fetch(AI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    });
  } catch (error) {
    console.error("[Mood Blocker] AI connection error:", error);
    throw new Error(
      "Cannot reach AI server at http://localhost:3001. Make sure backend/server.js is running."
    );
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const serverMsg = data?.error || `AI server returned HTTP ${response.status}`;
    throw new Error(serverMsg);
  }

  if (!Array.isArray(data?.answer)) {
    throw new Error("Unexpected response format from AI server.");
  }

  return data.answer;
}

/**
 * Navigates a tab from `blocked.html` back to its last safe (non-blocked) URL,
 * or to Chrome's New Tab page if there is no previous safe URL.
 *
 * @param {number | undefined} tabId
 * @param {string | undefined} fallbackBack
 */
async function navigateTabBackSafely(tabId, fallbackBack) {
  if (typeof tabId !== "number" || !chrome.tabs?.update) {
    return;
  }

  const [{ activeMood }, safeMap] = await Promise.all([
    getActiveMoodConfig(),
    getSafeUrlMap(),
  ]);

  const candidates = [safeMap[String(tabId)], fallbackBack];
  let targetUrl = FALLBACK_BACK_URL;

  for (const candidate of candidates) {
    if (!isRecordableBackUrl(candidate)) {
      continue;
    }
    const stillBlocked =
      activeMood && findMatchedBlockedSite(candidate, activeMood.blockedSites);
    if (!stillBlocked) {
      targetUrl = candidate;
      break;
    }
  }

  await chrome.tabs.update(tabId, { url: targetUrl });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type === "ASK_AI") {
    askAI(request.message)
      .then((answer) => {
        sendResponse({ answer });
      })
      .catch((error) => {
        sendResponse({ error: error.message || "AI request failed." });
      });

    return true;
  }

  if (request?.type === "ALLOW_BYPASS") {
    const tabId = sender?.tab?.id;
    const domain = request.domain;

    getActiveMoodConfig()
      .then(async ({ activeMood }) => {
        const level = activeMood?.settings?.level === "easy" ? "easy" : "hard";
        if (activeMood && level !== "easy") {
          sendResponse({ ok: false, error: "Bypass is only allowed in Easy mode." });
          return;
        }
        await allowBypassForTab(tabId, domain);
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || "Bypass failed." });
      });

    return true;
  }

  if (request?.type === "GO_BACK") {
    navigateTabBackSafely(sender?.tab?.id, request.fallbackBack)
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || "Could not go back." });
      });

    return true;
  }
});

/**
 * Checks whether a tab URL matches any domain in `blockedSites`.
 * Matches exact domains and subdomains (e.g. `youtube.com` matches `www.youtube.com`
 * and `m.youtube.com`, but not `myyoutube.com`).
 *
 * @param {string | undefined} rawUrl
 * @param {string[]} blockedSites
 * @returns {string | null} The matched blocked domain, or `null` if allowed.
 */
export function findMatchedBlockedSite(rawUrl, blockedSites) {
  if (
    typeof rawUrl !== "string" ||
    !rawUrl ||
    !Array.isArray(blockedSites) ||
    blockedSites.length === 0
  ) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  // Only inspect standard web pages (never redirect chrome:// or chrome-extension:// pages).
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");

  for (const rawDomain of blockedSites) {
    if (typeof rawDomain !== "string") {
      continue;
    }
    const domain = rawDomain.trim().toLowerCase();
    if (!domain) {
      continue;
    }
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      return domain;
    }
  }

  return null;
}

/**
 * Builds the extension URL for `blocked.html` with context query parameters.
 *
 * @param {string} matchedDomain
 * @param {import("./storage.js").Mood} activeMood
 * @param {string} originalUrl
 * @param {string | undefined} backUrl
 * @returns {string}
 */
function buildBlockedPageUrl(matchedDomain, activeMood, originalUrl, backUrl) {
  const level = activeMood.settings?.level === "easy" ? "easy" : "hard";
  const timerEnabled = activeMood.settings?.timerEnabled === true;
  const params = new URLSearchParams({
    site: matchedDomain,
    mood: activeMood.name || "Focus",
    level,
    timer: timerEnabled ? String(activeMood.settings?.timerMinutes ?? 0) : "0",
    from: originalUrl,
  });

  if (backUrl && isRecordableBackUrl(backUrl)) {
    params.set("back", backUrl);
  }

  return `${chrome.runtime.getURL("blocked.html")}?${params.toString()}`;
}

/**
 * Checks a single tab and redirects it to `blocked.html` if its URL is blocked,
 * or records it as the tab's last safe URL if allowed.
 *
 * @param {number} tabId
 * @param {string | undefined} tabUrl
 * @param {import("./storage.js").Mood | null} activeMood
 */
async function enforceBlockOnTab(tabId, tabUrl, activeMood) {
  if (typeof tabId !== "number" || !tabUrl) {
    return;
  }

  const matchedDomain = activeMood
    ? findMatchedBlockedSite(tabUrl, activeMood.blockedSites)
    : null;

  if (!matchedDomain) {
    await recordSafeUrl(tabId, tabUrl);
    return;
  }

  const level = activeMood.settings?.level === "easy" ? "easy" : "hard";
  if (level === "easy" && (await isTabBypassed(tabId, matchedDomain))) {
    return;
  }

  const safeMap = await getSafeUrlMap();
  const backUrl = safeMap[String(tabId)];
  const redirectUrl = buildBlockedPageUrl(
    matchedDomain,
    activeMood,
    tabUrl,
    backUrl
  );

  try {
    await chrome.tabs.update(tabId, { url: redirectUrl });
  } catch (error) {
    // Tab may have been closed between detection and redirect.
    console.debug("[Mood Blocker] Skipped redirect for tab:", tabId, error);
  }
}

/**
 * Loads the currently active mood from storage, auto-deactivating if its focus timer has expired.
 *
 * @returns {Promise<{ activeMoodId: string | null, activeMood: import("./storage.js").Mood | null, timerEndAt: number | null }>}
 */
async function getActiveMoodConfig() {
  const { activeMood, moods, timerEndAt } = await getMoodData();

  if (activeMood && timerEndAt && Date.now() >= timerEndAt) {
    await setActiveMood(null);
    return { activeMoodId: null, activeMood: null, timerEndAt: null };
  }

  const currentMood = activeMood && moods ? moods[activeMood] ?? null : null;
  return { activeMoodId: activeMood, activeMood: currentMood, timerEndAt };
}

/**
 * Scans all open tabs, syncs the focus timer alarm, and redirects matching tabs.
 */
async function enforceBlockOnOpenTabs() {
  try {
    const { activeMoodId, activeMood, timerEndAt } = await getActiveMoodConfig();
    await syncFocusTimerAlarm(activeMoodId, timerEndAt);

    if (!activeMoodId || !activeMood) {
      await clearAllBypasses();
      console.log("[Mood Blocker] No active mood. Tab blocking paused.");
      return;
    }

    const level = activeMood.settings?.level === "easy" ? "easy" : "hard";
    if (level === "hard") {
      await clearAllBypasses();
    }

    console.log(
      `[Mood Blocker] Active mood: "${activeMood.name}" (${activeMoodId}, level: ${level})`,
      {
        blockedSites: activeMood.blockedSites,
        settings: activeMood.settings,
        timerEndAt,
      }
    );

    if (!chrome.tabs?.query) {
      console.warn(
        '[Mood Blocker] chrome.tabs API unavailable. Add "tabs" to manifest.json permissions.'
      );
      return;
    }

    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) =>
        enforceBlockOnTab(tab.id, tab.url || tab.pendingUrl, activeMood)
      )
    );
  } catch (error) {
    console.error("[Mood Blocker] Error enforcing blocks on open tabs:", error);
  }
}

/**
 * Automatically deactivate the active mood when the Focus Timer alarm fires.
 */
if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== TIMER_ALARM_NAME) {
      return;
    }

    try {
      const { activeMood, timerEndAt } = await getMoodData();
      if (activeMood && timerEndAt && Date.now() >= timerEndAt - 1000) {
        console.log("[Mood Blocker] Focus timer finished — deactivating mood.");
        await setActiveMood(null);
      }
    } catch (error) {
      console.error("[Mood Blocker] Error handling timer alarm:", error);
    }
  });
}

/**
 * Seed default moods on install and sync timer + open tabs.
 */
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await initDefaultMoods();
    await enforceBlockOnOpenTabs();
  } catch (error) {
    console.error("[Mood Blocker] Failed to initialize default moods:", error);
  }
});

/**
 * Re-sync timer alarm and open tabs when Chrome starts up.
 */
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    enforceBlockOnOpenTabs();
  });
}

/**
 * React whenever `activeMood`, `moods`, or `timerEndAt` changes in `chrome.storage.local`.
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (!changes.activeMood && !changes.moods && !changes.timerEndAt) {
    return;
  }

  if (changes.activeMood) {
    clearAllBypasses().then(() => enforceBlockOnOpenTabs());
    return;
  }

  enforceBlockOnOpenTabs();
});

/**
 * Clean up per-tab session entries when a tab is closed.
 */
if (chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const key = String(tabId);
    const bypassMap = await getBypassMap();
    if (Object.prototype.hasOwnProperty.call(bypassMap, key)) {
      delete bypassMap[key];
      await saveBypassMap(bypassMap);
    }

    const safeMap = await getSafeUrlMap();
    if (Object.prototype.hasOwnProperty.call(safeMap, key)) {
      delete safeMap[key];
      await saveSafeUrlMap(safeMap);
    }
  });
}

/**
 * Intercept tab URL changes (including SPA navigations like YouTube) and redirect blocked sites.
 */
if (chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    const candidateUrl =
      changeInfo.url || (changeInfo.status === "loading" ? tab?.url : undefined);
    if (!candidateUrl) {
      return;
    }

    try {
      const { activeMood } = await getActiveMoodConfig();
      await enforceBlockOnTab(tabId, candidateUrl, activeMood);
    } catch (error) {
      console.error("[Mood Blocker] Error checking updated tab:", error);
    }
  });
}

/**
 * Intercept newly created tabs that already have a target URL.
 */
if (chrome.tabs?.onCreated) {
  chrome.tabs.onCreated.addListener(async (tab) => {
    const candidateUrl = tab.pendingUrl || tab.url;
    if (!candidateUrl || typeof tab.id !== "number") {
      return;
    }

    try {
      const { activeMood } = await getActiveMoodConfig();
      await enforceBlockOnTab(tab.id, candidateUrl, activeMood);
    } catch (error) {
      console.error("[Mood Blocker] Error checking new tab:", error);
    }
  });
}
