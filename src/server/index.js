#!/usr/bin/env node
// Personal live dashboard server. Zero deps. Run: `node src/server/index.js`
// (or `./start.sh` under launchd). Listens on http://localhost:7787.

const http = require("http");
const fs = require("fs");
const { PORT, CACHE_DIR } = require("./config");
const { jiraConfigured } = require("./jira");
const { fetchOriginMain } = require("./git");
const { handle } = require("./routes");

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const server = http.createServer(handle);

// `git fetch origin main` used to live on the buildModel critical path.
// Move it here: once at boot + every 5 minutes. The behind-counts read
// whatever ref the most-recent background tick pulled, which is fine
// because origin/main moves on a scale of minutes, not seconds.
const ORIGIN_FETCH_INTERVAL_MS = 5 * 60 * 1000;
fetchOriginMain().catch(() => {}); // boot-time; ignore failures
setInterval(() => {
  fetchOriginMain().catch(() => {});
}, ORIGIN_FETCH_INTERVAL_MS);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Live dashboard listening on http://localhost:${PORT}`);
  console.log(`Open in browser, or run:  open http://localhost:${PORT}`);
  console.log(
    `Jira: ${
      jiraConfigured()
        ? "configured"
        : "NOT configured (set ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN in .env)"
    }`
  );
});
