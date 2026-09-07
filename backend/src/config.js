require("dotenv").config();
const crypto = require("crypto");

function required(name, fallback = undefined) {
  const value = process.env[name] ?? fallback;
  return value;
}

const config = {
  port: Number(process.env.PORT || 4000),
  corsOrigin: process.env.CORS_ORIGIN || "*",

  session: {
    // Falls back to a random secret generated at process start if you
    // haven't set one. That's fine for trying things out, but it means
    // every restart invalidates all logged-in sessions - set SESSION_SECRET
    // to a fixed random string in .env for real use.
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    // Set SESSION_COOKIE_SECURE=true once you're serving over HTTPS (it
    // makes the cookie unreadable/unsendable over plain HTTP, so leave it
    // false only during local HTTP testing).
    cookieSecure: process.env.SESSION_COOKIE_SECURE === "true",
    maxAgeMs: Number(process.env.SESSION_MAX_AGE_MS || 12 * 60 * 60 * 1000), // 12h default
  },

  inventory: {
    url: required("INVENTORY_API_URL"),
    authHeader: process.env.INVENTORY_AUTH_HEADER || "Authorization",
    authScheme: process.env.INVENTORY_AUTH_SCHEME ?? "Bearer",
    token: process.env.INVENTORY_API_TOKEN,
    fieldHostname: process.env.INVENTORY_FIELD_HOSTNAME || "hostname",
    fieldIp: process.env.INVENTORY_FIELD_IP || "ip_address",
    fieldOs: process.env.INVENTORY_FIELD_OS || "os",
    osFilter: process.env.INVENTORY_OS_FILTER || "Windows Server",
  },

  endpointCentral: {
    baseUrl: required("EC_BASE_URL"),
    apiKey: process.env.EC_API_KEY,
    authHeader: process.env.EC_AUTH_HEADER || "Authorization",
    authScheme: process.env.EC_AUTH_SCHEME ?? "Bearer",
    computersPath: process.env.EC_COMPUTERS_PATH || "/api/1.4/am/computers",
  },

  deployment: {
    installerLocalPath: process.env.INSTALLER_LOCAL_PATH,
    credentialFile: process.env.DEPLOY_CREDENTIAL_FILE,
    maxConcurrent: Number(process.env.MAX_CONCURRENT_DEPLOYMENTS || 5),
  },
};

function warnIfMissing() {
  const missing = [];
  if (!config.inventory.url) missing.push("INVENTORY_API_URL");
  if (!config.endpointCentral.baseUrl) missing.push("EC_BASE_URL");
  if (!config.deployment.installerLocalPath) missing.push("INSTALLER_LOCAL_PATH");
  if (!config.session.secret) missing.push("SESSION_SECRET");
  if (missing.length) {
    console.warn(
      `[config] Warning: the following settings are not configured yet: ${missing.join(", ")}. ` +
        "Copy backend/.env.example to backend/.env and fill these in."
    );
  }
}

module.exports = { config, warnIfMissing };
