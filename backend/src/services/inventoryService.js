const { config } = require("../config");

/**
 * Fetches the raw server list from your internal inventory tool's API and
 * normalizes it to { hostname, ip, os } records, filtered to the OS types
 * this app deploys to.
 *
 * ADJUST ME: this function assumes the API returns either a flat JSON array
 * at the top level, or a paginated envelope of the shape
 * { items: [...], total, page, pageSize }. If your API wraps results
 * differently, change the `list` line below accordingly.
 */

let cachedToken = null;
let cachedTokenExpiresAtMs = 0;

/**
 * Decodes a JWT's payload (without verifying the signature - we trust it
 * because we just received it from our own login call) to find its real
 * expiry, so we know when to log in again instead of guessing a TTL.
 */
function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8"));
    if (!payload.exp) return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

async function login() {
  const { loginUrl, username, password } = config.inventory;
  if (!loginUrl || !username || !password) {
    throw new Error(
      "Inventory API requires a login (no INVENTORY_API_TOKEN set), but " +
        "INVENTORY_LOGIN_URL / INVENTORY_USERNAME / INVENTORY_PASSWORD are not all configured."
    );
  }

  const res = await fetch(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: username, password }),
  });
  if (!res.ok) {
    throw new Error(`Inventory API login failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  if (!body.token) {
    throw new Error("Inventory API login response did not include a 'token' field.");
  }

  cachedToken = body.token;
  // Refresh a minute early rather than cutting it exactly at expiry.
  const expiry = jwtExpiryMs(body.token);
  cachedTokenExpiresAtMs = expiry ? expiry - 60_000 : Date.now() + 10 * 60 * 1000;
  return cachedToken;
}

async function getAuthToken() {
  if (config.inventory.token) return config.inventory.token;
  if (cachedToken && Date.now() < cachedTokenExpiresAtMs) return cachedToken;
  return login();
}

async function fetchPage(url, headers, page, pageSize) {
  const pageUrl = new URL(url);
  pageUrl.searchParams.set("page", String(page));
  pageUrl.searchParams.set("pageSize", String(pageSize));

  const res = await fetch(pageUrl, { headers });
  if (!res.ok) {
    throw new Error(`Inventory API request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchInventoryServers() {
  const { url, authHeader, authScheme, fieldHostname, fieldIp, fieldOs, osFilter, pageSize } =
    config.inventory;

  if (!url) {
    throw new Error("INVENTORY_API_URL is not configured. Set it in backend/.env");
  }

  const token = await getAuthToken();
  const headers = { Accept: "application/json" };
  if (token) headers[authHeader] = authScheme ? `${authScheme} ${token}` : token;

  const rows = [];
  let page = 1;
  // Walk pages until the API returns fewer rows than requested (last page),
  // or - for a non-paginated API returning a flat array - after one request.
  for (;;) {
    const body = await fetchPage(url, headers, page, pageSize);
    if (Array.isArray(body)) {
      rows.push(...body);
      break;
    }
    const list = body.items || body.data || body.results || [];
    rows.push(...list);
    if (list.length < pageSize) break;
    page += 1;
  }

  return rows
    .map((row) => ({
      hostname: row[fieldHostname],
      ip: row[fieldIp],
      os: row[fieldOs],
      raw: row,
    }))
    .filter((row) => row.hostname && (!osFilter || (row.os || "").includes(osFilter)));
}

module.exports = { fetchInventoryServers };
