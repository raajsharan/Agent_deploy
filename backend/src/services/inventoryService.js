const { config } = require("../config");

/**
 * Fetches the raw server list from your internal inventory tool's API and
 * normalizes it to { hostname, ip, os } records, filtered to the OS types
 * this app deploys to.
 *
 * ADJUST ME: this function assumes the API returns a JSON array at the top
 * level. If your API wraps results in an envelope (e.g. { data: [...] } or
 * { results: [...] }), change the `list` line below accordingly.
 */
async function fetchInventoryServers() {
  const { url, authHeader, authScheme, token, fieldHostname, fieldIp, fieldOs, osFilter } =
    config.inventory;

  if (!url) {
    throw new Error("INVENTORY_API_URL is not configured. Set it in backend/.env");
  }

  const headers = { Accept: "application/json" };
  if (token) {
    headers[authHeader] = authScheme ? `${authScheme} ${token}` : token;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Inventory API request failed: ${res.status} ${res.statusText}`);
  }

  const body = await res.json();

  // TODO: change this line if your API wraps the array, e.g. `body.data`
  const list = Array.isArray(body) ? body : body.items || body.data || body.results || [];

  return list
    .map((row) => ({
      hostname: row[fieldHostname],
      ip: row[fieldIp],
      os: row[fieldOs],
      raw: row,
    }))
    .filter((row) => row.hostname && (!osFilter || (row.os || "").includes(osFilter)));
}

module.exports = { fetchInventoryServers };
