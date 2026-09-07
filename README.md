# Agent Deployment Manager

A web app for deploying the ManageEngine Endpoint Central agent to your
Windows Server fleet and tracking installation status live — pulling server
data from your internal inventory API and agent status from Endpoint Central.

Tested end-to-end against mock APIs during development (inventory merge,
job creation, live status, and graceful handling of failures all confirmed
working). What's untested: the actual `Install-AgentRemote.ps1` execution
against a real Windows Server and the real Endpoint Central API shape, since
those need your live environment.

## How it works

- **Backend** (Node.js/Express, `/backend`) — pulls your server list from the
  inventory API, merges it with live Endpoint Central agent status, and
  exposes a REST + WebSocket API. When you trigger a deployment, it spawns
  the included PowerShell script per target server (respecting a concurrency
  limit) and streams progress back to the UI live.
- **Frontend** (`/frontend`) — a single dashboard page: stat cards, a
  searchable/filterable server table, bulk or per-server "Deploy", and a live
  log drawer per deployment job. Styled with NetBrain's design tokens.

## Prerequisites

- Node.js 18+ on the machine that will run the backend.
- That machine must have **network line-of-sight to your target Windows
  Servers** and **WinRM/PowerShell Remoting** working against them (the same
  requirements as the manual script from earlier: `Enable-PSRemoting`, admin
  rights, firewall rules for WinRM + the admin$ share).
- Because of the WinRM requirement, **run this backend on a Windows machine**
  (a jump box / management server) — not Linux/macOS. `powershell.exe` and
  `Invoke-Command` are Windows-only.

## Setup

1. **Install dependencies**
   ```
   cd backend
   npm install
   ```

2. **Configure environment**
   ```
   copy .env.example .env
   ```
   Edit `.env`:
   - `INVENTORY_API_URL` / auth settings / field names — match your internal
     inventory tool's real API.
   - `EC_BASE_URL` / `EC_API_KEY` / `EC_COMPUTERS_PATH` — match your
     Endpoint Central instance. **Open `backend/src/services/endpointCentralService.js`
     and adjust the response parsing** to your instance's actual JSON shape —
     this varies between on-prem and cloud Endpoint Central, and I couldn't
     verify the exact fields against a real instance.
   - `INSTALLER_LOCAL_PATH` — path to the agent installer file on this
     machine.

3. **Create your login.** Nobody can sign in until at least one account
   exists. Run:
   ```
   node scripts/create-user.js <username>
   ```
   It prompts for a password (min. 8 characters) and stores a bcrypt hash —
   never the plaintext password. Run it again with the same username to
   reset that user's password later.

   Also set `SESSION_SECRET` in `.env` to a fixed random string (a command
   to generate one is in `.env.example`) — otherwise every server restart
   invalidates everyone's login.

4. **Store the deployment service account credential securely** (one-time,
   run directly on the machine that will run the backend, as the same
   Windows user the backend process will run as):
   ```
   powershell -File backend\scripts\Setup-Credential.ps1 -OutputPath "C:\Deploy\deploy-credential.xml"
   ```
   This uses Windows DPAPI (`Export-Clixml`) so the password is encrypted to
   that exact user + machine — it's never stored in plaintext, never passed
   as a command-line argument, and never held in the Node.js process itself.
   Set `DEPLOY_CREDENTIAL_FILE` in `.env` to match the path you used.

5. **Run it**
   ```
   npm start
   ```
   Open `http://localhost:4000` (or whatever `PORT` you set) — you'll land
   on the sign-in page first.

## Using it

- Sign in with the account you created in step 3. Sessions last 12 hours by
  default (`SESSION_MAX_AGE_MS`) and there's a lockout after 5 failed login
  attempts from the same IP (5-minute cooldown).
- The dashboard loads your server list on open (cached after first fetch —
  click **Refresh Inventory** to re-pull live from both APIs).
- Select one or more servers via checkboxes and click **Deploy Selected**,
  or click **Deploy** on a single row.
- Click **View log** next to any deployment to open a live-streaming log
  drawer for that job.
- Stat cards at the top summarize fleet-wide status at a glance.

## Known gaps to close before production use

- **Sessions are in-memory.** `express-session`'s default MemoryStore is
  fine for a single small team on one process, but it doesn't survive a
  restart and won't work if you ever run more than one backend instance.
  For a bigger rollout, swap in a session store like `connect-redis`.
- **One flat set of accounts, no roles.** Every logged-in user can trigger
  deployments to every server — there's no read-only role or per-team
  scoping. Fine for a small ops team; revisit if that changes.
- **Endpoint Central API shape is a placeholder.** I don't have access to
  your real instance, so `endpointCentralService.js` and the `EC_*` env vars
  are built from the general shape of the Endpoint Central REST API and
  marked with `TODO` comments — verify against your version's actual API
  docs before relying on the "Agent Status" column.
- **Job history isn't pruned.** `backend/data/store.json` grows over time;
  add a retention/cleanup job if you'll run this long-term with many
  deployments.
- **No authentication on the web app itself.** Anyone who can reach the
  backend's port can trigger deployments. Put it behind your normal internal
  auth (reverse proxy with SSO, VPN-only access, etc.) before exposing it
  beyond your own machine.
- **Bulk deploys of very large fleets:** `MAX_CONCURRENT_DEPLOYMENTS` throttles
  parallel WinRM sessions (default 5) — raise cautiously, as very high
  concurrency can overload WinRM on some Windows Server versions.
