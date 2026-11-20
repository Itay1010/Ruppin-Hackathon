/**
 * Controller for blocked.html.
 * Supports both Hard mode (strict block) and Easy mode (shows a "Continue anyway"
 * button that requests a per-tab bypass from background.js before navigating),
 * and displays a live Focus Timer countdown when active.
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

let liveTimerEndAt = null;
let countdownInterval = null;

blockedSiteEl.textContent = blockedSite;

if (Number.isFinite(timerMinutes) && timerMinutes > 0) {
  timerNoteEl.textContent = `Focus timer: ${timerMinutes} min`;
  timerNoteEl.hidden = false;
}

/**
 * Formats remaining milliseconds as MM:SS (or H:MM:SS).
 *
 * @param {number} remainingMs
 * @returns {string}
 */
function formatRemaining(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/**
 * Updates the live countdown readout and refreshes state if the timer expired.
 */
function updateCountdownDisplay() {
  if (!liveTimerEndAt) {
    return;
  }

  const remaining = liveTimerEndAt - Date.now();
  if (remaining <= 0) {
    stopCountdown();
    timerNoteEl.hidden = true;
    syncBlockedState();
    return;
  }

  timerNoteEl.textContent = `Blocking ends in ${formatRemaining(remaining)}`;
  timerNoteEl.hidden = false;
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function startCountdown(timerEndAt) {
  stopCountdown();
  liveTimerEndAt = timerEndAt;
  if (!liveTimerEndAt) {
    timerNoteEl.hidden = true;
    return;
  }
  updateCountdownDisplay();
  countdownInterval = setInterval(updateCountdownDisplay, 1000);
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

    await syncBlockedState();
  } catch {
    await syncBlockedState();
  } finally {
    continueAnywayBtn.disabled = false;
    continueAnywayBtn.textContent = `Continue to ${blockedSite} anyway`;
  }
});

/**
 * Checks live storage state to reflect whether the site is still blocked,
 * whether the timer expired, and whether the active mood is in Hard or Easy mode.
 */
async function syncBlockedState() {
  if (!chrome?.storage?.local) {
    return;
  }

  try {
    const { activeMood, moods, timerEndAt } = await chrome.storage.local.get([
      "activeMood",
      "moods",
      "timerEndAt",
    ]);

    const timerExpired =
      Boolean(activeMood) &&
      typeof timerEndAt === "number" &&
      Date.now() >= timerEndAt;

    if (timerExpired) {
      await chrome.storage.local.set({ activeMood: null, timerEndAt: null });
    }

    const effectiveActiveMood = timerExpired ? null : activeMood;
    const currentMood =
      effectiveActiveMood && moods ? moods[effectiveActiveMood] : null;
    const blockedList = Array.isArray(currentMood?.blockedSites)
      ? currentMood.blockedSites
      : [];
    const stillBlocked = blockedList.includes(blockedSite.toLowerCase());

    if (!stillBlocked) {
      stopCountdown();
      timerNoteEl.hidden = true;
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

    const currentLevel =
      currentMood?.settings?.level === "easy" ? "easy" : "hard";
    applyLevelUI(currentLevel, currentMood?.name || moodName);

    const validEndAt =
      typeof timerEndAt === "number" && timerEndAt > Date.now()
        ? timerEndAt
        : null;
    startCountdown(validEndAt);
  } catch {
    // Ignore storage read issues on the interstitial page.
  }
}

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      areaName === "local" &&
      (changes.activeMood || changes.moods || changes.timerEndAt)
    ) {
      syncBlockedState();
    }
  });
}

syncBlockedState();
