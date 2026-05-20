// HTTP routing: parse the request, dispatch to a handler, fall back to
// serving static files from public/. index.js wires this into
// http.createServer.

const fs = require("fs");
const path = require("path");
const { STATIC_DIR, PORT } = require("./config");
const { cache, getData } = require("./cache");
const { getRecommendations, getRecsCacheState } = require("./recs");
const { restackStack } = require("./restack");
const {
  jiraConfigured,
  fetchJiraTransitions,
  performJiraTransition,
  closeJiraTicket,
} = require("./jira");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(STATIC_DIR, urlPath);
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type":
        MIME[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(buf);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/data") {
    try {
      const force = url.searchParams.get("refresh") === "1";
      const intelligent = url.searchParams.get("intelligent") === "1";
      const data = await getData(force, { intelligent });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message, stack: err.stack }));
    }
    return;
  }

  if (url.pathname === "/api/recommendations") {
    try {
      const force = url.searchParams.get("refresh") === "1";
      const recs = await getRecommendations(force);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(recs || { ts: null, html: "" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === "/api/restack" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const result = await restackStack(body?.stack_key);
      res.writeHead(result.ok ? 200 : 400, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // Jira transitions: list valid next-states for a ticket.
  if (url.pathname === "/api/jira/transitions" && req.method === "GET") {
    try {
      const key = url.searchParams.get("key") || "";
      const transitions = await fetchJiraTransitions(key);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, transitions }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // Jira transitions: perform one. Body: { key, transition_id }.
  if (url.pathname === "/api/jira/transition" && req.method === "POST") {
    try {
      const body = await readJson(req);
      await performJiraTransition(body?.key, body?.transition_id);
      // Bust the dashboard cache so the next /api/data picks up the new
      // status from Jira instead of the 30s-stale snapshot.
      cache.ts = 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // Batch-close jira tickets — used by the stale-worktree row's "Close
  // Jiras" button. Body: { keys: ["REV-1", "REV-2", ...] }. Returns
  // per-key {key, to: <status>} on success or {key, error} on failure.
  if (url.pathname === "/api/jira/close" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const keys = Array.isArray(body?.keys) ? body.keys : [];
      const results = await Promise.all(
        keys.map(async (key) => {
          try {
            const to = await closeJiraTicket(key);
            return { key, to };
          } catch (err) {
            return { key, error: err.message };
          }
        })
      );
      cache.ts = 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, results }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (url.pathname === "/api/health") {
    const recsState = getRecsCacheState();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        cached: !!cache.data,
        age_ms: Date.now() - cache.ts,
        recs_cached: recsState.cached,
        recs_ts: recsState.ts,
        jira_configured: jiraConfigured(),
      })
    );
    return;
  }

  serveStatic(req, res);
}

module.exports = { handle };
