const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const session = require("express-session");
const { Server } = require("socket.io");

const { config, warnIfMissing } = require("./src/config");
const { router: serversRouter } = require("./src/routes/servers");
const { buildDeployRouter } = require("./src/routes/deploy");
const { router: authRouter, requireAuth } = require("./src/routes/auth");
const { router: settingsRouter } = require("./src/routes/settings");
const userStore = require("./src/userStore");

warnIfMissing();

if (!userStore.hasAnyUsers()) {
  console.warn(
    "[auth] No user accounts exist yet. Nobody can log in until you run:\n" +
      "  node scripts/create-user.js <username>"
  );
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: config.corsOrigin } });

app.set("trust proxy", 1); // needed for correct req.ip / secure cookies behind a reverse proxy

const sessionMiddleware = session({
  secret: config.session.secret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: config.session.cookieSecure,
    maxAge: config.session.maxAgeMs,
    sameSite: "lax",
  },
});

app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json());
app.use(sessionMiddleware);

// ---- Auth routes (public - this is how you get a session in the first place) ----
app.use("/api/auth", authRouter);
app.get("/api/health", (req, res) => res.json({ ok: true }));

// ---- Everything else under /api requires a logged-in session ----
app.use("/api/servers", requireAuth, serversRouter);
app.use("/api/deploy", requireAuth, buildDeployRouter(io));
app.use("/api/settings", requireAuth, settingsRouter);

// ---- Frontend ----
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");

// Static assets (css/fonts/icons/login page/login script) are public - they
// carry no data, and the login page itself obviously can't require login.
app.use("/styles", express.static(path.join(FRONTEND_DIR, "styles")));
app.get("/login.html", (req, res) => res.sendFile(path.join(FRONTEND_DIR, "login.html")));
app.get("/login.js", (req, res) => res.sendFile(path.join(FRONTEND_DIR, "login.js")));
// Note: requests to /socket.io/* never reach Express at all - socket.io's
// engine.io layer intercepts them at the http.Server level before Express
// sees them, so no explicit route for the socket.io client script is needed.

// Everything else in the frontend (the dashboard + its app.js) requires auth
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  if (req.session && req.session.username) return next();
  return res.redirect("/login.html");
});
app.use(express.static(FRONTEND_DIR));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// ---- Socket.IO also requires a valid session (shares the same cookie) ----
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const session = socket.request.session;
  if (session && session.username) return next();
  next(new Error("unauthorized"));
});

io.on("connection", (socket) => {
  console.log(`Frontend connected: ${socket.id} (user: ${socket.request.session.username})`);
});

server.listen(config.port, () => {
  console.log(`Agent Deployment Manager listening on http://localhost:${config.port}`);
});
