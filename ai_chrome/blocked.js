/**
 * Controller for blocked.html.
 * Displays the blocked domain and active mood from query parameters, and
 * reveals a "Continue to site" action automatically if the user deactivates
 * the mood or unblocks the domain.
 */

const params = new URLSearchParams(window.location.search);
const blockedSite = params.get("site") || "this website";
const moodName = params.get("mood") || "Focus";
const timerMinutes = Number(params.get("timer"));
const originalUrl = params.get("from") || "";

const moodLabelEl = document.getElementById("mood-label");
const blockedSiteEl = document.getElementById("blocked-site");
const timerNoteEl = document.getElementById("timer-note");
const goBackBtn = document.getElementById("go-back-btn");
const closeTabBtn = document.getElementById("close-tab-btn");
const continueBtn = document.getElementById("continue-btn");
const unblockedBanner = document.getElementById("unblocked-banner");

moodLabelEl.textContent = `${moodName} Mood Active`;
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

/**
 * Checks whether the blocked site is still blocked by the currently active mood.
 */
async function checkIfStillBlocked() {
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
      unblockedBanner.hidden = false;
      if (isSafeHttpUrl(originalUrl)) {
        continueBtn.textContent = `Continue to ${blockedSite}`;
        continueBtn.hidden = false;
        closeTabBtn.hidden = true;
      }
    }
  } catch {
    // Ignore storage read issues on the interstitial page.
  }
}

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && (changes.activeMood || changes.moods)) {
      checkIfStillBlocked();
    }
  });
}

checkIfStillBlocked();
