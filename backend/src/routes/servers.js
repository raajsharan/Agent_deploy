const express = require("express");
const { fetchInventoryServers } = require("../services/inventoryService");
const store = require("../store");

const router = express.Router();

/**
 * Pulls fresh data from the inventory API, layers in the most recent local
 * deployment job for each server, and caches the result so GET /api/servers
 * is fast even if the inventory API is briefly unavailable.
 *
 * Endpoint Central/ManageEngine agent status comes straight from the
 * inventory tool's own asset record (manage_engine_installed) rather than a
 * separate Endpoint Central API call - the inventory tool already tracks
 * this, so there's no second system to keep in sync. Same for Nessus
 * (tenable_installed). See inventoryService.fetchInventoryServers.
 */
async function refreshServers() {
  const inventoryList = await fetchInventoryServers();
  const jobs = Object.values(store.getAllJobs());

  const merged = {};
  for (const inv of inventoryList) {
    const key = inv.hostname.toLowerCase();

    // Most recent job for this host, if any
    const hostJobs = jobs
      .filter((j) => j.hostname.toLowerCase() === key)
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    const lastJob = hostJobs[0] || null;

    merged[inv.hostname] = {
      hostname: inv.hostname,
      ip: inv.ip || null,
      os: inv.os || null,
      // Used by deploymentService to pull this server's own deployment
      // credential from the inventory tool at deploy time (see
      // inventoryService.fetchAssetPassword) - never the password itself.
      assetId: inv.raw?.id || null,
      credentialUsername: inv.raw?.asset_username || null,
      agentStatus: inv.manageEngineInstalled ? "Installed" : "Not Installed",
      agentInstalled: inv.manageEngineInstalled,
      nessusStatus: inv.nessusInstalled ? "Installed" : "Not Installed",
      nessusInstalled: inv.nessusInstalled,
      lastJob: lastJob
        ? { id: lastJob.id, status: lastJob.status, startedAt: lastJob.startedAt, finishedAt: lastJob.finishedAt }
        : null,
    };
  }

  await store.setServers(merged);
  return merged;
}

router.get("/", async (req, res) => {
  try {
    const cached = store.getServers();
    if (Object.keys(cached).length === 0) {
      const fresh = await refreshServers();
      return res.json(Object.values(fresh));
    }
    res.json(Object.values(cached));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const fresh = await refreshServers();
    res.json(Object.values(fresh));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = { router, refreshServers };
