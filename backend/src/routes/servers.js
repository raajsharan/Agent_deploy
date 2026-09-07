const express = require("express");
const { fetchInventoryServers } = require("../services/inventoryService");
const { fetchManagedComputers } = require("../services/endpointCentralService");
const store = require("../store");

const router = express.Router();

/**
 * Pulls fresh data from the inventory API and Endpoint Central, merges them
 * keyed by hostname, layers in the most recent local deployment job for each
 * server, and caches the result so GET /api/servers is fast even if one of
 * the upstream systems is briefly unavailable.
 */
async function refreshServers() {
  const [inventoryList, ecByHostname] = await Promise.all([
    fetchInventoryServers(),
    fetchManagedComputers().catch((err) => {
      console.error("Endpoint Central fetch failed, continuing with inventory-only data:", err.message);
      return {};
    }),
  ]);

  const jobs = Object.values(store.getAllJobs());

  const merged = {};
  for (const inv of inventoryList) {
    const key = inv.hostname.toLowerCase();
    const ec = ecByHostname[key];

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
      agentStatus: ec ? ec.agentStatus : "Unknown",
      agentInstalled: ec ? ec.agentInstalled : false,
      lastContact: ec ? ec.lastContact : null,
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
