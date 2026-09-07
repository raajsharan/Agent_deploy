/**
 * Persists config overrides made from the Settings UI, on top of whatever
 * backend/.env provides. Same in-memory + async-persist pattern as
 * store.js/userStore.js. Kept in backend/data/ (gitignored) since some
 * overridden fields are secrets (API keys, passwords).
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings-overrides.json");

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    console.error(`[settingsStore] Failed to parse ${SETTINGS_FILE}, ignoring saved overrides:`, err.message);
    return {};
  }
}

let overrides = load();
let writeQueue = Promise.resolve();

function get() {
  return overrides;
}

function save(next) {
  overrides = next;
  const snapshot = JSON.stringify(overrides, null, 2);
  writeQueue = writeQueue.then(
    () =>
      new Promise((resolve) => {
        fs.writeFile(SETTINGS_FILE, snapshot, (err) => {
          if (err) console.error("[settingsStore] Failed to persist to disk:", err.message);
          resolve();
        });
      })
  );
  return writeQueue;
}

module.exports = { get, save };
