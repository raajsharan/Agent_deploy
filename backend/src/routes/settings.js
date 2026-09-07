const express = require("express");
const fs = require("fs");
const { config } = require("../config");
const inventoryService = require("../services/inventoryService");
const { fetchManagedComputers } = require("../services/endpointCentralService");

const router = express.Router();

/**
 * Non-secret summary of the current configuration, for display in the
 * frontend Settings panel. Never include tokens/passwords/keys here.
 */
router.get("/", (req, res) => {
  res.json({
    inventory: {
      url: config.inventory.url || null,
      authMode: config.inventory.token ? "static-token" : "login",
      loginUrl: config.inventory.loginUrl || null,
      osFilter: config.inventory.osFilter || null,
    },
    endpointCentral: {
      baseUrl: config.endpointCentral.baseUrl || null,
      computersPath: config.endpointCentral.computersPath || null,
      apiKeyConfigured: Boolean(config.endpointCentral.apiKey),
    },
    deployment: {
      installerLocalPath: config.deployment.installerLocalPath || null,
      credentialFileConfigured: Boolean(config.deployment.credentialFile),
      maxConcurrent: config.deployment.maxConcurrent,
    },
  });
});

router.post("/test/inventory", async (req, res) => {
  try {
    const result = await inventoryService.testConnection();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.post("/test/endpoint-central", async (req, res) => {
  try {
    const byHostname = await fetchManagedComputers();
    res.json({ ok: true, total: Object.keys(byHostname).length });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.post("/test/deployment", async (req, res) => {
  const { installerLocalPath, credentialFile } = config.deployment;
  const checks = {};

  checks.installerPath = installerLocalPath
    ? { configured: true, exists: fs.existsSync(installerLocalPath), value: installerLocalPath }
    : { configured: false, exists: false };

  checks.credentialFile = credentialFile
    ? { configured: true, exists: fs.existsSync(credentialFile), value: credentialFile }
    : { configured: false, exists: false };

  const ok = checks.installerPath.configured && checks.installerPath.exists;
  res.json({ ok, checks });
});

module.exports = { router };
