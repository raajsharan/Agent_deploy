/**
 * Minimal JSON-file-backed store.
 *
 * This app's data (a server list + a rolling window of deployment jobs) is
 * small and low-write-frequency, so a real database is unnecessary.
 *
 * Design: the full dataset is kept in memory (loaded once at startup) and
 * every read comes straight from memory - never from disk. Writes mutate
 * memory immediately (so subsequent reads always see the latest state) and
 * are persisted to disk asynchronously through a serialized queue. This
 * avoids a race where a read could catch the JSON file mid-write and fail
 * to parse it.
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

function loadFromDisk() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    return { servers: {}, jobs: {} };
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    if (!raw.trim()) return { servers: {}, jobs: {} };
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[store] Failed to parse ${DATA_FILE}, starting fresh:`, err.message);
    return { servers: {}, jobs: {} };
  }
}

let memory = loadFromDisk();
let writeQueue = Promise.resolve();

function persist() {
  // Snapshot synchronously so later mutations don't affect this write.
  const snapshot = JSON.stringify(memory, null, 2);
  writeQueue = writeQueue.then(
    () =>
      new Promise((resolve) => {
        fs.writeFile(DATA_FILE, snapshot, (err) => {
          if (err) console.error("[store] Failed to persist to disk:", err.message);
          resolve();
        });
      })
  );
  return writeQueue;
}

// ---- Servers cache (last known merge of inventory + Endpoint Central) ----

function getServers() {
  return memory.servers;
}

async function setServers(serversByHostname) {
  memory.servers = serversByHostname;
  await persist();
}

// ---- Deployment jobs ----

function getJob(jobId) {
  return memory.jobs[jobId];
}

function getAllJobs() {
  return memory.jobs;
}

async function createJob(job) {
  memory.jobs[job.id] = job;
  await persist();
  return job;
}

async function updateJob(jobId, patch) {
  if (!memory.jobs[jobId]) return null;
  memory.jobs[jobId] = { ...memory.jobs[jobId], ...patch };
  await persist();
  return memory.jobs[jobId];
}

async function appendJobLog(jobId, line) {
  if (!memory.jobs[jobId]) return;
  memory.jobs[jobId].log = memory.jobs[jobId].log || [];
  memory.jobs[jobId].log.push({ ts: new Date().toISOString(), line });
  await persist();
}

module.exports = {
  getServers,
  setServers,
  getJob,
  getAllJobs,
  createJob,
  updateJob,
  appendJobLog,
};
