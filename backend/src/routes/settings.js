const express = require("express");
const fs = require("fs");
const { config, updateConfigSection } = require("../config");
const inventoryService = require("../services/inventoryService");
const { fetchManagedComputers } = require("../services/endpointCentralService");

const router = express.Router();

// Route segment -> config object key (only "endpoint-central" differs).
const SECTION_CONFIG_KEY = {
  inventory: "inventory",
  "endpoint-central": "endpointCentral",
  deployment: "deployment",
};

// Allow-list of fields the Settings UI may write per section.
const EDITABLE_FIELDS = {
  inventory: ["url", "loginUrl", "username", "password", "osFilter", "token"],
  "endpoint-central": ["baseUrl", "computersPath", "apiKey"],
  deployment: ["installerLocalPath", "credentialFile", "maxConcurrent"],
};

const NUMBER_FIELDS = new Set(["maxConcurrent"]);

/**
 * Non-secret summary of the current configuration, for display/editing in
 * the frontend Settings panel. Secrets (password/token/apiKey) are reported
 * only as a "configured: true/false" flag, never their actual value.
 */
router.get("/", (req, res) => {
  res.json({
    inventory: {
      url: config.inventory.url || null,
      authMode: config.inventory.token ? "static-token" : "login",
      loginUrl: config.inventory.loginUrl || null,
      username: config.inventory.username || null,
      osFilter: config.inventory.osFilter || null,
      passwordConfigured: Boolean(config.inventory.password),
      tokenConfigured: Boolean(config.inventory.token),
    },
    endpointCentral: {
      baseUrl: config.endpointCentral.baseUrl || null,
      computersPath: config.endpointCentral.computersPath || null,
      apiKeyConfigured: Boolean(config.endpointCentral.apiKey),
    },
    deployment: {
      installerLocalPath: config.deployment.installerLocalPath || null,
      credentialFile: config.deployment.credentialFile || null,
      credentialFileConfigured: Boolean(config.deployment.credentialFile),
      maxConcurrent: config.deployment.maxConcurrent,
    },
  });
});

/**
 * Saves a partial update to one settings section. Takes effect immediately
 * (no restart) and persists to backend/data/settings-overrides.json.
 */
router.put("/:section", (req, res) => {
  const configKey = SECTION_CONFIG_KEY[req.params.section];
  const allowedFields = EDITABLE_FIELDS[req.params.section];
  if (!configKey) {
    return res.status(404).json({ error: `Unknown settings section '${req.params.section}'.` });
  }

  const body = req.body || {};
  const patch = {};
  for (const field of allowedFields) {
    if (!(field in body)) continue;
    let value = body[field];
    if (NUMBER_FIELDS.has(field)) {
      if (value === "" || value === null || value === undefined) continue;
      value = Number(value);
      if (Number.isNaN(value)) {
        return res.status(400).json({ error: `'${field}' must be a number.` });
      }
    }
    patch[field] = value;
  }

  updateConfigSection(configKey, patch);
  if (req.params.section === "inventory") inventoryService.resetAuthCache();

  res.json({ ok: true });
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
