/**
 * Popup controller for the Mood Blocker Chrome Extension.
 * Wires the popup UI directly to `src/storage.js`.
 */

import {
  cleanDomain,
  initDefaultMoods,
  saveNewMood,
  getMoodData,
  updateMood,
  deleteMood,
  setActiveMood,
} from "./storage.js";

const elements = {
  activeStatusText: document.getElementById("active-status-text"),
  deactivateBtn: document.getElementById("deactivate-btn"),
  moodPills: document.getElementById("mood-pills"),
  createPanel: document.getElementById("create-mood-panel"),
  createForm: document.getElementById("create-mood-form"),
  cancelCreateBtn: document.getElementById("cancel-create-btn"),
  newMoodName: document.getElementById("new-mood-name"),
  newMoodId: document.getElementById("new-mood-id"),
  newMoodSites: document.getElementById("new-mood-sites"),
  createMoodError: document.getElementById("create-mood-error"),
  moodEditor: document.getElementById("mood-editor"),
  selectedMoodName: document.getElementById("selected-mood-name"),
  selectedMoodIdBadge: document.getElementById("selected-mood-id-badge"),
  selectedMoodState: document.getElementById("selected-mood-state"),
  toggleActiveBtn: document.getElementById("toggle-active-btn"),
  deleteMoodBtn: document.getElementById("delete-mood-btn"),
  siteCountBadge: document.getElementById("site-count-badge"),
  addSiteForm: document.getElementById("add-site-form"),
  siteInput: document.getElementById("site-input"),
  siteError: document.getElementById("site-error"),
  blockedSitesList: document.getElementById("blocked-sites-list"),
  sitesEmptyState: document.getElementById("sites-empty-state"),
  settingGrayscale: document.getElementById("setting-grayscale"),
  settingHideShorts: document.getElementById("setting-hide-shorts"),
  settingTimer: document.getElementById("setting-timer"),
  levelHardBtn: document.getElementById("level-hard-btn"),
  levelEasyBtn: document.getElementById("level-easy-btn"),
  settingLevelDesc: document.getElementById("setting-level-desc"),
  emptyMoodsState: document.getElementById("empty-moods-state"),
  emptyCreateBtn: document.getElementById("empty-create-btn"),
  restoreDefaultsBtn: document.getElementById("restore-defaults-btn"),
  aiPromptForm: document.getElementById("ai-prompt-form"),
  aiPromptInput: document.getElementById("ai-prompt-input"),
  aiSuggestBtn: document.getElementById("ai-suggest-btn"),
  aiError: document.getElementById("ai-error"),
  aiSuggestionsBox: document.getElementById("ai-suggestions-box"),
  aiSuggestionsTitle: document.getElementById("ai-suggestions-title"),
  aiToggleAllBtn: document.getElementById("ai-toggle-all-btn"),
  aiSuggestionsList: document.getElementById("ai-suggestions-list"),
  aiDismissBtn: document.getElementById("ai-dismiss-btn"),
  aiSaveBtn: document.getElementById("ai-save-btn"),
  toast: document.getElementById("toast"),
};

/** @type {{ activeMood: string | null, moods: Record<string, import("./storage.js").Mood> }} */
let appState = { activeMood: null, moods: {} };
/** @type {string | null} */
let selectedMoodId = null;
let idManuallyEdited = false;
let pendingDeleteMoodId = null;
let deleteConfirmTimeout = null;
let toastTimeout = null;
/** @type {string[]} */
let aiSuggestedDomains = [];
/** @type {Set<string>} */
let aiSelectedDomains = new Set();
let aiRequestInFlight = false;

/**
 * Converts a display name into a clean lowercase slug ID.
 *
 * @param {string} name
 * @returns {string}
 */
function slugifyMoodId(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Displays a transient notification banner at the bottom of the popup.
 *
 * @param {string} message
 * @param {boolean} [isError=false]
 */
function showToast(message, isError = false) {
  if (toastTimeout) {
    clearTimeout(toastTimeout);
  }
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.hidden = false;
  toastTimeout = setTimeout(() => {
    elements.toast.hidden = true;
  }, 2600);
}

/**
 * Shows or hides an inline form error element.
 *
 * @param {HTMLElement} el
 * @param {string | null} message
 */
function setInlineError(el, message) {
  if (!message) {
    el.textContent = "";
    el.hidden = true;
    return;
  }
  el.textContent = message;
  el.hidden = false;
}

/**
 * Resets the two-step inline delete confirmation state.
 */
function resetDeleteConfirm() {
  pendingDeleteMoodId = null;
  if (deleteConfirmTimeout) {
    clearTimeout(deleteConfirmTimeout);
    deleteConfirmTimeout = null;
  }
  elements.deleteMoodBtn.textContent = "Delete";
  elements.deleteMoodBtn.classList.remove("btn-danger-confirm");
  elements.deleteMoodBtn.classList.add("btn-danger-ghost");
}

/**
 * Picks a valid `selectedMoodId` after state reloads.
 */
function reconcileSelection() {
  const moodIds = Object.keys(appState.moods);
  if (moodIds.length === 0) {
    selectedMoodId = null;
    return;
  }

  if (selectedMoodId && Object.prototype.hasOwnProperty.call(appState.moods, selectedMoodId)) {
    return;
  }

  selectedMoodId = appState.activeMood ?? moodIds[0];
}

/**
 * Renders the header status indicator and quick deactivate button.
 */
function renderHeader() {
  const activeId = appState.activeMood;
  const activeMood = activeId ? appState.moods[activeId] : null;

  if (activeMood) {
    elements.activeStatusText.textContent = `Active: ${activeMood.name}`;
    elements.activeStatusText.classList.add("is-active");
    elements.deactivateBtn.hidden = false;
  } else {
    elements.activeStatusText.textContent = "No active mood";
    elements.activeStatusText.classList.remove("is-active");
    elements.deactivateBtn.hidden = true;
  }
}

/**
 * Renders the mood selector strip plus the "+ New" trigger button.
 */
function renderMoodPills() {
  elements.moodPills.textContent = "";

  const moodEntries = Object.entries(appState.moods);
  for (const [id, mood] of moodEntries) {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "tab";
    button.className = "mood-pill";
    button.dataset.moodId = id;
    button.setAttribute("aria-selected", String(id === selectedMoodId));

    if (id === selectedMoodId) {
      button.classList.add("is-selected");
    }

    if (id === appState.activeMood) {
      const dot = document.createElement("span");
      dot.className = "mood-pill-dot";
      dot.setAttribute("aria-hidden", "true");
      button.appendChild(dot);
    }

    const label = document.createElement("span");
    label.textContent = mood.name;
    button.appendChild(label);

    button.addEventListener("click", () => {
      selectedMoodId = id;
      resetDeleteConfirm();
      setInlineError(elements.siteError, null);
      render();
    });

    elements.moodPills.appendChild(button);
  }

  const newButton = document.createElement("button");
  newButton.type = "button";
  newButton.id = "open-create-mood-btn";
  newButton.className = "mood-pill mood-pill-new";
  newButton.textContent = "+ New";
  newButton.addEventListener("click", () => toggleCreatePanel(true));
  elements.moodPills.appendChild(newButton);
}

/**
 * Renders the currently selected mood's details, blocked websites, and settings.
 */
function renderEditor() {
  if (!selectedMoodId || !appState.moods[selectedMoodId]) {
    elements.moodEditor.hidden = true;
    elements.emptyMoodsState.hidden = false;
    return;
  }

  elements.moodEditor.hidden = false;
  elements.emptyMoodsState.hidden = true;

  const mood = appState.moods[selectedMoodId];
  const isActive = appState.activeMood === selectedMoodId;

  elements.selectedMoodName.textContent = mood.name;
  elements.selectedMoodIdBadge.textContent = selectedMoodId;

  if (isActive) {
    elements.selectedMoodState.textContent = "Currently active";
    elements.selectedMoodState.classList.add("is-active");
    elements.toggleActiveBtn.textContent = "Active";
    elements.toggleActiveBtn.classList.remove("btn-primary");
    elements.toggleActiveBtn.classList.add("btn-active-state");
    elements.toggleActiveBtn.title = "Click to deactivate this mood";
  } else {
    elements.selectedMoodState.textContent = "Ready to activate";
    elements.selectedMoodState.classList.remove("is-active");
    elements.toggleActiveBtn.textContent = "Activate";
    elements.toggleActiveBtn.classList.add("btn-primary");
    elements.toggleActiveBtn.classList.remove("btn-active-state");
    elements.toggleActiveBtn.title = "Click to activate this mood";
  }

  // Render blocked sites
  const sites = Array.isArray(mood.blockedSites) ? mood.blockedSites : [];
  elements.siteCountBadge.textContent = String(sites.length);
  elements.blockedSitesList.textContent = "";
  elements.sitesEmptyState.hidden = sites.length > 0;

  for (const domain of sites) {
    const li = document.createElement("li");
    li.className = "site-item";

    const domainText = document.createElement("span");
    domainText.className = "site-domain";
    domainText.textContent = domain;
    domainText.title = domain;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "site-remove-btn";
    removeBtn.textContent = "\u00d7";
    removeBtn.setAttribute("aria-label", `Remove ${domain}`);
    removeBtn.addEventListener("click", () => handleRemoveSite(domain));

    li.append(domainText, removeBtn);
    elements.blockedSitesList.appendChild(li);
  }

  // Render settings
  const settings = mood.settings ?? {
    grayscale: false,
    hideShorts: false,
    timerMinutes: 25,
    level: "hard",
  };
  const level = settings.level === "easy" ? "easy" : "hard";
  elements.levelHardBtn.classList.toggle("is-active", level === "hard");
  elements.levelHardBtn.setAttribute("aria-checked", String(level === "hard"));
  elements.levelEasyBtn.classList.toggle("is-active", level === "easy");
  elements.levelEasyBtn.setAttribute("aria-checked", String(level === "easy"));
  elements.settingLevelDesc.textContent =
    level === "hard"
      ? "Hard: blocks link clicks with animation"
      : "Easy: reminder page with option to continue";

  elements.settingGrayscale.checked = Boolean(settings.grayscale);
  elements.settingHideShorts.checked = Boolean(settings.hideShorts);
  elements.settingTimer.value = String(settings.timerMinutes ?? 25);

  renderAiSuggestions();
}

/**
 * Renders the AI-suggested websites checklist for user approval before saving.
 */
function renderAiSuggestions() {
  if (!selectedMoodId || !appState.moods[selectedMoodId] || aiSuggestedDomains.length === 0) {
    elements.aiSuggestionsBox.hidden = true;
    elements.aiSuggestionsList.textContent = "";
    return;
  }

  const mood = appState.moods[selectedMoodId];
  const existingSet = new Set(Array.isArray(mood.blockedSites) ? mood.blockedSites : []);

  // Remove any already-blocked domains from the selectable set
  for (const domain of Array.from(aiSelectedDomains)) {
    if (existingSet.has(domain)) {
      aiSelectedDomains.delete(domain);
    }
  }

  const selectableDomains = aiSuggestedDomains.filter((d) => !existingSet.has(d));
  elements.aiSuggestionsBox.hidden = false;
  elements.aiSuggestionsTitle.textContent = `Suggested sites (${aiSuggestedDomains.length})`;
  elements.aiSuggestionsList.textContent = "";

  for (const domain of aiSuggestedDomains) {
    const isExisting = existingSet.has(domain);
    const li = document.createElement("li");
    li.className = isExisting
      ? "ai-suggestion-item is-existing"
      : "ai-suggestion-item";

    const label = document.createElement("label");
    label.className = "ai-suggestion-label";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "ai-suggestion-checkbox";
    checkbox.disabled = isExisting;
    checkbox.checked = !isExisting && aiSelectedDomains.has(domain);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        aiSelectedDomains.add(domain);
      } else {
        aiSelectedDomains.delete(domain);
      }
      updateAiSuggestionControls(selectableDomains, mood.name);
    });

    const domainSpan = document.createElement("span");
    domainSpan.className = "site-domain";
    domainSpan.textContent = domain;
    domainSpan.title = domain;

    label.append(checkbox, domainSpan);
    li.appendChild(label);

    if (isExisting) {
      const tag = document.createElement("span");
      tag.className = "ai-suggestion-tag";
      tag.textContent = "Already blocked";
      li.appendChild(tag);
    }

    elements.aiSuggestionsList.appendChild(li);
  }

  updateAiSuggestionControls(selectableDomains, mood.name);
}

/**
 * Updates the toggle-all link and save button label/disabled state.
 *
 * @param {string[]} selectableDomains
 * @param {string} moodName
 */
function updateAiSuggestionControls(selectableDomains, moodName) {
  const selectedCount = selectableDomains.filter((d) => aiSelectedDomains.has(d)).length;

  elements.aiToggleAllBtn.hidden = selectableDomains.length === 0;
  elements.aiToggleAllBtn.textContent =
    selectedCount === selectableDomains.length ? "Clear selection" : "Select all";

  elements.aiSaveBtn.disabled = selectedCount === 0;
  if (selectableDomains.length === 0) {
    elements.aiSaveBtn.textContent = `All already in ${moodName}`;
  } else if (selectedCount === 0) {
    elements.aiSaveBtn.textContent = "Select sites to block";
  } else {
    elements.aiSaveBtn.textContent = `Block ${selectedCount} in ${moodName}`;
  }
}

/**
 * Full UI re-render from `appState`.
 */
function render() {
  reconcileSelection();
  renderHeader();
  renderMoodPills();
  renderEditor();
}

/**
 * Reloads storage state from `chrome.storage.local` and updates the UI.
 */
async function refreshState() {
  appState = await getMoodData();
  render();
}

/**
 * Shows or hides the inline "Create New Mood" form.
 *
 * @param {boolean} show
 */
function toggleCreatePanel(show) {
  elements.createPanel.hidden = !show;
  setInlineError(elements.createMoodError, null);
  if (show) {
    elements.createForm.reset();
    idManuallyEdited = false;
    elements.newMoodName.focus();
  }
}

/**
 * Handles activating or deactivating the selected mood.
 */
async function handleToggleActive() {
  if (!selectedMoodId) {
    return;
  }

  try {
    const isCurrentlyActive = appState.activeMood === selectedMoodId;
    if (isCurrentlyActive) {
      await setActiveMood(null);
      showToast("Mood deactivated");
    } else {
      const moodName = appState.moods[selectedMoodId]?.name ?? selectedMoodId;
      await setActiveMood(selectedMoodId);
      showToast(`Activated "${moodName}"`);
    }
    await refreshState();
  } catch (error) {
    showToast(error.message, true);
  }
}

/**
 * Handles top-bar quick deactivation.
 */
async function handleDeactivate() {
  try {
    await setActiveMood(null);
    showToast("Mood deactivated");
    await refreshState();
  } catch (error) {
    showToast(error.message, true);
  }
}

/**
 * Handles adding a new website to the currently selected mood.
 *
 * @param {SubmitEvent} event
 */
async function handleAddSite(event) {
  event.preventDefault();
  if (!selectedMoodId) {
    return;
  }

  const rawInput = elements.siteInput.value;
  const cleaned = cleanDomain(rawInput);

  if (!cleaned) {
    setInlineError(
      elements.siteError,
      "Enter a valid domain or URL (e.g. youtube.com)."
    );
    return;
  }

  const currentSites = appState.moods[selectedMoodId]?.blockedSites ?? [];
  if (currentSites.includes(cleaned)) {
    setInlineError(elements.siteError, `${cleaned} is already in this mood.`);
    return;
  }

  setInlineError(elements.siteError, null);

  try {
    await updateMood(selectedMoodId, { addSites: [rawInput] });
    elements.siteInput.value = "";
    showToast(`Added ${cleaned}`);
    await refreshState();
  } catch (error) {
    setInlineError(elements.siteError, error.message);
  }
}

/**
 * Handles removing a website from the currently selected mood.
 *
 * @param {string} domain
 */
async function handleRemoveSite(domain) {
  if (!selectedMoodId) {
    return;
  }

  try {
    await updateMood(selectedMoodId, { removeSites: [domain] });
    showToast(`Removed ${domain}`);
    await refreshState();
  } catch (error) {
    showToast(error.message, true);
  }
}

/**
 * Handles saving a partial settings update for the selected mood.
 *
 * @param {Partial<import("../src/storage.js").MoodSettings>} partialSettings
 */
async function handleSettingsChange(partialSettings) {
  if (!selectedMoodId) {
    return;
  }

  try {
    await updateMood(selectedMoodId, { settings: partialSettings });
    await refreshState();
  } catch (error) {
    showToast(error.message, true);
    await refreshState();
  }
}

/**
 * Handles two-step deletion of the currently selected mood without blocking dialogs.
 */
async function handleDeleteMood() {
  if (!selectedMoodId) {
    return;
  }

  if (pendingDeleteMoodId !== selectedMoodId) {
    pendingDeleteMoodId = selectedMoodId;
    elements.deleteMoodBtn.textContent = "Confirm?";
    elements.deleteMoodBtn.classList.remove("btn-danger-ghost");
    elements.deleteMoodBtn.classList.add("btn-danger-confirm");

    deleteConfirmTimeout = setTimeout(resetDeleteConfirm, 3000);
    return;
  }

  const moodToDelete = selectedMoodId;
  const moodName = appState.moods[moodToDelete]?.name ?? moodToDelete;
  resetDeleteConfirm();

  try {
    await deleteMood(moodToDelete);
    selectedMoodId = null;
    showToast(`Deleted "${moodName}"`);
    await refreshState();
  } catch (error) {
    showToast(error.message, true);
  }
}

/**
 * Handles submitting the "Create New Mood" form.
 *
 * @param {SubmitEvent} event
 */
async function handleCreateMood(event) {
  event.preventDefault();

  const name = elements.newMoodName.value.trim();
  const id = elements.newMoodId.value.trim();
  const rawSitesText = elements.newMoodSites.value.trim();

  if (!name) {
    setInlineError(elements.createMoodError, "Mood name is required.");
    return;
  }

  if (!id) {
    setInlineError(elements.createMoodError, "Mood ID is required.");
    return;
  }

  const starterSites = rawSitesText
    ? rawSitesText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  try {
    await saveNewMood(id, name, starterSites);
    selectedMoodId = id;
    toggleCreatePanel(false);
    showToast(`Created "${name}"`);
    await refreshState();
  } catch (error) {
    setInlineError(elements.createMoodError, error.message);
  }
}

/**
 * Restores default presets if all moods were deleted.
 */
async function handleRestoreDefaults() {
  try {
    await chrome.storage.local.remove("moods");
    await initDefaultMoods();
    selectedMoodId = null;
    showToast("Restored default moods");
    await refreshState();
  } catch (error) {
    showToast(error.message, true);
  }
}

/**
 * Clears the current AI suggestion list and inline errors.
 */
function clearAiSuggestions() {
  aiSuggestedDomains = [];
  aiSelectedDomains.clear();
  setInlineError(elements.aiError, null);
  renderAiSuggestions();
}

/**
 * Sends the user's description to the background worker (`ASK_AI`) and displays
 * normalized domain suggestions for user approval.
 *
 * @param {SubmitEvent} event
 */
async function handleAskAI(event) {
  event.preventDefault();
  if (!selectedMoodId || aiRequestInFlight) {
    return;
  }

  const promptText = elements.aiPromptInput.value.trim();
  if (!promptText) {
    setInlineError(
      elements.aiError,
      "Describe the websites or distractions you want to block."
    );
    return;
  }

  setInlineError(elements.aiError, null);
  aiRequestInFlight = true;
  elements.aiSuggestBtn.disabled = true;
  elements.aiSuggestBtn.textContent = "Thinking...";
  elements.aiPromptInput.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "ASK_AI",
      message: promptText,
    });

    if (!response) {
      throw new Error("No response from background service worker.");
    }

    if (response.error) {
      throw new Error(response.error);
    }

    const rawList = Array.isArray(response.answer) ? response.answer : [];
    const normalized = Array.from(
      new Set(rawList.map((item) => cleanDomain(item)).filter(Boolean))
    );

    if (normalized.length === 0) {
      clearAiSuggestions();
      setInlineError(
        elements.aiError,
        "No websites were suggested for that description. Try adding a bit more detail."
      );
      return;
    }

    const existingSites = new Set(
      appState.moods[selectedMoodId]?.blockedSites ?? []
    );
    aiSuggestedDomains = normalized;
    aiSelectedDomains = new Set(
      normalized.filter((domain) => !existingSites.has(domain))
    );
    renderAiSuggestions();
  } catch (error) {
    clearAiSuggestions();
    setInlineError(
      elements.aiError,
      error?.message || "Failed to get AI suggestions."
    );
  } finally {
    aiRequestInFlight = false;
    elements.aiSuggestBtn.disabled = false;
    elements.aiSuggestBtn.textContent = "Suggest Sites";
    elements.aiPromptInput.disabled = false;
  }
}

/**
 * Toggles selecting or clearing all selectable AI-suggested domains.
 */
function handleToggleAllAiSuggestions() {
  if (!selectedMoodId || !appState.moods[selectedMoodId]) {
    return;
  }

  const existingSet = new Set(appState.moods[selectedMoodId].blockedSites ?? []);
  const selectable = aiSuggestedDomains.filter((d) => !existingSet.has(d));
  const allSelected =
    selectable.length > 0 && selectable.every((d) => aiSelectedDomains.has(d));

  if (allSelected) {
    aiSelectedDomains.clear();
  } else {
    aiSelectedDomains = new Set(selectable);
  }

  renderAiSuggestions();
}

/**
 * Saves all user-approved AI-suggested domains into the currently selected mood.
 */
async function handleSaveAiSuggestions() {
  if (!selectedMoodId || !appState.moods[selectedMoodId]) {
    return;
  }

  const existingSet = new Set(appState.moods[selectedMoodId].blockedSites ?? []);
  const domainsToAdd = aiSuggestedDomains.filter(
    (domain) => !existingSet.has(domain) && aiSelectedDomains.has(domain)
  );

  if (domainsToAdd.length === 0) {
    return;
  }

  const moodName = appState.moods[selectedMoodId].name;

  try {
    await updateMood(selectedMoodId, { addSites: domainsToAdd });
    elements.aiPromptInput.value = "";
    clearAiSuggestions();
    showToast(
      `Added ${domainsToAdd.length} site${domainsToAdd.length === 1 ? "" : "s"} to "${moodName}"`
    );
    await refreshState();
  } catch (error) {
    setInlineError(elements.aiError, error.message);
  }
}

/**
 * Attaches DOM and Chrome storage listeners, then loads initial state.
 */
async function bootstrap() {
  elements.deactivateBtn.addEventListener("click", handleDeactivate);
  elements.toggleActiveBtn.addEventListener("click", handleToggleActive);
  elements.deleteMoodBtn.addEventListener("click", handleDeleteMood);
  elements.addSiteForm.addEventListener("submit", handleAddSite);
  elements.cancelCreateBtn.addEventListener("click", () => toggleCreatePanel(false));
  elements.createForm.addEventListener("submit", handleCreateMood);
  elements.emptyCreateBtn.addEventListener("click", () => toggleCreatePanel(true));
  elements.restoreDefaultsBtn.addEventListener("click", handleRestoreDefaults);
  elements.aiPromptForm.addEventListener("submit", handleAskAI);
  elements.aiToggleAllBtn.addEventListener("click", handleToggleAllAiSuggestions);
  elements.aiDismissBtn.addEventListener("click", clearAiSuggestions);
  elements.aiSaveBtn.addEventListener("click", handleSaveAiSuggestions);

  elements.aiPromptInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      elements.aiPromptForm.requestSubmit();
    }
  });

  elements.newMoodName.addEventListener("input", () => {
    if (!idManuallyEdited) {
      elements.newMoodId.value = slugifyMoodId(elements.newMoodName.value);
    }
  });

  elements.newMoodId.addEventListener("input", () => {
    idManuallyEdited = elements.newMoodId.value.trim().length > 0;
  });

  elements.levelHardBtn.addEventListener("click", () => {
    handleSettingsChange({ level: "hard" });
    showToast("Level set to Hard");
  });

  elements.levelEasyBtn.addEventListener("click", () => {
    handleSettingsChange({ level: "easy" });
    showToast("Level set to Easy");
  });

  elements.settingGrayscale.addEventListener("change", (event) => {
    handleSettingsChange({ grayscale: event.target.checked });
  });

  elements.settingHideShorts.addEventListener("change", (event) => {
    handleSettingsChange({ hideShorts: event.target.checked });
  });

  elements.settingTimer.addEventListener("change", (event) => {
    const rawValue = Number(event.target.value);
    const clamped = Number.isFinite(rawValue)
      ? Math.min(480, Math.max(0, Math.round(rawValue)))
      : 25;
    event.target.value = String(clamped);
    handleSettingsChange({ timerMinutes: clamped });
  });

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && (changes.activeMood || changes.moods)) {
        refreshState();
      }
    });
  }

  try {
    // Ensures defaults exist even if the popup opens before onInstalled completes.
    await initDefaultMoods();
    await refreshState();
  } catch (error) {
    showToast(`Storage error: ${error.message}`, true);
  }
}

bootstrap();
