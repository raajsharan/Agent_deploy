const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { config } = require("../config");
const store = require("../store");
const { fetchAssetPassword } = require("./inventoryService");

const SCRIPT_PATH = path.join(__dirname, "..", "..", "scripts", "Install-AgentRemote.ps1");

/**
 * Simple in-process concurrency limiter so we don't launch dozens of
 * simultaneous PowerShell/WinRM sessions if someone selects 200 servers.
 */
let running = 0;
const queue = [];

function runWithLimit(fn) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      running++;
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        running--;
        if (queue.length) queue.shift()();
      }
    };
    if (running < config.deployment.maxConcurrent) task();
    else queue.push(task);
  });
}

/**
 * Kicks off deployment jobs for a list of hostnames. Each job runs
 * independently (subject to the concurrency limit) and emits socket.io
 * events so the UI can show live progress without polling.
 *
 * @param {string[]} hostnames
 * @param {import('socket.io').Server} io
 * @returns {{id: string, hostname: string}[]} created job stubs
 */
function startDeployments(hostnames, io) {
  const jobs = hostnames.map((hostname) => ({
    id: uuidv4(),
    hostname,
    status: "Queued",
    step: null,
    log: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  }));

  jobs.forEach(async (job) => {
    await store.createJob(job);
    io.emit("job:created", job);

    runWithLimit(() => runSingleDeployment(job, io)).catch((err) => {
      console.error(`Deployment job ${job.id} (${job.hostname}) crashed:`, err);
    });
  });

  return jobs.map(({ id, hostname }) => ({ id, hostname }));
}

/**
 * Fails a job outright, before any PowerShell process is spawned (used when
 * we can't resolve a deployment credential for the target).
 */
async function failJob(job, io, message) {
  await store.appendJobLog(job.id, `ERROR: ${message}`);
  await store.updateJob(job.id, { status: "Failed", message, finishedAt: new Date().toISOString() });
  io.emit("job:log", { jobId: job.id, line: `ERROR: ${message}` });
  io.emit("job:status", { jobId: job.id, hostname: job.hostname, status: "Failed", message });
}

/**
 * Resolves which credential to deploy with for one server:
 *  - Prefer the server's own credential from the inventory tool (per-asset
 *    local admin account) when the merged server record has one.
 *  - Otherwise fall back to the single shared DEPLOY_CREDENTIAL_FILE service
 *    account (the original design).
 *
 * Returns either { mode: "asset", username, password } or
 * { mode: "file", credentialFile }. The password (if any) is a live secret
 * held only in memory - never logged, persisted, or passed as a CLI arg.
 */
async function resolveCredential(hostname) {
  const server = store.getServers()[hostname];
  if (server && server.assetId && server.credentialUsername) {
    const password = await fetchAssetPassword(server.assetId);
    return { mode: "asset", username: server.credentialUsername, password };
  }
  if (config.deployment.credentialFile) {
    return { mode: "file", credentialFile: config.deployment.credentialFile };
  }
  throw new Error(
    `No deployment credential available for ${hostname} (no inventory credential on file, ` +
      "and DEPLOY_CREDENTIAL_FILE is not set)."
  );
}

/**
 * Picks this server's installer: a pre-built, location-specific EXE from a
 * shared network location when its inventory `location` has an entry in
 * installerByLocation, otherwise the single fallback INSTALLER_LOCAL_PATH.
 * See backend/scripts/Install-AgentRemote.ps1 and
 * D:\Project\ManageEngineAgentDeployer (the reference desktop tool this
 * per-location installer model was adapted from).
 */
function resolveInstallerPath(hostname) {
  const server = store.getServers()[hostname];
  const byLocation = config.deployment.installerByLocation || {};
  const fromLocation = server && server.location ? byLocation[server.location] : null;
  const installerPath = fromLocation || config.deployment.installerLocalPath;

  if (!installerPath) {
    throw new Error(
      server && server.location
        ? `No installer configured for location "${server.location}" and no fallback INSTALLER_LOCAL_PATH is set.`
        : "No installer configured (server has no location on file, and INSTALLER_LOCAL_PATH is not set)."
    );
  }
  if (!fs.existsSync(installerPath)) {
    throw new Error(`Installer not found at ${installerPath}.`);
  }
  return installerPath;
}

function runSingleDeployment(job, io) {
  return new Promise(async (resolve) => {
    await store.updateJob(job.id, { status: "Running" });
    io.emit("job:status", { jobId: job.id, hostname: job.hostname, status: "Running" });

    let credential;
    try {
      credential = await resolveCredential(job.hostname);
    } catch (err) {
      await failJob(job, io, `Could not resolve a deployment credential: ${err.message}`);
      return resolve();
    }

    let installerPath;
    try {
      installerPath = resolveInstallerPath(job.hostname);
    } catch (err) {
      await failJob(job, io, `Could not resolve an installer: ${err.message}`);
      return resolve();
    }

    const credentialArgs =
      credential.mode === "asset"
        ? ["-Username", credential.username]
        : ["-CredentialFile", credential.credentialFile];

    const { deployment } = config;
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      SCRIPT_PATH,
      "-TargetHost",
      job.hostname,
      "-InstallerPath",
      installerPath,
      ...credentialArgs,
      "-Method",
      deployment.method || "Auto",
      "-RemoteDir",
      deployment.remoteDir,
      "-ServiceName",
      deployment.serviceName,
      "-PsExecPath",
      deployment.psexecPath,
      "-WinRmPort",
      String(deployment.winrmPort),
    ];
    if (deployment.installArgs) args.push("-InstallArgs", deployment.installArgs);
    if (deployment.useHttps) args.push("-UseHttps");
    if (deployment.skipCertValidation) args.push("-SkipCertValidation");

    const child = spawn("powershell.exe", args, { windowsHide: true });

    // Hand the password to the script over stdin (never as a CLI arg, which
    // would be visible to anything that lists the process table) and never
    // log it. The script reads one line from stdin when -Username is used.
    if (credential.mode === "asset") {
      child.stdin.write(credential.password + "\n");
    }
    child.stdin.end();

    // Without this handler, a spawn failure (e.g. powershell.exe not found,
    // permissions issue) throws an uncaught 'error' event and crashes the
    // ENTIRE Node process - not just this one job. Handle it explicitly so
    // one bad target server can't take down deployments for everyone else.
    child.on("error", async (err) => {
      const message = `Failed to launch PowerShell: ${err.message}`;
      await store.appendJobLog(job.id, `ERROR: ${message}`);
      await store.updateJob(job.id, { status: "Failed", message, finishedAt: new Date().toISOString() });
      io.emit("job:log", { jobId: job.id, line: `ERROR: ${message}` });
      io.emit("job:status", { jobId: job.id, hostname: job.hostname, status: "Failed", message });
      resolve();
    });

    const handleLine = async (line) => {
      if (!line) return;
      await store.appendJobLog(job.id, line);
      io.emit("job:log", { jobId: job.id, line });

      const statusMatch = line.match(/^STATUS:\s*(\w+)\s*\|\s*(.*)$/);
      if (statusMatch) {
        const [, status, message] = statusMatch;
        await store.updateJob(job.id, { status, message });
        io.emit("job:status", { jobId: job.id, hostname: job.hostname, status, message });
      }
    };

    child.stdout.on("data", (chunk) => {
      chunk
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach(handleLine);
    });

    child.stderr.on("data", (chunk) => {
      chunk
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => handleLine(`ERROR: ${line}`));
    });

    child.on("close", async (code) => {
      const finalStatus = code === 0 ? "Success" : "Failed";
      const finishedAt = new Date().toISOString();
      const job2 = store.getJob(job.id);
      // Only override status if the script never emitted its own STATUS line
      const status = job2 && job2.status && job2.status !== "Running" ? job2.status : finalStatus;
      await store.updateJob(job.id, { status, finishedAt });
      io.emit("job:status", { jobId: job.id, hostname: job.hostname, status, finishedAt });
      resolve();
    });
  });
}

module.exports = { startDeployments };
