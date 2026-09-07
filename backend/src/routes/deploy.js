const express = require("express");
const { startDeployments } = require("../services/deploymentService");
const store = require("../store");

function buildDeployRouter(io) {
  const router = express.Router();

  router.post("/", (req, res) => {
    const { hostnames } = req.body;
    if (!Array.isArray(hostnames) || hostnames.length === 0) {
      return res.status(400).json({ error: "Body must include a non-empty 'hostnames' array." });
    }
    const jobs = startDeployments(hostnames, io);
    res.status(202).json({ jobs });
  });

  router.get("/jobs/:id", (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found." });
    res.json(job);
  });

  router.get("/jobs", (req, res) => {
    res.json(Object.values(store.getAllJobs()).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)));
  });

  return router;
}

module.exports = { buildDeployRouter };
