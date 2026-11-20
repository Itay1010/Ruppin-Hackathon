/**
 * Background Service Worker for the Mood Blocker Chrome Extension.
 * Seeds default moods on install and reacts to storage changes so blocking
 * rules stay synchronized with the active mood.
 */

import { initDefaultMoods, getMoodData } from "./storage.js";

const BLOCKED_RESOURCE_TYPES = ["main_frame", "sub_frame"];

/** Serializes dynamic rule updates to prevent overlapping rule-ID collisions. */
let syncQueue = Promise.resolve();

function buildBlockingRules(domains) {
  const uniqueDomains = Array.from(
    new Set(
      (Array.isArray(domains) ? domains : [])
        .map((domain) => (typeof domain === "string" ? domain.trim().toLowerCase() : ""))
        .filter(Boolean)
    )
  );

  return uniqueDomains.map((domain, index) => ({
    id: index + 1,
    priority: 1,
    action: { type: "block" },
    condition: {
      requestDomains: [domain],
      resourceTypes: BLOCKED_RESOURCE_TYPES,
    },
  }));
}

function syncMoodRules(activeMoodId, activeMood) {
  syncQueue = syncQueue
    .then(async () => {
      if (!chrome.declarativeNetRequest?.updateDynamicRules) {
        console.warn(
          '[Mood Blocker] declarativeNetRequest API unavailable. Add "declarativeNetRequest" to manifest.json permissions.'
        );
        return;
      }

      const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
      const removeRuleIds = existingRules.map((rule) => rule.id);

      if (!activeMoodId || !activeMood) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds,
          addRules: [],
        });
        console.log("[Mood Blocker] No active mood. Cleared all blocking rules.");
        return;
      }

      const addRules = buildBlockingRules(activeMood.blockedSites);
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules,
      });

      console.log(
        `[Mood Blocker] Active mood: "${activeMood.name}" (${activeMoodId}) — blocking ${addRules.length} domain(s)`,
        {
          blockedSites: activeMood.blockedSites,
          settings: activeMood.settings,
        }
      );
    })
    .catch((error) => {
      console.error("[Mood Blocker] Failed to sync blocking rules:", error);
    });

  return syncQueue;
}

async function syncFromStorage() {
  try {
    const { activeMood, moods } = await getMoodData();
    const currentMood = activeMood ? moods[activeMood] ?? null : null;
    await syncMoodRules(activeMood, currentMood);
  } catch (error) {
    console.error("[Mood Blocker] Error reading storage state:", error);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const state = await initDefaultMoods();
    const activeMood = state.activeMood
      ? state.moods[state.activeMood] ?? null
      : null;

    await syncMoodRules(state.activeMood, activeMood);
  } catch (error) {
    console.error("[Mood Blocker] Failed to initialize default moods:", error);
  }
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    syncFromStorage();
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (!changes.activeMood && !changes.moods) {
    return;
  }

  syncFromStorage();
});