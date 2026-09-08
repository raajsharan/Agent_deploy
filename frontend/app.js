const state = {
  servers: [],       // raw server list from API
  selected: new Set(),
  search: "",
  statusFilter: "",
  activeJobId: null, // job currently shown in the log drawer
};

const socket = io({ withCredentials: true });

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------

/**
 * Wraps fetch to redirect to the login page on a 401, so an expired/missing
 * session bounces the user to sign in instead of silently failing.
 */
async function apiFetch(url, options = {}) {
  const res = await fetch(url, { ...options, credentials: "include" });
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("Not authenticated");
  }
  return res;
}

async function loadCurrentUser() {
  try {
    const res = await apiFetch("/api/auth/me");
    const { username } = await res.json();
    document.getElementById("currentUsername").textContent = username;
  } catch {
    // apiFetch already redirects on 401
  }
}

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await apiFetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/login.html";
});

// ---------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------

async function loadServers() {
  const res = await apiFetch("/api/servers");
  state.servers = await res.json();
  render();
}

async function refreshInventory() {
  const btn = document.getElementById("refreshBtn");
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  try {
    const res = await apiFetch("/api/servers/refresh", { method: "POST" });
    state.servers = await res.json();
    render();
    showToast("Inventory and agent status refreshed.");
  } catch (e) {
    showToast("Refresh failed: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh Inventory";
  }
}

async function deploySelected() {
  const hostnames = Array.from(state.selected);
  if (hostnames.length === 0) return;
  const res = await apiFetch("/api/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostnames }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    showToast("Deploy failed: " + (body.error || res.statusText));
    return;
  }
  const { jobs } = await res.json();
  showToast(`Deployment started for ${jobs.length} server(s).`);
  // Optimistically mark these hosts as "Running"
  for (const s of state.servers) {
    if (state.selected.has(s.hostname)) {
      s.lastJob = { id: jobs.find((j) => j.hostname === s.hostname)?.id, status: "Running" };
    }
  }
  state.selected.clear();
  render();
}

// ---------------------------------------------------------------------
// Derived data / filtering
// ---------------------------------------------------------------------

function statusOf(server) {
  // Prefer an in-flight/most-recent job status over the last-known EC status
  if (server.lastJob && ["Queued", "Running"].includes(server.lastJob.status)) {
    return server.lastJob.status;
  }
  if (server.lastJob && server.lastJob.status === "Failed") return "Failed";
  return server.agentStatus || "Unknown";
}

function filteredServers() {
  const q = state.search.trim().toLowerCase();
  return state.servers.filter((s) => {
    const matchesSearch =
      !q || s.hostname.toLowerCase().includes(q) || (s.ip || "").toLowerCase().includes(q);
    const matchesStatus = !state.statusFilter || statusOf(s) === state.statusFilter;
    return matchesSearch && matchesStatus;
  });
}

function badgeClassFor(status) {
  const map = {
    Installed: "badge-installed",
    "Not Installed": "badge-not-installed",
    Running: "badge-running",
    Queued: "badge-queued",
    Success: "badge-success",
    Failed: "badge-failed",
    Warning: "badge-warning",
    Unknown: "badge-unknown",
  };
  return map[status] || "badge-unknown";
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

function renderStats() {
  const total = state.servers.length;
  const installed = state.servers.filter((s) => statusOf(s) === "Installed").length;
  const running = state.servers.filter((s) => statusOf(s) === "Running" || statusOf(s) === "Queued").length;
  const failed = state.servers.filter((s) => statusOf(s) === "Failed").length;
  const notInstalled = state.servers.filter((s) => statusOf(s) === "Not Installed").length;
  const nessusInstalled = state.servers.filter((s) => s.nessusStatus === "Installed").length;

  const cards = [
    { label: "Total Servers", value: total, accent: "" },
    { label: "ME Agent Installed", value: installed, accent: "accent-success" },
    { label: "Deploying", value: running, accent: "" },
    { label: "Failed", value: failed, accent: "accent-danger" },
    { label: "ME Not Installed", value: notInstalled, accent: "accent-warning" },
    { label: "Nessus Installed", value: nessusInstalled, accent: "accent-success" },
  ];

  document.getElementById("statRow").innerHTML = cards
    .map(
      (c) => `
      <div class="stat-card ${c.accent}">
        <div class="stat-value">${c.value}</div>
        <div class="stat-label">${c.label}</div>
      </div>`
    )
    .join("");
}

function renderRows() {
  const rows = filteredServers();
  const tbody = document.getElementById("serverRows");
  const emptyState = document.getElementById("emptyState");

  if (rows.length === 0) {
    tbody.innerHTML = "";
    emptyState.style.display = "block";
    return;
  }
  emptyState.style.display = "none";

  tbody.innerHTML = rows
    .map((s) => {
      const status = statusOf(s);
      const lastJobId = s.lastJob?.id;
      const lastDeployText = s.lastJob
        ? `${s.lastJob.status}${s.lastJob.startedAt ? " · " + timeAgo(s.lastJob.startedAt) : ""}`
        : "—";
      return `
        <tr data-hostname="${s.hostname}">
          <td class="row-select">
            <input type="checkbox" class="rowCheckbox" data-hostname="${s.hostname}"
              ${state.selected.has(s.hostname) ? "checked" : ""} />
          </td>
          <td class="hostname">${s.hostname}</td>
          <td class="muted">${s.ip || "—"}</td>
          <td class="muted">${s.os || "—"}</td>
          <td><span class="badge ${badgeClassFor(status)}">${status}</span></td>
          <td><span class="badge ${badgeClassFor(s.nessusStatus || "Unknown")}">${s.nessusStatus || "Unknown"}</span></td>
          <td class="muted">
            ${lastDeployText}
            ${lastJobId ? `<br/><button class="link-btn" data-jobid="${lastJobId}" data-action="viewlog">View log</button>` : ""}
          </td>
          <td class="muted">${s.lastContact ? timeAgo(s.lastContact) : "—"}</td>
          <td>
            <button class="btn btn-secondary" data-action="deploy-one" data-hostname="${s.hostname}"
              style="padding:6px 12px; font-size:13px;">Deploy</button>
          </td>
        </tr>`;
    })
    .join("");
}

function renderDeployButton() {
  const btn = document.getElementById("deployBtn");
  btn.disabled = state.selected.size === 0;
  btn.textContent = state.selected.size ? `Deploy Selected (${state.selected.size})` : "Deploy Selected";
}

function render() {
  renderStats();
  renderRows();
  renderDeployButton();
}

function timeAgo(isoString) {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function showToast(message) {
  const root = document.getElementById("toastRoot");
  root.innerHTML = `<div class="toast">${message}</div>`;
  setTimeout(() => { root.innerHTML = ""; }, 4000);
}

// ---------------------------------------------------------------------
// Log drawer
// ---------------------------------------------------------------------

async function openLogDrawer(jobId) {
  state.activeJobId = jobId;
  const job = await apiFetch(`/api/deploy/jobs/${jobId}`).then((r) => r.json());

  const root = document.getElementById("drawerRoot");
  root.innerHTML = `
    <div class="drawer-overlay" id="drawerOverlay">
      <div class="drawer">
        <div class="drawer-header">
          <h2>${job.hostname} — Deployment Log</h2>
          <button class="drawer-close" id="drawerClose">&times;</button>
        </div>
        <div class="drawer-body" id="drawerBody">
          ${(job.log || []).map(renderLogLine).join("")}
        </div>
      </div>
    </div>`;

  document.getElementById("drawerOverlay").addEventListener("click", (e) => {
    if (e.target.id === "drawerOverlay") closeLogDrawer();
  });
  document.getElementById("drawerClose").addEventListener("click", closeLogDrawer);

  const body = document.getElementById("drawerBody");
  body.scrollTop = body.scrollHeight;
}

function renderLogLine(entry) {
  const isErr = entry.line.startsWith("ERROR:") || entry.line.startsWith("STATUS: Failed");
  return `<div class="log-line ${isErr ? "err" : ""}">${escapeHtml(entry.line)}</div>`;
}

function closeLogDrawer() {
  state.activeJobId = null;
  document.getElementById("drawerRoot").innerHTML = "";
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------
// Settings / connectivity drawer
// ---------------------------------------------------------------------

async function openSettingsDrawer() {
  const settings = await apiFetch("/api/settings").then((r) => r.json());

  const root = document.getElementById("drawerRoot");
  root.innerHTML = `
    <div class="drawer-overlay" id="settingsOverlay">
      <div class="drawer settings-drawer">
        <div class="drawer-header">
          <h2>Settings &amp; Connectivity</h2>
          <button class="drawer-close" id="settingsClose">&times;</button>
        </div>
        <div class="drawer-body settings-body">
          ${renderSettingsCard({
            section: "inventory",
            title: "Inventory API",
            fields: [
              { key: "url", label: "API URL", value: settings.inventory.url, checkable: true },
              { key: "loginUrl", label: "Login URL", value: settings.inventory.loginUrl, checkable: true },
              { key: "username", label: "Username", value: settings.inventory.username },
              { key: "password", label: "Password", type: "password", configured: settings.inventory.passwordConfigured },
              { key: "token", label: "Static API token (alternative to login)", type: "password", configured: settings.inventory.tokenConfigured },
              { key: "osFilter", label: "OS filter", value: settings.inventory.osFilter },
            ],
          })}
          ${renderSettingsCard({
            section: "endpoint-central",
            title: "Endpoint Central API",
            fields: [
              { key: "baseUrl", label: "Base URL", value: settings.endpointCentral.baseUrl, checkable: true },
              { key: "computersPath", label: "Computers path", value: settings.endpointCentral.computersPath },
              { key: "apiKey", label: "API key", type: "password", configured: settings.endpointCentral.apiKeyConfigured },
            ],
          })}
          ${renderSettingsCard({
            section: "deployment",
            title: "Deployment Readiness",
            fields: [
              { key: "installerLocalPath", label: "Fallback installer path", value: settings.deployment.installerLocalPath },
              {
                key: "installerByLocation",
                label: "Per-location installer (one per line: Location = path, e.g. a shared \\\\server\\share\\... path)",
                type: "textarea",
                value: settings.deployment.installerByLocation,
              },
              { key: "credentialFile", label: "Fallback credential file", value: settings.deployment.credentialFile },
              {
                key: "method",
                label: "Deployment method",
                type: "select",
                value: settings.deployment.method,
                options: ["Auto", "RemComStyle", "WinRM", "PsExec", "WMI"],
              },
              { key: "installArgs", label: "Extra silent-install args (blank = installer's own default)", value: settings.deployment.installArgs },
              { key: "remoteDir", label: "Remote staging directory", value: settings.deployment.remoteDir },
              { key: "serviceName", label: "Installed agent's Windows service name", value: settings.deployment.serviceName },
              { key: "psexecPath", label: "PsExec.exe path (needed for PsExec/Auto)", value: settings.deployment.psexecPath },
              { key: "winrmPort", label: "WinRM port", type: "number", value: settings.deployment.winrmPort },
              { key: "useHttps", label: "Use HTTPS for WinRM", type: "checkbox", checked: settings.deployment.useHttps },
              { key: "skipCertValidation", label: "Skip WinRM certificate validation", type: "checkbox", checked: settings.deployment.skipCertValidation },
              { key: "maxConcurrent", label: "Max concurrent deployments", type: "number", value: settings.deployment.maxConcurrent },
            ],
          })}
        </div>
      </div>
    </div>`;

  document.getElementById("settingsOverlay").addEventListener("click", (e) => {
    if (e.target.id === "settingsOverlay") closeSettingsDrawer();
  });
  document.getElementById("settingsClose").addEventListener("click", closeSettingsDrawer);

  root.querySelectorAll("[data-test]").forEach((btn) => {
    btn.addEventListener("click", () => runSettingsTest(btn.dataset.test));
  });
  root.querySelectorAll("[data-checkurl]").forEach((btn) => {
    btn.addEventListener("click", () => runUrlCheck(btn));
  });
  root.querySelectorAll("form[data-section]").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      saveSettingsSection(form.dataset.section, form);
    });
  });
}

function renderSettingsCard({ section, title, fields }) {
  return `
    <form class="settings-card" data-section="${section}">
      <div class="settings-card-header">
        <h3>${title}</h3>
        <div class="settings-card-actions">
          <button type="submit" class="btn btn-secondary btn-sm">Save</button>
          <button type="button" class="btn btn-secondary btn-sm" data-test="${section}">Test Connection</button>
        </div>
      </div>
      ${fields.map(renderSettingsField).join("")}
      <div class="settings-save-status" data-save-status="${section}"></div>
      <div class="settings-result" data-result="${section}"></div>
    </form>`;
}

function renderSettingsField(f) {
  if (f.type === "password") {
    return `
      <label class="settings-field-edit">
        <span>${f.label}</span>
        <input type="password" name="${f.key}" autocomplete="new-password"
          placeholder="${f.configured ? "•••••••• (unchanged)" : "Not set"}" />
      </label>`;
  }
  if (f.type === "checkbox") {
    return `
      <label class="settings-field-checkbox">
        <input type="checkbox" name="${f.key}" ${f.checked ? "checked" : ""} />
        <span>${f.label}</span>
      </label>`;
  }
  if (f.type === "select") {
    const optionsHtml = (f.options || [])
      .map((opt) => `<option value="${escapeHtml(opt)}" ${opt === f.value ? "selected" : ""}>${escapeHtml(opt)}</option>`)
      .join("");
    return `
      <label class="settings-field-edit">
        <span>${f.label}</span>
        <select name="${f.key}">${optionsHtml}</select>
      </label>`;
  }
  if (f.type === "textarea") {
    const value = f.value != null ? escapeHtml(String(f.value)) : "";
    return `
      <label class="settings-field-edit">
        <span>${f.label}</span>
        <textarea name="${f.key}" rows="3">${value}</textarea>
      </label>`;
  }
  const value = f.value != null ? escapeHtml(String(f.value)) : "";
  const checkRow = f.checkable
    ? `<div class="url-check-row">
        <button type="button" class="btn btn-secondary btn-xs" data-checkurl="${f.key}">Check URL</button>
        <span class="url-check-result" data-checkurl-result="${f.key}"></span>
      </div>`
    : "";
  return `
    <label class="settings-field-edit">
      <span>${f.label}</span>
      <input type="${f.type || "text"}" name="${f.key}" value="${value}" />
      ${checkRow}
    </label>`;
}

/**
 * Fast, no-auth reachability check for a single URL field - reads the
 * input's current (possibly unsaved) value, same as the equivalent "Check
 * URL" feature in the Inventory Tool app this pattern was adapted from.
 */
async function runUrlCheck(btn) {
  const key = btn.dataset.checkurl;
  const form = btn.closest("form");
  const input = form.querySelector(`input[name="${key}"]`);
  const resultEl = form.querySelector(`[data-checkurl-result="${key}"]`);
  const url = input.value.trim();

  if (!url) {
    resultEl.innerHTML = `<span class="settings-status fail">Enter a URL first</span>`;
    return;
  }

  btn.disabled = true;
  resultEl.innerHTML = `<span class="settings-status testing">Checking…</span>`;
  try {
    const res = await apiFetch("/api/settings/check-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const body = await res.json();
    resultEl.innerHTML = body.reachable
      ? `<span class="settings-status ok">✓ Reachable (HTTP ${body.status})</span>`
      : `<span class="settings-status fail">✗ Unreachable — ${escapeHtml(body.error)}</span>`;
  } catch (e) {
    resultEl.innerHTML = `<span class="settings-status fail">✗ ${escapeHtml(e.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
}

function closeSettingsDrawer() {
  document.getElementById("drawerRoot").innerHTML = "";
}

async function saveSettingsSection(section, form) {
  const saveBtn = form.querySelector('button[type="submit"]');
  const statusEl = form.querySelector(`[data-save-status="${section}"]`);
  const payload = {};
  new FormData(form).forEach((value, key) => {
    if (value !== "") payload[key] = value; // blank = keep existing (handled server-side too)
  });
  // An unchecked checkbox contributes nothing to FormData at all, so read
  // checkbox state explicitly - otherwise there'd be no way to save "off".
  form.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    payload[input.name] = input.checked;
  });

  saveBtn.disabled = true;
  statusEl.innerHTML = `<span class="settings-status testing">Saving…</span>`;
  try {
    const res = await apiFetch(`/api/settings/${section}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Save failed.");
    statusEl.innerHTML = `<span class="settings-status ok">✓ Saved</span>`;
    form.querySelectorAll('input[type="password"]').forEach((input) => (input.value = ""));
  } catch (e) {
    statusEl.innerHTML = `<span class="settings-status fail">✗ ${escapeHtml(e.message)}</span>`;
  } finally {
    saveBtn.disabled = false;
  }
}

async function runSettingsTest(key) {
  const btn = document.querySelector(`[data-test="${key}"]`);
  const resultEl = document.querySelector(`[data-result="${key}"]`);
  btn.disabled = true;
  resultEl.innerHTML = `<span class="settings-status testing">Testing…</span>`;
  try {
    const res = await apiFetch(`/api/settings/test/${key}`, { method: "POST" });
    const body = await res.json();
    resultEl.innerHTML = renderSettingsResult(key, body);
  } catch (e) {
    resultEl.innerHTML = `<span class="settings-status fail">✗ ${escapeHtml(e.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
}

function renderSettingsResult(key, body) {
  if (key === "deployment") {
    const { installerPath, credentialFile } = body.checks;
    const lines = [];
    lines.push(
      installerPath.configured
        ? `<span class="settings-status ${installerPath.exists ? "ok" : "fail"}">${installerPath.exists ? "✓" : "✗"} Installer ${
            installerPath.exists ? "found" : "not found"
          } at ${escapeHtml(installerPath.value)}</span>`
        : `<span class="settings-status fail">✗ INSTALLER_LOCAL_PATH is not configured</span>`
    );
    if (credentialFile.configured) {
      lines.push(
        `<span class="settings-status ${credentialFile.exists ? "ok" : "fail"}">${credentialFile.exists ? "✓" : "✗"} Fallback credential file ${
          credentialFile.exists ? "found" : "missing"
        }</span>`
      );
    } else {
      lines.push(`<span class="settings-status testing">No fallback credential file configured (per-asset inventory credentials only).</span>`);
    }
    for (const loc of body.checks.installerByLocation || []) {
      lines.push(
        `<span class="settings-status ${loc.exists ? "ok" : "fail"}">${loc.exists ? "✓" : "✗"} ${escapeHtml(loc.location)}: ${
          loc.exists ? "found" : "not found"
        } (${escapeHtml(loc.path)})</span>`
      );
    }
    return lines.join("<br/>");
  }

  if (body.ok) {
    if (key === "inventory") {
      return `<span class="settings-status ok">✓ Connected (${body.authMode}) — ${body.total} record(s) visible</span>`;
    }
    if (key === "endpoint-central") {
      return `<span class="settings-status ok">✓ Connected — ${body.total} managed computer(s)</span>`;
    }
  }
  return `<span class="settings-status fail">✗ ${escapeHtml(body.error || "Connection failed")}</span>`;
}

document.getElementById("settingsBtn").addEventListener("click", openSettingsDrawer);

// ---------------------------------------------------------------------
// Socket.IO live updates
// ---------------------------------------------------------------------

socket.on("connect_error", (err) => {
  // Most likely cause: session expired/missing, so the server's socket.io
  // auth middleware rejected the handshake.
  console.warn("Socket connection rejected:", err.message);
});

socket.on("job:log", ({ jobId, line }) => {
  if (state.activeJobId === jobId) {
    const body = document.getElementById("drawerBody");
    if (body) {
      body.insertAdjacentHTML("beforeend", renderLogLine({ line }));
      body.scrollTop = body.scrollHeight;
    }
  }
});

socket.on("job:status", ({ jobId, hostname, status, finishedAt }) => {
  const server = state.servers.find((s) => s.hostname === hostname);
  if (server) {
    server.lastJob = { id: jobId, status, startedAt: server.lastJob?.startedAt || new Date().toISOString(), finishedAt };
    render();
  }
});

// ---------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------

document.getElementById("searchInput").addEventListener("input", (e) => {
  state.search = e.target.value;
  render();
});

document.getElementById("statusFilter").addEventListener("change", (e) => {
  state.statusFilter = e.target.value;
  render();
});

document.getElementById("refreshBtn").addEventListener("click", refreshInventory);
document.getElementById("deployBtn").addEventListener("click", deploySelected);

document.getElementById("selectAll").addEventListener("change", (e) => {
  const rows = filteredServers();
  if (e.target.checked) rows.forEach((s) => state.selected.add(s.hostname));
  else rows.forEach((s) => state.selected.delete(s.hostname));
  render();
});

document.getElementById("serverRows").addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  if (action === "viewlog") {
    openLogDrawer(e.target.dataset.jobid);
  } else if (action === "deploy-one") {
    const hostname = e.target.dataset.hostname;
    state.selected.add(hostname);
    deploySelected();
  }
});

document.getElementById("serverRows").addEventListener("change", (e) => {
  if (e.target.classList.contains("rowCheckbox")) {
    const hostname = e.target.dataset.hostname;
    if (e.target.checked) state.selected.add(hostname);
    else state.selected.delete(hostname);
    renderDeployButton();
  }
});

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

loadCurrentUser();
loadServers();
