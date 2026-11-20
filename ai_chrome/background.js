/**
 * Background Service Worker for the Mood Blocker Chrome Extension.
 * Bridges AI site-recommendation requests (`ASK_AI`), seeds default moods on install,
 * and redirects tabs visiting blocked domains to `blocked.html` via `chrome.tabs.update(...)`.
 */

import { initDefaultMoods, getMoodData } from "./storage.js";

const AI_ENDPOINT = "http://localhost:3001/api/chat";

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

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
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
  if (typeof rawUrl !== "string" || !rawUrl || !Array.isArray(blockedSites) || blockedSites.length === 0) {
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
  const params = new URLSearchParams({
    site: matchedDomain,
    mood: activeMood.name || "Focus",
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
      console.log("[Mood Blocker] No active mood. Tab blocking paused.");
      return;
    }

    console.log(
      `[Mood Blocker] Active mood: "${activeMood.name}" (${activeMoodId})`,
      {
        blockedSites: activeMood.blockedSites,
        settings: activeMood.settings,
      }
    );

    if (!chrome.tabs?.query) {
      console.warn('[Mood Blocker] chrome.tabs API unavailable. Add "tabs" to manifest.json permissions.');
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

  enforceBlockOnOpenTabs();
});

/**
 * Intercept tab URL changes (including SPA navigations like YouTube) and redirect blocked sites.
 */
if (chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    const candidateUrl = changeInfo.url || (changeInfo.status === "loading" ? tab?.url : undefined);
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
