#!/usr/bin/env node
// Personal live dashboard server. Zero deps. Run: `node src/server/index.js`
// (or `./start.sh` under launchd). Listens on http://localhost:7787.

const http = require("http");
const fs = require("fs");
const { PORT, CACHE_DIR } = require("./config");
const { jiraConfigured } = require("./jira");
const { handle } = require("./routes");

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const server = http.createServer(handle);

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
