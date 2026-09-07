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

  const cards = [
    { label: "Total Servers", value: total, accent: "" },
    { label: "Agent Installed", value: installed, accent: "accent-success" },
    { label: "Deploying", value: running, accent: "" },
    { label: "Failed", value: failed, accent: "accent-danger" },
    { label: "Not Installed", value: notInstalled, accent: "accent-warning" },
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
