/**
 * Background Service Worker for the Mood Blocker Chrome Extension.
 * Bridges AI site-recommendation requests (`ASK_AI`), manages Easy-mode
 * per-tab bypasses (`ALLOW_BYPASS`), seeds default moods on install,
 * and redirects tabs visiting blocked domains to `blocked.html`.
 */

import { initDefaultMoods, getMoodData } from "./storage.js";

const AI_ENDPOINT = "http://localhost:3001/api/chat";
const BYPASS_STORAGE_KEY = "easyModeBypassTabs";

/** In-memory cache of `{ [tabId]: string[] }` for instant bypass checks. */
let bypassCache = null;

/**
 * Loads per-tab Easy-mode bypasses from `chrome.storage.session` (with in-memory fallback).
 *
 * @returns {Promise<Record<string, string[]>>}
 */
async function getBypassMap() {
  if (bypassCache) {
    return bypassCache;
  }

  if (chrome.storage?.session?.get) {
    try {
      const raw = await chrome.storage.session.get(BYPASS_STORAGE_KEY);
      if (raw && raw[BYPASS_STORAGE_KEY] && typeof raw[BYPASS_STORAGE_KEY] === "object") {
        bypassCache = raw[BYPASS_STORAGE_KEY];
        return bypassCache;
      }
    } catch {
      // Fallback to in-memory map if session storage is unavailable.
    }
  }

  bypassCache = {};
  return bypassCache;
}

/**
 * Persists the per-tab Easy-mode bypass map.
 *
 * @param {Record<string, string[]>} map
 */
async function saveBypassMap(map) {
  bypassCache = map;
  if (chrome.storage?.session?.set) {
    try {
      await chrome.storage.session.set({ [BYPASS_STORAGE_KEY]: map });
    } catch {
      // In-memory cache still holds the latest state.
    }
  }
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
 * @returns {string}
 */
function buildBlockedPageUrl(matchedDomain, activeMood, originalUrl) {
  const level = activeMood.settings?.level === "easy" ? "easy" : "hard";
  const params = new URLSearchParams({
    site: matchedDomain,
    mood: activeMood.name || "Focus",
    level,
    timer: String(activeMood.settings?.timerMinutes ?? 0),
    from: originalUrl,
  });

  return `${chrome.runtime.getURL("blocked.html")}?${params.toString()}`;
}

/**
 * Checks a single tab and redirects it to `blocked.html` if its URL is blocked.
 *
 * @param {number} tabId
 * @param {string | undefined} tabUrl
 * @param {import("./storage.js").Mood | null} activeMood
 */
async function enforceBlockOnTab(tabId, tabUrl, activeMood) {
  if (!activeMood || typeof tabId !== "number" || !tabUrl) {
    return;
  }

  const matchedDomain = findMatchedBlockedSite(tabUrl, activeMood.blockedSites);
  if (!matchedDomain) {
    return;
  }

  const level = activeMood.settings?.level === "easy" ? "easy" : "hard";
  if (level === "easy" && (await isTabBypassed(tabId, matchedDomain))) {
    return;
  }

  const redirectUrl = buildBlockedPageUrl(matchedDomain, activeMood, tabUrl);
  try {
    await chrome.tabs.update(tabId, { url: redirectUrl });
  } catch (error) {
    // Tab may have been closed between detection and redirect.
    console.debug("[Mood Blocker] Skipped redirect for tab:", tabId, error);
  }
}

/**
 * Loads the currently active mood from storage.
 *
 * @returns {Promise<{ activeMoodId: string | null, activeMood: import("./storage.js").Mood | null }>}
 */
async function getActiveMoodConfig() {
  const { activeMood, moods } = await getMoodData();
  const currentMood = activeMood && moods ? moods[activeMood] ?? null : null;
  return { activeMoodId: activeMood, activeMood: currentMood };
}

/**
 * Scans all open tabs and immediately redirects any tab matching the active mood's blocklist.
 */
async function enforceBlockOnOpenTabs() {
  try {
    const { activeMoodId, activeMood } = await getActiveMoodConfig();

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
 * Seed default moods on install and check any open tabs.
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
 * Re-check open tabs when Chrome starts up.
 */
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    enforceBlockOnOpenTabs();
  });
}

/**
 * React whenever `activeMood` or `moods` changes in `chrome.storage.local`.
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (!changes.activeMood && !changes.moods) {
    return;
  }

  if (changes.activeMood) {
    clearAllBypasses().then(() => enforceBlockOnOpenTabs());
    return;
  }

  enforceBlockOnOpenTabs();
});

/**
 * Clean up per-tab Easy-mode bypass entries when a tab is closed.
 */
if (chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const map = await getBypassMap();
    const key = String(tabId);
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      delete map[key];
      await saveBypassMap(map);
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
