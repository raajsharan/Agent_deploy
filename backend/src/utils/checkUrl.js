/**
 * Fast, network-level-only reachability probe for a URL - no auth, no login,
 * just "is anything listening and responding". Meant to answer "is this the
 * right host/path?" in a couple seconds, before running the slower full
 * Test Connection (which requires real credentials to succeed).
 *
 * This mirrors the "Check URL" pattern from the internal Inventory Tool app
 * (backend/src/services/endpointCentralService.js -> checkReachability):
 * catching a wrong URL/path early, distinctly from an auth failure, is what
 * would have caught a login URL pointed at the wrong path immediately.
 */
async function checkReachability(url, { timeoutMs = 5000 } = {}) {
  if (!url) return { reachable: false, error: "URL is required" };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { reachable: false, error: "Invalid URL format" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(parsed, { method: "GET", signal: controller.signal });
    return { reachable: true, status: res.status };
  } catch (err) {
    return { reachable: false, error: err.name === "AbortError" ? "Timed out" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkReachability };
