/**
 * Minimal user account store, following the same in-memory + async-persist
 * pattern as store.js. Passwords are never stored or logged in plaintext -
 * only bcrypt hashes.
 */
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DATA_DIR = path.join(__dirname, "..", "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

function loadFromDisk() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) return { users: {} };
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf-8");
    if (!raw.trim()) return { users: {} };
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[userStore] Failed to parse ${USERS_FILE}, starting fresh:`, err.message);
    return { users: {} };
  }
}

let memory = loadFromDisk();
let writeQueue = Promise.resolve();

function persist() {
  const snapshot = JSON.stringify(memory, null, 2);
  writeQueue = writeQueue.then(
    () =>
      new Promise((resolve) => {
        fs.writeFile(USERS_FILE, snapshot, (err) => {
          if (err) console.error("[userStore] Failed to persist to disk:", err.message);
          resolve();
        });
      })
  );
  return writeQueue;
}

function hasAnyUsers() {
  return Object.keys(memory.users).length > 0;
}

function findByUsername(username) {
  return memory.users[username.toLowerCase()] || null;
}

async function createUser(username, plaintextPassword) {
  const key = username.toLowerCase();
  if (memory.users[key]) {
    throw new Error(`User "${username}" already exists.`);
  }
  const passwordHash = await bcrypt.hash(plaintextPassword, 10);
  memory.users[key] = { username, passwordHash, createdAt: new Date().toISOString() };
  await persist();
  return memory.users[key];
}

async function verifyPassword(username, plaintextPassword) {
  const user = findByUsername(username);
  if (!user) return false;
  return bcrypt.compare(plaintextPassword, user.passwordHash);
}

async function changePassword(username, newPlaintextPassword) {
  const user = findByUsername(username);
  if (!user) throw new Error(`User "${username}" not found.`);
  user.passwordHash = await bcrypt.hash(newPlaintextPassword, 10);
  await persist();
}

module.exports = { hasAnyUsers, findByUsername, createUser, verifyPassword, changePassword };
