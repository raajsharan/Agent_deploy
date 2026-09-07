const { spawn } = require("child_process");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { config } = require("../config");
const store = require("../store");

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

function runSingleDeployment(job, io) {
  return new Promise(async (resolve) => {
    await store.updateJob(job.id, { status: "Running" });
    io.emit("job:status", { jobId: job.id, hostname: job.hostname, status: "Running" });

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
      config.deployment.installerLocalPath,
      "-CredentialFile",
      config.deployment.credentialFile,
    ];

    const child = spawn("powershell.exe", args, { windowsHide: true });

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
