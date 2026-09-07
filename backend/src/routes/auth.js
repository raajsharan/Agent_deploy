const express = require("express");
const userStore = require("../userStore");

const router = express.Router();

// ---- Basic brute-force protection (per IP, in-memory) ----
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const attempts = new Map(); // ip -> { count, lockedUntil }

function isLockedOut(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) return true;
  if (rec.lockedUntil && Date.now() >= rec.lockedUntil) attempts.delete(ip);
  return false;
}

function recordFailure(ip) {
  const rec = attempts.get(ip) || { count: 0, lockedUntil: null };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    rec.count = 0;
  }
  attempts.set(ip, rec);
}

function recordSuccess(ip) {
  attempts.delete(ip);
}

router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip;

  if (isLockedOut(ip)) {
    return res.status(429).json({ error: "Too many failed attempts. Try again in a few minutes." });
  }
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const valid = await userStore.verifyPassword(username, password);
  if (!valid) {
    recordFailure(ip);
    return res.status(401).json({ error: "Invalid username or password." });
  }

  recordSuccess(ip);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Login failed. Try again." });
    req.session.username = username;
    res.json({ username });
  });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

router.get("/me", (req, res) => {
  if (req.session && req.session.username) {
    return res.json({ username: req.session.username });
  }
  res.status(401).json({ error: "Not logged in." });
});

function requireAuth(req, res, next) {
  if (req.session && req.session.username) return next();
  res.status(401).json({ error: "Authentication required." });
}

module.exports = { router, requireAuth };
