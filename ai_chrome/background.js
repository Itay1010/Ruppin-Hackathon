
async function askAI(message) {
    try {
        const response = await fetch("http://localhost:3001/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ message })
        });

        if (!response.ok) {
            throw new Error("Failed to connect to AI");
        }

        const data = await response.json();

        return data.answer;

    } catch (error) {
        console.error("AI Error:", error);
        throw error;
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    if (request.type === "ASK_AI") {

        askAI(request.message)
            .then(answer => {
                sendResponse({ answer: answer });
            })
            .catch(error => {
                sendResponse({ error: error.message });
            });

        return true;
    }
});
/**
 * Background Service Worker for the Mood Blocker Chrome Extension.
 * Seeds default moods on install and reacts to storage changes so blocking
 * rules stay synchronized with the active mood.
 */

import { initDefaultMoods, getMoodData } from "./storage.js";

/**
 * Synchronizes active mood state with browser blocking rules.
 *
 * @param {string | null} activeMoodId - Currently active mood ID, or `null` if inactive.
 * @param {import("./storage.js").Mood | null} activeMood - Mood configuration for `activeMoodId`.
 */
async function syncMoodRules(activeMoodId, activeMood) {
  if (!activeMoodId || !activeMood) {
    console.log("[Mood Blocker] No active mood. Blocked sites: []");
    // TODO: Apply declarativeNetRequest blocking rules here
    return;
  }

  console.log(
    `[Mood Blocker] Active mood: "${activeMood.name}" (${activeMoodId})`,
    {
      blockedSites: activeMood.blockedSites,
      settings: activeMood.settings,
    }
  );

  // TODO: Apply declarativeNetRequest blocking rules here
}

/**
 * Seed default moods when the extension is installed or updated.
 */
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const state = await initDefaultMoods();
    const activeMood = state.activeMood
      ? state.moods[state.activeMood] ?? null
      : null;

    console.log("[Mood Blocker] Storage initialized.", {
      moods: Object.keys(state.moods),
      activeMood: state.activeMood,
    });

    await syncMoodRules(state.activeMood, activeMood);
  } catch (error) {
    console.error("[Mood Blocker] Failed to initialize default moods:", error);
  }
});

/**
 * React whenever `activeMood` or `moods` changes in `chrome.storage.local`.
 */
chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (!changes.activeMood && !changes.moods) {
    return;
  }

  try {
    const { activeMood, moods } = await getMoodData();
    const currentMood = activeMood ? moods[activeMood] ?? null : null;
    await syncMoodRules(activeMood, currentMood);
  } catch (error) {
    console.error("[Mood Blocker] Error handling storage change:", error);
  }
});
