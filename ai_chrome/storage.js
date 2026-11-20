/**
 * Core storage layer for the Mood Blocker Chrome Extension.
 * Uses `chrome.storage.local` exclusively so the popup, background service worker,
 * and future content scripts share a single source of truth.
 *
 * @module storage
 */

/**
 * @typedef {Object} MoodSettings
 * @property {boolean} grayscale - Whether to render pages in grayscale.
 * @property {boolean} hideShorts - Whether to hide short-form video feeds.
 * @property {number} timerMinutes - Focus timer duration in minutes.
 */

/**
 * @typedef {Object} Mood
 * @property {string} name - Human-readable display name of the mood.
 * @property {string[]} blockedSites - Deduplicated list of normalized domains.
 * @property {MoodSettings} settings - Feature toggles and timer configuration.
 */

/**
 * @typedef {Object} MoodStorageState
 * @property {string | null} activeMood - Currently active mood ID, or `null` if none.
 * @property {Record<string, Mood>} moods - Map of mood IDs to Mood definitions.
 */

/**
 * @typedef {Object} MoodUpdatePayload
 * @property {string} [name] - Updated display name.
 * @property {string[]} [addSites] - Raw URLs or domains to normalize and add.
 * @property {string[]} [removeSites] - Raw URLs or domains to normalize and remove.
 * @property {Partial<MoodSettings>} [settings] - Settings fields to merge.
 */

/** @type {Readonly<MoodSettings>} */
export const DEFAULT_SETTINGS = Object.freeze({
  grayscale: false,
  hideShorts: false,
  timerMinutes: 25,
  level: "hard",
});

/** @type {Readonly<Record<string, Mood>>} */
export const DEFAULT_MOODS = Object.freeze({
  focus: {
    name: "Focus",
    blockedSites: ["youtube.com", "reddit.com", "x.com"],
    settings: {
      grayscale: false,
      hideShorts: true,
      timerMinutes: 25,
      level: "hard",
    },
  },
  study: {
    name: "Study",
    blockedSites: [
      "youtube.com",
      "tiktok.com",
      "instagram.com",
      "reddit.com",
      "netflix.com",
    ],
    settings: {
      grayscale: true,
      hideShorts: true,
      timerMinutes: 45,
      level: "hard",
    },
  },
  creative: {
    name: "Creative",
    blockedSites: ["x.com", "reddit.com", "news.ycombinator.com"],
    settings: {
      grayscale: false,
      hideShorts: true,
      timerMinutes: 30,
      level: "hard",
    },
  },
});

const STORAGE_KEYS = ["activeMood", "moods"];
const VALID_LEVELS = new Set(["hard", "easy"]);
const HTTP_SCHEME_PATTERN = /^https?:\/\//i;
const HOST_PORT_PATTERN = /^[^:]+:\d+$/;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_PATTERN = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

/**
 * Checks whether a value is a plain key-value object.
 *
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Safely checks whether an object has an own property.
 *
 * @param {Record<string, any>} obj
 * @param {string} key
 * @returns {boolean}
 */
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Deep-clones a plain JSON-serializable value so callers cannot mutate shared defaults.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Reads and normalizes the raw storage state, handling uninitialized or partial storage safely.
 *
 * @returns {Promise<MoodStorageState>}
 */
async function readStorageState() {
  const raw = await chrome.storage.local.get(STORAGE_KEYS);
  const moods = isPlainObject(raw?.moods) ? cloneData(raw.moods) : {};
  const activeMood =
    typeof raw?.activeMood === "string" && hasOwn(moods, raw.activeMood)
      ? raw.activeMood
      : null;

  return { activeMood, moods };
}

/**
 * Merges and validates mood settings against a base settings object.
 * Preserves any extra custom setting keys for future extension milestones.
 *
 * @param {Partial<MoodSettings>} incoming
 * @param {MoodSettings} [base=DEFAULT_SETTINGS]
 * @returns {MoodSettings}
 */
function mergeSettings(incoming = {}, base = DEFAULT_SETTINGS) {
  if (!isPlainObject(incoming)) {
    throw new TypeError("Settings must be a plain object.");
  }

  const merged = {
    ...DEFAULT_SETTINGS,
    ...base,
    ...incoming,
  };

  if (typeof merged.grayscale !== "boolean") {
    throw new TypeError("settings.grayscale must be a boolean.");
  }

  if (typeof merged.hideShorts !== "boolean") {
    throw new TypeError("settings.hideShorts must be a boolean.");
  }

  const timer = Number(merged.timerMinutes);
  if (!Number.isFinite(timer) || timer < 0) {
    throw new TypeError("settings.timerMinutes must be a non-negative number.");
  }
  merged.timerMinutes = Math.round(timer);

  if (merged.level === undefined || merged.level === null) {
    merged.level = DEFAULT_SETTINGS.level;
  } else if (typeof merged.level !== "string" || !VALID_LEVELS.has(merged.level)) {
    throw new TypeError('settings.level must be "hard" or "easy".');
  }

  return merged;
}

/**
 * Normalizes and validates a list of site inputs, rejecting empty or invalid domains.
 *
 * @param {string[]} sites
 * @returns {string[]} Deduplicated array of clean domains.
 */
function normalizeAndValidateSites(sites) {
  if (!Array.isArray(sites)) {
    throw new TypeError("blockedSites must be an array of domain strings.");
  }

  const normalized = new Set();
  for (const rawSite of sites) {
    const cleaned = cleanDomain(rawSite);
    if (!cleaned) {
      throw new Error(`Invalid domain: "${String(rawSite ?? "").trim()}"`);
    }
    normalized.add(cleaned);
  }

  return Array.from(normalized);
}

/**
 * Normalizes any URL or domain string into a bare lowercase hostname.
 * Trims whitespace, lowercases, strips `http://`, `https://`, leading `www.`,
 * ports, paths, query strings, and hash fragments.
 *
 * @example
 * cleanDomain("https://www.YouTube.com/watch?v=123"); // "youtube.com"
 * cleanDomain("not a domain"); // null
 *
 * @param {string} input - Raw URL or domain entered by a user.
 * @returns {string | null} Normalized domain, or `null` if input is empty or invalid.
 */
export function cleanDomain(input) {
  if (typeof input !== "string") {
    return null;
  }

  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }

  const hasHttpScheme = HTTP_SCHEME_PATTERN.test(trimmed);
  if (!hasHttpScheme) {
    // Reject non-HTTP(S) schemes such as chrome://, file://, javascript:, or mailto:
    if (trimmed.includes("://")) {
      return null;
    }
    const authoritySegment = trimmed.split(/[/?#]/, 1)[0];
    if (authoritySegment.includes(":") && !HOST_PORT_PATTERN.test(authoritySegment)) {
      return null;
    }
  }

  const candidateUrl = hasHttpScheme ? trimmed : `https://${trimmed}`;

  let parsedUrl;
  try {
    parsedUrl = new URL(candidateUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return null;
  }

  let hostname = parsedUrl.hostname.toLowerCase().replace(/\.+$/, "");

  // Only strip a leading "www." when at least two labels remain (e.g. avoid turning "www.com" into "com").
  if (hostname.startsWith("www.") && hostname.slice(4).includes(".")) {
    hostname = hostname.slice(4);
  }

  if (!hostname || hostname.length > 253 || !hostname.includes(".")) {
    return null;
  }

  const labels = hostname.split(".");
  if (labels.length < 2) {
    return null;
  }

  const tld = labels[labels.length - 1];
  if (!TLD_PATTERN.test(tld)) {
    return null;
  }

  for (const label of labels) {
    if (!DNS_LABEL_PATTERN.test(label)) {
      return null;
    }
  }

  return hostname;
}

/**
 * Seeds default `"focus"`, `"study"`, and `"creative"` moods into `chrome.storage.local`
 * only if `moods` does not already exist in storage.
 *
 * @returns {Promise<MoodStorageState>} Current storage state after initialization.
 */
export async function initDefaultMoods() {
  const raw = await chrome.storage.local.get(STORAGE_KEYS);

  if (isPlainObject(raw?.moods)) {
    const activeMood =
      typeof raw.activeMood === "string" && hasOwn(raw.moods, raw.activeMood)
        ? raw.activeMood
        : null;

    if (raw.activeMood === undefined) {
      await chrome.storage.local.set({ activeMood });
    }

    return {
      activeMood,
      moods: cloneData(raw.moods),
    };
  }

  const seededState = {
    activeMood: null,
    moods: cloneData(DEFAULT_MOODS),
  };

  await chrome.storage.local.set(seededState);
  return cloneData(seededState);
}

/**
 * Creates and persists a new mood in `chrome.storage.local`.
 * Normalizes and deduplicates `blockedSites` and throws if `id` already exists.
 *
 * @param {string} id - Unique identifier for the new mood (e.g., `"deep-work"`).
 * @param {string} name - Human-readable display name.
 * @param {string[]} [blockedSites=[]] - Initial list of domains or URLs to block.
 * @param {Partial<MoodSettings>} [settings={}] - Optional settings overrides.
 * @returns {Promise<Mood>} The newly created mood object.
 * @throws {Error} If `id` or `name` is invalid, `id` already exists, or any domain is invalid.
 */
export async function saveNewMood(id, name, blockedSites = [], settings = {}) {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Mood ID must be a non-empty string.");
  }

  const cleanId = id.trim();

  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Mood name must be a non-empty string.");
  }

  const cleanName = name.trim();
  const state = await readStorageState();

  if (hasOwn(state.moods, cleanId)) {
    throw new Error(`Mood with ID "${cleanId}" already exists.`);
  }

  const newMood = {
    name: cleanName,
    blockedSites: normalizeAndValidateSites(blockedSites),
    settings: mergeSettings(settings, DEFAULT_SETTINGS),
  };

  state.moods[cleanId] = newMood;
  await chrome.storage.local.set({
    activeMood: state.activeMood,
    moods: state.moods,
  });

  return cloneData(newMood);
}

/**
 * Retrieves either a single mood by ID or the full `{ activeMood, moods }` state.
 * Gracefully handles empty or uninitialized storage without throwing.
 *
 * @param {string | null} [moodId=null] - Optional mood ID to look up.
 * @returns {Promise<Mood | null | MoodStorageState>}
 */
export async function getMoodData(moodId = null) {
  const state = await readStorageState();

  if (moodId !== null && moodId !== undefined && moodId !== "") {
    if (typeof moodId !== "string" || !hasOwn(state.moods, moodId)) {
      return null;
    }
    return cloneData(state.moods[moodId]);
  }

  return state;
}

/**
 * Updates an existing mood's name, settings, and blocked websites.
 * Normalizes and deduplicates added sites; rejects empty or invalid domains.
 *
 * @param {string} moodId - ID of the mood to update.
 * @param {MoodUpdatePayload} [updates={}] - Fields to update.
 * @returns {Promise<Mood>} The updated mood object.
 * @throws {Error} If the mood does not exist or any provided input is invalid.
 */
export async function updateMood(
  moodId,
  { name, addSites = [], removeSites = [], settings } = {}
) {
  if (typeof moodId !== "string" || !moodId.trim()) {
    throw new Error("Mood ID must be a non-empty string.");
  }

  const state = await readStorageState();

  if (!hasOwn(state.moods, moodId)) {
    throw new Error(`Mood "${moodId}" does not exist.`);
  }

  const existing = state.moods[moodId];
  let updatedName = existing.name;

  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) {
      throw new Error("Mood name must be a non-empty string.");
    }
    updatedName = name.trim();
  }

  const existingSites = Array.isArray(existing.blockedSites)
    ? existing.blockedSites
    : [];
  const siteSet = new Set(existingSites);

  const sitesToAdd = normalizeAndValidateSites(addSites);
  for (const domain of sitesToAdd) {
    siteSet.add(domain);
  }

  if (!Array.isArray(removeSites)) {
    throw new TypeError("removeSites must be an array of domain strings.");
  }
  for (const rawSite of removeSites) {
    if (typeof rawSite !== "string") {
      continue;
    }
    const normalized = cleanDomain(rawSite) ?? rawSite.trim().toLowerCase();
    if (normalized) {
      siteSet.delete(normalized);
    }
  }

  const baseSettings = isPlainObject(existing.settings)
    ? existing.settings
    : DEFAULT_SETTINGS;
  const updatedSettings =
    settings !== undefined
      ? mergeSettings(settings, baseSettings)
      : mergeSettings({}, baseSettings);

  const updatedMood = {
    name: updatedName,
    blockedSites: Array.from(siteSet),
    settings: updatedSettings,
  };

  state.moods[moodId] = updatedMood;
  await chrome.storage.local.set({ moods: state.moods });

  return cloneData(updatedMood);
}

/**
 * Deletes a mood from `chrome.storage.local`.
 * If the deleted mood was currently active, resets `activeMood` to `null`.
 *
 * @param {string} moodId - ID of the mood to remove.
 * @returns {Promise<boolean>} `true` if a mood was deleted, `false` if it did not exist.
 */
export async function deleteMood(moodId) {
  if (typeof moodId !== "string" || !moodId.trim()) {
    return false;
  }

  const state = await readStorageState();

  if (!hasOwn(state.moods, moodId)) {
    return false;
  }

  delete state.moods[moodId];
  const nextActiveMood = state.activeMood === moodId ? null : state.activeMood;

  await chrome.storage.local.set({
    activeMood: nextActiveMood,
    moods: state.moods,
  });

  return true;
}

/**
 * Activates a mood by ID or deactivates the current mood when passed `null`.
 *
 * @param {string | null} moodId - Target mood ID, or `null` to deactivate.
 * @returns {Promise<string | null>} The resulting `activeMood` value.
 * @throws {Error} If a non-null `moodId` does not match an existing mood.
 */
export async function setActiveMood(moodId) {
  if (moodId === null) {
    await chrome.storage.local.set({ activeMood: null });
    return null;
  }

  if (typeof moodId !== "string" || !moodId.trim()) {
    throw new Error("Mood ID must be a valid string or null.");
  }

  const state = await readStorageState();

  if (!hasOwn(state.moods, moodId)) {
    throw new Error(`Cannot activate unknown mood "${moodId}".`);
  }

  await chrome.storage.local.set({ activeMood: moodId });
  return moodId;
}
