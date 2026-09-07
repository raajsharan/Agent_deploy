const { config } = require("../config");

/**
 * Fetches managed-computer records from Endpoint Central and normalizes them
 * to { hostname, agentInstalled, agentStatus, lastContact } records, keyed
 * by hostname for easy merging with the inventory list.
 *
 * ADJUST ME: Endpoint Central's actual API shape varies by version (on-prem
 * vs. cloud) and by whether you're using API key auth or an OAuth-style
 * auth-token flow. Update `buildHeaders` and the response parsing below to
 * match your instance's real API docs.
 */

function buildHeaders() {
  const { apiKey, authHeader, authScheme } = config.endpointCentral;
  const headers = { Accept: "application/json" };
  if (apiKey) {
    headers[authHeader] = authScheme ? `${authScheme} ${apiKey}` : apiKey;
  }
  return headers;
}

async function fetchManagedComputers() {
  const { baseUrl, computersPath } = config.endpointCentral;

  if (!baseUrl) {
    throw new Error("EC_BASE_URL is not configured. Set it in backend/.env");
  }

  const url = `${baseUrl.replace(/\/$/, "")}${computersPath}`;
  const res = await fetch(url, { headers: buildHeaders() });

  if (!res.ok) {
    throw new Error(`Endpoint Central API request failed: ${res.status} ${res.statusText}`);
  }

  const body = await res.json();

  // TODO: adjust to your instance's actual response envelope/field names.
  const list = body.message_response?.computers || body.data || body.computers || [];

  const byHostname = {};
  for (const row of list) {
    const hostname = row.computer_name || row.hostname || row.name;
    if (!hostname) continue;
    byHostname[hostname.toLowerCase()] = {
      hostname,
      agentInstalled: Boolean(row.agent_version || row.agentVersion),
      agentStatus: row.agent_status || row.status || (row.agent_version ? "Installed" : "Not Installed"),
      lastContact: row.last_contact_time || row.lastContact || null,
    };
  }
  return byHostname;
}

module.exports = { fetchManagedComputers };
