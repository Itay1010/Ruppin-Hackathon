/**
 * Controller for blocked.html.
 * Supports both Hard mode (strict block) and Easy mode (shows a "Continue anyway"
 * button that requests a per-tab bypass from background.js before navigating).
 */

const params = new URLSearchParams(window.location.search);
const blockedSite = params.get("site") || "this website";
const moodName = params.get("mood") || "Focus";
const initialLevel = params.get("level") === "easy" ? "easy" : "hard";
const timerMinutes = Number(params.get("timer"));
const originalUrl = params.get("from") || "";

const moodLabelEl = document.getElementById("mood-label");
const headingEl = document.getElementById("blocked-heading");
const subtitleEl = document.getElementById("blocked-subtitle");
const blockedSiteEl = document.getElementById("blocked-site");
const timerNoteEl = document.getElementById("timer-note");
const goBackBtn = document.getElementById("go-back-btn");
const closeTabBtn = document.getElementById("close-tab-btn");
const continueBtn = document.getElementById("continue-btn");
const easyOverrideBox = document.getElementById("easy-override-box");
const continueAnywayBtn = document.getElementById("continue-anyway-btn");
const unblockedBanner = document.getElementById("unblocked-banner");

blockedSiteEl.textContent = blockedSite;

if (Number.isFinite(timerMinutes) && timerMinutes > 0) {
  timerNoteEl.textContent = `Focus timer target: ${timerMinutes} min`;
  timerNoteEl.hidden = false;
}

/**
 * Validates that a return URL uses HTTP(S) before navigating to it.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Updates UI copy and controls for Hard vs Easy mode.
 *
 * @param {"hard" | "easy"} level
 * @param {string} activeMoodName
 */
function applyLevelUI(level, activeMoodName) {
  const isEasy = level === "easy";
  moodLabelEl.textContent = `${activeMoodName} Mood · ${isEasy ? "Easy" : "Hard"}`;

  if (isEasy) {
    headingEl.textContent = "Pause before you visit";
    subtitleEl.textContent =
      "This website is on your blocklist, but Easy mode lets you continue if you really need it.";
    if (isSafeHttpUrl(originalUrl)) {
      continueAnywayBtn.textContent = `Continue to ${blockedSite} anyway`;
      easyOverrideBox.hidden = false;
    } else {
      easyOverrideBox.hidden = true;
    }
  } else {
    headingEl.textContent = "Stay in the zone";
    subtitleEl.textContent =
      "This website is strictly blocked while Hard mode is active.";
    easyOverrideBox.hidden = true;
  }
}

applyLevelUI(initialLevel, moodName);

goBackBtn.addEventListener("click", () => {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.close();
  }
});

closeTabBtn.addEventListener("click", () => {
  window.close();
});

continueBtn.addEventListener("click", () => {
  if (isSafeHttpUrl(originalUrl)) {
    window.location.replace(originalUrl);
  }
});

continueAnywayBtn.addEventListener("click", async () => {
  if (!isSafeHttpUrl(originalUrl)) {
    return;
  }

  continueAnywayBtn.disabled = true;
  continueAnywayBtn.textContent = "Opening...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "ALLOW_BYPASS",
      domain: blockedSite,
      url: originalUrl,
    });

    if (response?.ok) {
      window.location.replace(originalUrl);
      return;
    }

    // If mood switched to Hard before clicking, refresh state to reflect Hard mode.
    await syncBlockedState();
  } catch {
    await syncBlockedState();
  } finally {
    continueAnywayBtn.disabled = false;
    continueAnywayBtn.textContent = `Continue to ${blockedSite} anyway`;
  }
});

/**
 * Checks live storage state to reflect whether the site is still blocked
 * and whether the active mood is currently in Hard or Easy mode.
 */
async function syncBlockedState() {
  if (!chrome?.storage?.local) {
    return;
  }

  try {
    const { activeMood, moods } = await chrome.storage.local.get([
      "activeMood",
      "moods",
    ]);
    const currentMood = activeMood && moods ? moods[activeMood] : null;
    const blockedList = Array.isArray(currentMood?.blockedSites)
      ? currentMood.blockedSites
      : [];
    const stillBlocked = blockedList.includes(blockedSite.toLowerCase());

    if (!stillBlocked) {
      moodLabelEl.textContent = "Unblocked";
      headingEl.textContent = "You're free to continue";
      subtitleEl.textContent = "This website is no longer blocked.";
      easyOverrideBox.hidden = true;
      unblockedBanner.hidden = false;
      if (isSafeHttpUrl(originalUrl)) {
        continueBtn.textContent = `Continue to ${blockedSite}`;
        continueBtn.hidden = false;
        closeTabBtn.hidden = true;
      }
      return;
    }

    unblockedBanner.hidden = true;
    continueBtn.hidden = true;
    closeTabBtn.hidden = false;

    const currentLevel = currentMood?.settings?.level === "easy" ? "easy" : "hard";
    applyLevelUI(currentLevel, currentMood?.name || moodName);
  } catch {
    // Ignore storage read issues on the interstitial page.
  }
}

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && (changes.activeMood || changes.moods)) {
      syncBlockedState();
    }
  });
}

syncBlockedState();
