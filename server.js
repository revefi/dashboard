#!/usr/bin/env node
// Personal live dashboard server. Zero deps. Run: `node server.js`
// Listens on http://localhost:7787 — gitignored, never committed.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec, execFile, spawn } = require("child_process");
const { promisify } = require("util");

const execP = promisify(exec);
const execFileP = promisify(execFile);

const REPO = "/Users/varun/Desktop/workspace/rcode";
const SESSIONS_ROOT = "/Users/varun/.claude/projects";
const MAIN_SESSIONS_DIR = `${SESSIONS_ROOT}/-Users-varun-Desktop-workspace-rcode`;
const PORT = parseInt(process.env.PORT || "7787", 10);
const CACHE_TTL_MS = 30_000;
const STATIC_DIR = path.join(__dirname, "public");
const CACHE_DIR = path.join(__dirname, "cache");
const RECS_CACHE_FILE = path.join(CACHE_DIR, "recommendations.json");

// ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN are read from the shell environment
// (set them in ~/.zshrc — see README).

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

let cache = { ts: 0, data: null, building: null };

// ---------- shell helpers ----------
async function sh(cmd, opts = {}) {
  const { stdout } = await execP(cmd, {
    cwd: REPO,
    maxBuffer: 50 * 1024 * 1024,
    ...opts,
  });
  return stdout;
}

async function shRetry(cmd, opts = {}, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await sh(cmd, opts);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1)
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

// Like sh() but pipes `input` to the child's stdin. Used when we need to send a
// multi-line payload (e.g. a GraphQL query) that's awkward to inline in the cmd.
async function shWithInput(cmd, input, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, {
      shell: true,
      cwd: REPO,
      ...opts,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`shell exit ${code}: ${stderr.slice(0, 500)}`));
    });
    proc.on("error", reject);
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

// ---------- gt log parsing ----------
function parseGtLog(text) {
  const lines = text.split("\n");
  const parsed = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    // Match: leading whitespace, glyph (↱◯◉), optional `─┴┘├` connectors, optional `$`, branch, rest.
    const m = line.match(/^(\s*)[↱◯◉][─┴┘├│\s]*\$?\s*(\S+)\s*(.*)$/);
    if (!m) continue;
    const depth = m[1].length;
    const branch = m[2];
    const rest = (m[3] || "").trim();
    const flags = (rest.match(/\(([^)]+)\)/g) || []).map((s) =>
      s.slice(1, -1).trim()
    );
    // Skip "(<worktree-name>)" annotations from flags by matching against a known worktree set later.
    parsed.push({ depth, branch, flags });
  }
  return parsed;
}

function buildStacksFromGtLog(parsedLines) {
  // Leaves are lines whose previous line has equal-or-less depth (top-of-stack).
  const stacks = [];
  for (let i = 0; i < parsedLines.length; i++) {
    const cur = parsedLines[i];
    if (cur.branch === "main") continue;
    const prev = parsedLines[i - 1];
    const isLeaf = !prev || prev.depth <= cur.depth;
    if (!isLeaf) continue;

    // Walk down: ancestors are subsequent lines with strictly smaller depth than current min.
    const chain = [cur];
    let minDepth = cur.depth;
    for (let j = i + 1; j < parsedLines.length; j++) {
      const nxt = parsedLines[j];
      if (nxt.depth < minDepth) {
        chain.push(nxt);
        minDepth = nxt.depth;
        if (nxt.branch === "main") break;
      }
    }
    // Drop trunk from chain (we render it separately).
    const trimmed = chain.filter((b) => b.branch !== "main");
    if (trimmed.length === 0) continue;
    stacks.push(trimmed);
  }
  return stacks;
}

// ---------- worktrees ----------
async function fetchWorktrees() {
  const stdout = await sh("git worktree list --porcelain");
  const out = [];
  let cur = {};
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) cur = { path: line.slice(9) };
    else if (line.startsWith("branch "))
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "") {
      if (cur.path) out.push(cur);
      cur = {};
    }
  }
  if (cur.path) out.push(cur);
  return out
    .filter((w) => w.path.includes("/.claude/worktrees/"))
    .map((w) => ({
      ...w,
      name: path.basename(w.path),
    }));
}

// Update remote-tracking ref so per-stack behind counts are fresh. Read-only
// w.r.t. local branches and worktrees.
async function fetchOriginMain() {
  try {
    await sh("git fetch origin main --quiet");
  } catch {
    // ignore — offline or transient; per-stack counts will use whatever
    // origin/main we have locally.
  }
}

// How many commits `origin/main` has that this stack's fork-point on main
// doesn't. Per-stack because different stacks can branch off different
// commits of main (e.g. created at different times, or partially restacked).
async function fetchStackBehind(branch) {
  try {
    const base = (
      await sh(`git merge-base ${branch} origin/main`)
    ).trim();
    if (!base) return 0;
    const out = await sh(`git rev-list --count ${base}..origin/main`);
    return parseInt(out.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

// Predict whether `gt restack` will hit conflicts by performing an in-memory
// 3-way merge between origin/main and the stack's leaf branch. Read-only —
// `git merge-tree --write-tree` writes objects to the loose-object store but
// never modifies refs or working trees. Exit 0 = clean, 1 = conflicts (with
// conflicting paths listed after the tree OID).
async function checkRestackConflicts(branch) {
  try {
    const { stdout } = await execP(
      `git merge-tree --write-tree --name-only --no-messages origin/main ${branch}`,
      { cwd: REPO, maxBuffer: 5 * 1024 * 1024 }
    );
    // exit 0 — first line is tree OID, no further output.
    return { ok: true, conflicts: [] };
  } catch (e) {
    if (e.code === 1 && e.stdout) {
      const lines = e.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      // First line is the (incomplete) tree OID; the rest are conflicting paths.
      const conflicts = [...new Set(lines.slice(1))];
      return { ok: false, conflicts };
    }
    // Other errors (missing branch, missing origin/main, etc.) — return null
    // so the UI can fall back to "unknown" rather than claiming success.
    return null;
  }
}

// ---------- PRs ----------
const GH_REPO_FLAG = "--repo revefi/rcode";
let cachedLogin = null;

async function getLogin() {
  if (cachedLogin) return cachedLogin;
  const stdout = await shRetry(`gh api user --jq .login`);
  cachedLogin = stdout.trim();
  return cachedLogin;
}

async function fetchOpenPRs() {
  // gh's --author filter returns 0 results when invoked under Node child_process for reasons
  // I cannot pin down — works fine from interactive shell. Workaround: fetch all open PRs via
  // gh pr list (no filter) and filter to my login client-side.
  const login = await getLogin();
  const stdout = await shRetry(
    `gh pr list ${GH_REPO_FLAG} --state open --limit 200 ` +
      `--json number,title,url,isDraft,createdAt,updatedAt,headRefName,baseRefName,reviewDecision,author`
  );
  const all = JSON.parse(stdout);
  return all.filter((p) => p.author?.login === login);
}

async function fetchRecentMergedPRs() {
  const stdout = await shRetry(
    `gh api "repos/revefi/rcode/pulls?state=closed&per_page=50" ` +
      `--jq '[.[] | select(.user.login | test("varun"; "i")) | select(.merged_at != null) | ` +
      `{n: .number, h: .head.ref, b: .base.ref, m: .merged_at, t: .title}]'`
  );
  return JSON.parse(stdout || "[]");
}

async function fetchAnyPR(branch) {
  try {
    const stdout = await shRetry(
      `gh pr list ${GH_REPO_FLAG} --search "head:${branch}" --state all --limit 1 ` +
        `--json number,state,title,url,headRefName,author`
    );
    const arr = JSON.parse(stdout);
    return arr[0] || null;
  } catch {
    return null;
  }
}

async function fetchPRMeta(num) {
  try {
    const stdout = await shRetry(
      `gh pr view ${num} ${GH_REPO_FLAG} --json number,title,url,reviewDecision,headRefName,updatedAt,author,state`
    );
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

// Fetch unresolved review-thread counts AND CI check rollup for many PRs in
// a single GraphQL request. Uses aliased fields
// (`p<NUM>: repository(...) { pullRequest(number: NUM) {...} }`) so we get
// the full set in one network round-trip instead of one per PR.
async function fetchPrSignalsBulk(nums) {
  if (!nums || nums.length === 0) return new Map();
  const aliasFor = (n) => `p${n}`;
  const fragments = nums
    .map(
      (n) => `
  ${aliasFor(n)}: repository(owner: "revefi", name: "rcode") {
    pullRequest(number: ${n}) {
      reviewThreads(first: 50) {
        nodes { isResolved comments(first: 1) { nodes { author { login } } } }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun { name conclusion status startedAt }
                  ... on StatusContext { context state createdAt }
                }
              }
            }
          }
        }
      }
    }
  }`
    )
    .join("");
  const query = `query {${fragments}\n}`;

  const result = new Map();
  for (const n of nums) {
    result.set(n, { human: 0, bot: 0, checks: null });
  }
  try {
    const stdout = await shWithInput(`gh api graphql -F query=@-`, query);
    const json = JSON.parse(stdout);
    const data = json?.data || {};
    for (const n of nums) {
      const pr = data[aliasFor(n)]?.pullRequest;
      const threadNodes = pr?.reviewThreads?.nodes || [];
      let h = 0,
        b = 0;
      for (const node of threadNodes) {
        if (node.isResolved) continue;
        const isBot = node.comments?.nodes?.[0]?.author?.login === "claude";
        if (isBot) b++;
        else h++;
      }
      result.set(n, {
        human: h,
        bot: b,
        checks: summarizeChecks(pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup),
      });
    }
  } catch (err) {
    console.warn("[pr-signals] bulk fetch failed:", err.message);
  }
  return result;
}

// Collapse the GraphQL statusCheckRollup into the shape the dashboard needs.
//
// Critical: we DEDUPE by check name and keep only the latest run. When a CI
// re-run happens (or a workflow gets superseded by a new push), the earlier
// run is left in place with conclusion=CANCELLED — counting those as
// failures is wrong (and is exactly why GitHub's own `state` field returns
// FAILURE while `gh pr checks` shows the PR as passing). Dedup gives us the
// same view as `gh pr checks`.
function summarizeChecks(rollup) {
  if (!rollup) return null;
  const FAIL_CONCLUSIONS = new Set([
    "FAILURE",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
  ]);
  const FAIL_STATUSES = new Set(["FAILURE", "ERROR"]);
  const ctxNodes = rollup.contexts?.nodes || [];

  // Keep the latest run per name. CheckRun → use startedAt; StatusContext →
  // use createdAt. Both are ISO 8601 strings so plain string compare works.
  const latest = new Map(); // name → node
  for (const c of ctxNodes) {
    const name =
      c.__typename === "CheckRun"
        ? c.name
        : c.__typename === "StatusContext"
        ? c.context
        : null;
    if (!name) continue;
    const ts = c.startedAt || c.createdAt || "";
    const key = `${c.__typename}:${name}`;
    const prev = latest.get(key);
    if (!prev || ts > (prev.startedAt || prev.createdAt || "")) {
      latest.set(key, c);
    }
  }

  const failing = [];
  let running = 0;
  let total = 0;
  for (const c of latest.values()) {
    total++;
    if (c.__typename === "CheckRun") {
      if (c.status === "IN_PROGRESS" || c.status === "QUEUED" || c.status === "PENDING") {
        running++;
      } else if (c.conclusion && FAIL_CONCLUSIONS.has(c.conclusion)) {
        failing.push(c.name);
      }
      // CANCELLED / SKIPPED / NEUTRAL on the *latest* run aren't treated as
      // failures — matches `gh pr checks` and Graphite.
    } else if (c.__typename === "StatusContext") {
      if (c.state === "PENDING" || c.state === "EXPECTED") running++;
      else if (c.state && FAIL_STATUSES.has(c.state)) failing.push(c.context);
    }
  }

  // Compute our own rollup state — GitHub's `state` field counts the
  // superseded runs.
  let state;
  if (failing.length > 0) state = "FAILURE";
  else if (running > 0) state = "PENDING";
  else if (total > 0) state = "SUCCESS";
  else state = null;

  return { state, failing, running, total };
}

// ---------- Claude CLI helper ----------
function callClaude(prompt, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "text"];
    if (opts.model !== false)
      args.push("--model", opts.model || "claude-haiku-4-5");
    if (opts.allowedTools) args.push("--allowedTools", opts.allowedTools);
    const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("claude timed out after 90s"));
    }, opts.timeoutMs || 90_000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude exit ${code}: ${stderr.slice(0, 500)}`));
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// Try to extract a JSON object/array from Claude's text response (it may wrap with prose or fences).
function parseJsonLoose(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1];
  const firstBrace = Math.min(
    ...["{", "["].map((c) => {
      const i = text.indexOf(c);
      return i === -1 ? Infinity : i;
    })
  );
  if (!isFinite(firstBrace)) return null;
  // Find matching close — naive but works since Claude output is usually clean.
  const candidate = text.slice(firstBrace);
  // Try progressively shorter slices until JSON parses.
  for (let end = candidate.length; end > 0; end--) {
    try {
      return JSON.parse(candidate.slice(0, end));
    } catch {}
  }
  return null;
}

// Disk cache helper with TTL.
function loadDiskCache(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw.expiresAt && new Date(raw.expiresAt).getTime() < Date.now())
      return null;
    return raw.data;
  } catch {
    return null;
  }
}
function saveDiskCache(file, data, ttlMs) {
  try {
    const payload = {
      data,
      expiresAt: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null,
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.warn(`[disk-cache] save failed for ${file}:`, err.message);
  }
}

const STACK_NAMES_CACHE_FILE = path.join(CACHE_DIR, "stack-names.json");
const STACK_NAMES_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (regenerates on PR-set change anyway)

// ---------- Jira ----------
const JIRA_BASE = "https://revefi.atlassian.net";

function jiraConfigured() {
  return !!(process.env.ATLASSIAN_EMAIL && process.env.ATLASSIAN_API_TOKEN);
}

async function jiraGet(pathStr) {
  if (!jiraConfigured()) return null;
  const auth = Buffer.from(
    `${process.env.ATLASSIAN_EMAIL}:${process.env.ATLASSIAN_API_TOKEN}`
  ).toString("base64");
  const res = await fetch(`${JIRA_BASE}${pathStr}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Jira ${pathStr}: ${res.status}`);
  return res.json();
}

async function jiraPost(pathStr, body) {
  if (!jiraConfigured()) return null;
  const auth = Buffer.from(
    `${process.env.ATLASSIAN_EMAIL}:${process.env.ATLASSIAN_API_TOKEN}`
  ).toString("base64");
  const res = await fetch(`${JIRA_BASE}${pathStr}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jira ${pathStr}: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ---------- Jira (direct REST) ----------
// Fast (~50ms/ticket), so we fetch fresh on every buildModel — no disk cache.
// Without ATLASSIAN_* in the env, all calls return empty and the UI shows a
// "Jira not configured" hint.

function parseActiveSprint(field) {
  // Sprint custom field: array of sprint objects with id/name/state/startDate/endDate.
  if (!Array.isArray(field)) return null;
  const chosen =
    field.find((s) => s && s.state === "active") ||
    field[field.length - 1] ||
    null;
  if (!chosen) return null;
  return {
    id: chosen.id,
    name: chosen.name,
    state: chosen.state,
    start_date: chosen.startDate || null,
    end_date: chosen.endDate || null,
  };
}

async function fetchJiraTickets(keys) {
  if (keys.length === 0 || !jiraConfigured()) return {};
  const fields = "summary,issuetype,status,priority,updated";
  const entries = await Promise.all(
    keys.map(async (key) => {
      try {
        const data = await jiraGet(
          `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`
        );
        if (!data) return null;
        return [
          key,
          {
            key: data.key,
            summary: data.fields.summary,
            type: data.fields.issuetype?.name || "Task",
            status: data.fields.status?.name || "",
            priority: data.fields.priority?.name || "Medium",
            updated: data.fields.updated,
          },
        ];
      } catch {
        return null;
      }
    })
  );
  return Object.fromEntries(entries.filter(Boolean));
}

async function fetchJiraTicket(key) {
  const map = await fetchJiraTickets([key]);
  return map[key] || null;
}

async function fetchOpenJiraTickets() {
  if (!jiraConfigured()) return [];
  try {
    const data = await jiraPost(`/rest/api/3/search/jql`, {
      jql: "assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, updated DESC",
      // customfield_10020 = "Sprint" on revefi.atlassian.net.
      fields: [
        "summary",
        "issuetype",
        "status",
        "priority",
        "updated",
        "created",
        "customfield_10020",
      ],
      maxResults: 50,
    });
    if (!data || !data.issues) return [];
    return data.issues.map((i) => ({
      key: i.key,
      summary: i.fields.summary,
      type: i.fields.issuetype?.name || "Task",
      status: i.fields.status?.name || "",
      priority: i.fields.priority?.name || "Medium",
      updated: i.fields.updated,
      created: i.fields.created,
      sprint: parseActiveSprint(i.fields.customfield_10020),
    }));
  } catch (err) {
    console.warn("[jira] fetchOpenJiraTickets failed:", err.message);
    return [];
  }
}

// ---------- session scoring ----------
function listSessions(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      sid: f.slice(0, -".jsonl".length),
      file: path.join(dir, f),
    }));
}

async function scoreSessionsForStack(keywords, worktreeName) {
  const dirs = [MAIN_SESSIONS_DIR];
  if (worktreeName) {
    dirs.push(
      `${SESSIONS_ROOT}/-Users-varun-Desktop-workspace-rcode--claude-worktrees-${worktreeName}`
    );
  }
  const pat = keywords
    .filter(Boolean)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!pat) return null;

  const escPat = pat.replace(/'/g, `'\\''`);
  const targets = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of listSessions(dir)) targets.push({ ...f, dir });
  }

  // Parallel grep across all session files. ~60 files in parallel run in well
  // under a second on macOS; sequential awaits used to take seconds per stack.
  const results = (
    await Promise.all(
      targets.map(async ({ sid, file, dir }) => {
        try {
          const { stdout } = await execP(
            `grep -cE '${escPat}' '${file.replace(/'/g, `'\\''`)}'`
          );
          const count = parseInt(stdout.trim(), 10) || 0;
          if (count <= 0) return null;
          const stat = fs.statSync(file);
          return { sid, count, mtime: stat.mtimeMs, dir };
        } catch {
          // grep exit 1 = no matches.
          return null;
        }
      })
    )
  ).filter(Boolean);
  if (results.length === 0) return null;
  results.sort((a, b) => b.count - a.count || b.mtime - a.mtime);
  const top = results[0];
  const isWorktreeDir = top.dir !== MAIN_SESSIONS_DIR;
  return {
    sid: top.sid,
    in_worktree: isWorktreeDir,
    worktree_name: isWorktreeDir ? worktreeName : null,
  };
}

// ---------- title parsing ----------
function parseTitle(title) {
  // Extract [REV-XXXX] or [NO-JIRA] and [Part N] prefixes, return remainder.
  let body = title;
  let jiraTag = null,
    partTag = null;
  const jm = body.match(/^\[(REV-\d+|NO-JIRA)\]\s*/);
  if (jm) {
    jiraTag = jm[1];
    body = body.slice(jm[0].length);
  }
  const pm = body.match(/^\[(Part [^\]]+)\]\s*/);
  if (pm) {
    partTag = `[${pm[1]}]`;
    body = body.slice(pm[0].length);
  }
  return { jira_tag: jiraTag, part_tag: partTag, title: body.trim() };
}

function relTime(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const ageDays = (Date.now() - then) / 86_400_000;
  if (ageDays < 1) return "today";
  return `${Math.floor(ageDays)}d ago`;
}

function deriveStatus(decision, isBottom, isUserPR) {
  if (!isUserPR) {
    if (decision === "APPROVED") return { label: "Approved", cls: "ok" };
    if (decision === "CHANGES_REQUESTED")
      return { label: "Changes requested", cls: "warn" };
    return { label: "Needs review", cls: "primary" };
  }
  if (decision === "APPROVED")
    return isBottom
      ? { label: "Approved", cls: "ok" }
      : { label: "Waiting on downstream", cls: "ok" };
  if (decision === "CHANGES_REQUESTED")
    return { label: "Changes requested", cls: "warn" };
  return { label: "Needs review", cls: "primary" };
}

// ---------- model assembly ----------
async function buildModel() {
  const [gtLogText, openPRs, mergedPRs, worktrees] = await Promise.all([
    sh("gt log short --no-interactive --classic"),
    fetchOpenPRs(),
    fetchRecentMergedPRs(),
    fetchWorktrees(),
    fetchOriginMain(),
  ]);

  const parsedLines = parseGtLog(gtLogText);
  const rawStacks = buildStacksFromGtLog(parsedLines);

  const branchToOpenPR = new Map(openPRs.map((p) => [p.headRefName, p]));
  const branchToMergedPR = new Map(mergedPRs.map((p) => [p.h, p]));
  const worktreeNameSet = new Set(worktrees.map((w) => w.name));
  const worktreeBranchToWT = new Map(worktrees.map((w) => [w.branch, w]));

  // Partition each stack into user_segment (top, has user PRs) vs upstream_segment (below).
  const enrichedStacks = [];
  for (const chain of rawStacks) {
    // chain is leaf-first.
    const userBranches = [];
    const upstreamBranches = [];
    let inUserSegment = true;
    for (const b of chain) {
      const openPR = branchToOpenPR.get(b.branch);
      const isUserBranch = !!openPR;
      if (inUserSegment && isUserBranch) {
        userBranches.push({ ...b, pr: openPR, isUser: true });
      } else if (inUserSegment && !isUserBranch) {
        // Could be merged user PR (in-stack history). Keep walking but switch to upstream once we hit non-user.
        const merged = branchToMergedPR.get(b.branch);
        if (merged) {
          // Recently merged user PR — still user segment.
          userBranches.push({ ...b, pr: merged, isUser: true, isMerged: true });
        } else {
          inUserSegment = false;
          upstreamBranches.push(b);
        }
      } else {
        upstreamBranches.push(b);
      }
    }
    if (userBranches.length === 0) continue;
    if (!userBranches.some((u) => u.pr && !u.isMerged)) continue;

    enrichedStacks.push({ userBranches, upstreamBranches, allBranches: chain });
  }

  // Look up review decisions for upstream branches that have open PRs.
  const upstreamLookups = new Map();
  for (const s of enrichedStacks) {
    for (const ub of s.upstreamBranches) {
      // Find any open PR for this branch (could be by another author).
      // Cheap lookup via gh pr list --search head:<branch>.
      if (!upstreamLookups.has(ub.branch)) {
        upstreamLookups.set(ub.branch, fetchAnyPR(ub.branch));
      }
    }
  }
  const upstreamPRMap = new Map();
  for (const [branch, p] of upstreamLookups) {
    const result = await p;
    if (result && result.state === "OPEN") upstreamPRMap.set(branch, result);
  }
  // Fetch full meta (review decisions) for each upstream PR.
  const upstreamMetaMap = new Map();
  await Promise.all(
    [...upstreamPRMap.values()].map(async (pr) => {
      const meta = await fetchPRMeta(pr.number);
      if (meta) upstreamMetaMap.set(pr.headRefName, meta);
    })
  );

  // Fetch review threads for all user PRs in ONE bulk GraphQL query (aliased fields).
  const allUserPRNums = enrichedStacks.flatMap((s) =>
    s.userBranches.filter((u) => u.pr && !u.isMerged).map((u) => u.pr.number)
  );
  const prSignals = await fetchPrSignalsBulk(allUserPRNums);

  // Pre-compute jiraKeys + worktree per stack so we can kick off all session-scoring
  // calls in parallel up front (each scoring call grep's ~60 JSONL files; serializing
  // them across stacks turned a few-hundred-ms job into seconds).
  const enrichedMeta = enrichedStacks.map((es) => {
    const userOpenPRs = es.userBranches.filter((u) => u.pr && !u.isMerged);
    const userMergedPRs = es.userBranches.filter((u) => u.isMerged);
    const jiraKeysSet = new Set();
    for (const u of userOpenPRs) {
      const t = parseTitle(u.pr.title);
      if (t.jira_tag && t.jira_tag !== "NO-JIRA") jiraKeysSet.add(t.jira_tag);
    }
    const jiraKeys = [...jiraKeysSet].sort();
    let worktree = null;
    for (const u of es.userBranches) {
      if (worktreeBranchToWT.has(u.branch)) {
        worktree = worktreeBranchToWT.get(u.branch);
        break;
      }
    }
    const keywords = [
      ...userOpenPRs.map((u) => String(u.pr.number)),
      ...userMergedPRs.map((u) => String(u.pr.n || u.pr.number)),
      ...es.userBranches.map((u) => u.branch),
      ...jiraKeys,
      worktree?.name,
    ];
    return { es, userOpenPRs, userMergedPRs, jiraKeys, worktree, keywords };
  });
  const resumePromises = enrichedMeta.map((m) =>
    scoreSessionsForStack(m.keywords, m.worktree?.name)
  );

  // Per-stack "commits behind origin/main" — uses the leaf branch's merge-base
  // with origin/main. Stacks created/restacked at different times can have
  // different bases, so we don't share a single number.
  const behindPromises = enrichedMeta.map((m) =>
    fetchStackBehind(m.es.userBranches[0].branch)
  );
  // Per-stack restack-conflict prediction (in-memory 3-way merge against
  // origin/main). Lets the UI disable the Restack button when conflicts
  // are guaranteed.
  const conflictPromises = enrichedMeta.map((m) =>
    checkRestackConflicts(m.es.userBranches[0].branch)
  );

  // Build final model.
  const stacks = [];
  for (let stackIdx = 0; stackIdx < enrichedMeta.length; stackIdx++) {
    const { es, userOpenPRs, userMergedPRs, jiraKeys, worktree } = enrichedMeta[stackIdx];

    // Build PRs (top → bottom).
    const userPRsRender = userOpenPRs.map((u, i) => {
      const t = parseTitle(u.pr.title);
      const isBottom = i === userOpenPRs.length - 1;
      const status = deriveStatus(
        u.pr.reviewDecision || "REVIEW_REQUIRED",
        isBottom,
        true
      );
      const sig = prSignals.get(u.pr.number) || {
        human: 0,
        bot: 0,
        checks: null,
      };
      return {
        num: u.pr.number,
        url: `https://app.graphite.com/github/pr/revefi/rcode/${u.pr.number}`,
        title: t.title,
        jira_tag: t.jira_tag,
        part_tag: t.part_tag,
        is_draft: !!u.pr.isDraft,
        decision: u.pr.reviewDecision || "REVIEW_REQUIRED",
        status_label: status.label,
        status_class: status.cls,
        human_comments: sig.human,
        bot_comments: sig.bot,
        // Suppress check chip on drafts — CI may not run, and the review
        // pill will already be replaced by a "Draft" chip on the frontend.
        checks: u.pr.isDraft ? null : sig.checks,
        updated_label: relTime(u.pr.updatedAt),
        needs_restack: u.flags && u.flags.includes("needs restack"),
      };
    });

    // Counts.
    const counts = {
      created: userOpenPRs.length,
      merged: userMergedPRs.length,
      approved: userPRsRender.filter((p) => p.decision === "APPROVED").length,
      pending: userPRsRender.filter(
        (p) => p.decision !== "APPROVED" && p.decision !== "CHANGES_REQUESTED"
      ).length,
      changes_requested: userPRsRender.filter(
        (p) => p.decision === "CHANGES_REQUESTED"
      ).length,
    };

    // Upstream PRs render.
    const upstreamPRsRender = es.upstreamBranches
      .map((ub) => upstreamMetaMap.get(ub.branch))
      .filter(Boolean)
      .map((meta) => {
        const t = parseTitle(meta.title);
        const status = deriveStatus(
          meta.reviewDecision || "REVIEW_REQUIRED",
          false,
          false
        );
        return {
          num: meta.number,
          url: meta.url,
          title: t.title,
          jira_tag: t.jira_tag,
          part_tag: t.part_tag,
          author: meta.author?.login || "unknown",
          decision: meta.reviewDecision || "REVIEW_REQUIRED",
          status_label: status.label,
          status_class: status.cls,
          updated_label: relTime(meta.updatedAt),
        };
      });

    // Upstream summary stats.
    let upstream = null;
    if (upstreamPRsRender.length > 0) {
      const approved = upstreamPRsRender.filter(
        (p) => p.decision === "APPROVED"
      ).length;
      const cr = upstreamPRsRender.filter(
        (p) => p.decision === "CHANGES_REQUESTED"
      ).length;
      const rr = upstreamPRsRender.length - approved - cr;
      upstream = {
        n: upstreamPRsRender.length,
        author: upstreamPRsRender[0]?.author || "unknown",
        approved,
        changes_requested: cr,
        review_required: rr,
      };
    }

    // Stack category.
    const anyHumanComments = userPRsRender.some((p) => p.human_comments > 0);
    const allApproved = userPRsRender.every((p) => p.decision === "APPROVED");
    let category, categoryLabel;
    if (anyHumanComments) {
      category = "human_review";
      categoryLabel = "Address review comments";
    } else if (
      allApproved &&
      (!upstream ||
        upstream.changes_requested + upstream.review_required === 0) &&
      !upstream
    ) {
      category = "ready";
      categoryLabel = "Ready to merge";
    } else if (
      allApproved &&
      upstream &&
      upstream.changes_requested + upstream.review_required === 0
    ) {
      category = "blocked_upstream";
      categoryLabel = "Blocked upstream";
    } else if (allApproved && upstream) {
      category = "blocked_upstream";
      categoryLabel = "Blocked upstream";
    } else {
      category = "awaiting_review";
      categoryLabel = "Awaiting review";
    }

    const needsRestack = userPRsRender.some((p) => p.needs_restack);

    // Stack name: bottom PR title (closest-to-trunk usually has the most descriptive name).
    const bottomPR = userOpenPRs[userOpenPRs.length - 1];
    const baseTitle = bottomPR
      ? parseTitle(bottomPR.pr.title).title
      : es.userBranches[0].branch;
    const stackName =
      baseTitle.replace(/\s*\|\s*/g, " — ").slice(0, 100) ||
      es.userBranches[0].branch;

    const stackKey =
      jiraKeys.length > 0
        ? jiraKeys.join("+")
        : `NO-JIRA-${es.userBranches[es.userBranches.length - 1].branch}`;

    // Resume session + behind + conflict promises were kicked off up front.
    const resume = await resumePromises[stackIdx];
    const behindOrigin = await behindPromises[stackIdx];
    const restackCheck = await conflictPromises[stackIdx];

    stacks.push({
      stack_key: stackKey,
      jira_keys: jiraKeys,
      name: stackName,
      category,
      category_label: categoryLabel,
      needs_restack: needsRestack,
      behind_origin: behindOrigin,
      restack_check: restackCheck,
      top_pr: userPRsRender[0]
        ? { num: userPRsRender[0].num, url: userPRsRender[0].url }
        : null,
      counts,
      upstream,
      worktree: worktree
        ? { name: worktree.name, path: worktree.path, branch: worktree.branch }
        : null,
      resume,
      prs: userPRsRender,
      upstream_prs: upstreamPRsRender,
    });
  }

  // Improve stack names via Claude (cached on disk by PR-set hash so it only regens
  // when a stack's PRs actually change). On any failure we keep the fallback name.
  await enhanceStackNamesWithClaude(stacks);

  // Order stacks by category priority.
  const categoryOrder = {
    human_review: 0,
    ready: 1,
    blocked_upstream: 2,
    awaiting_review: 3,
    other: 4,
  };
  stacks.sort(
    (a, b) =>
      (categoryOrder[a.category] ?? 9) - (categoryOrder[b.category] ?? 9)
  );

  // Stale worktrees.
  const activeBranches = new Set(openPRs.map((p) => p.headRefName));
  const staleResults = await Promise.all(
    worktrees.map(async (w) => {
      if (activeBranches.has(w.branch)) return null;
      const anyPR = await fetchAnyPR(w.branch);
      if (anyPR) {
        if (anyPR.state === "MERGED") {
          return { ...w, reason: `PR #${anyPR.number} merged`, pr_num: anyPR.number, pr_url: anyPR.url };
        }
        if (anyPR.state === "CLOSED") {
          return { ...w, reason: `PR #${anyPR.number} closed without merge`, pr_num: anyPR.number, pr_url: anyPR.url };
        }
        return null;
      }
      try {
        const { stdout } = await execP(
          `git -C '${w.path}' log main..HEAD --oneline | head -1`
        );
        if (!stdout.trim()) {
          return { ...w, reason: "Branch fully merged into main (no unique commits)", pr_num: null, pr_url: null };
        }
      } catch {
        // ignore — git error means we just don't classify this worktree as stale
      }
      return null;
    })
  );
  const staleWorktrees = staleResults.filter(Boolean);

  // Enrich stacks with Jira chip data (key + summary).
  const allJiraKeys = [...new Set(stacks.flatMap((s) => s.jira_keys))];
  const ticketsByKey = new Map();
  if (allJiraKeys.length > 0) {
    const map = await fetchJiraTickets(allJiraKeys);
    for (const [k, v] of Object.entries(map)) if (v) ticketsByKey.set(k, v);
  }
  for (const s of stacks) {
    s.jira_chips = s.jira_keys.map((k) => {
      const t = ticketsByKey.get(k);
      return {
        key: k,
        summary: t?.summary || null,
        url: `https://revefi.atlassian.net/browse/${k}`,
      };
    });
  }

  // Untouched Jira: tickets assigned to me, not associated with any active stack.
  const openJiraTickets = await fetchOpenJiraTickets();
  const inStackKeys = new Set(allJiraKeys);
  const untouchedJira = openJiraTickets
    .filter((t) => !inStackKeys.has(t.key))
    .map((t, idx) => ({
      rank: idx + 1,
      key: t.key,
      url: `https://revefi.atlassian.net/browse/${t.key}`,
      type: t.type,
      summary: t.summary,
      priority: t.priority,
      updated: t.updated,
      updated_label: relTime(t.updated),
      note: deriveJiraNote(t),
      sprint: t.sprint || null,
    }));

  // Totals.
  const allUserPRs = stacks.flatMap((s) => s.prs);
  const totals = {
    stacks: stacks.length,
    open_prs: allUserPRs.length,
    approved: allUserPRs.filter((p) => p.decision === "APPROVED").length,
    pending: allUserPRs.filter(
      (p) => p.decision !== "APPROVED" && p.decision !== "CHANGES_REQUESTED"
    ).length,
    changes_requested: allUserPRs.filter(
      (p) => p.decision === "CHANGES_REQUESTED"
    ).length,
  };

  return {
    meta: {
      generated_at: new Date().toISOString(),
      date: new Date().toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
      totals,
      jira_configured: jiraConfigured(),
    },
    stacks,
    untouched_jira: untouchedJira,
    stale_worktrees: staleWorktrees,
  };
}

function deriveJiraNote(t) {
  if (t.type === "Bug") return "Customer-visible";
  return "—";
}

// ---------- stack-name generation (Claude, cached by PR-set hash) ----------
function stackPrHash(stack) {
  return [...stack.prs.map((p) => p.num)].sort((a, b) => a - b).join(",");
}
function stackNameCacheKey(stack) {
  return `${stack.stack_key}:${stackPrHash(stack)}`;
}

async function enhanceStackNamesWithClaude(stacks) {
  // Load disk cache once (already TTL-checked by loadDiskCache).
  const cached = loadDiskCache(STACK_NAMES_CACHE_FILE) || {};

  // Apply cached names + collect stacks needing fresh names.
  const needs = [];
  for (const s of stacks) {
    const ck = stackNameCacheKey(s);
    if (cached[ck]) {
      s.name = cached[ck];
    } else {
      needs.push({ ck, stack: s });
    }
  }
  if (needs.length === 0) return;

  // Build a single Claude prompt for all stacks at once.
  const payload = needs.reduce((acc, { ck, stack }) => {
    acc[ck] = stack.prs.map((p) => {
      const tag = p.jira_tag ? `[${p.jira_tag}]` : "";
      const part = p.part_tag || "";
      return `${tag}${part} ${p.title}`.trim();
    });
    return acc;
  }, {});

  const prompt =
    `Generate a short, descriptive stack name (4-7 words, Title Case, no quotes, no trailing punctuation) ` +
    `for each PR stack below. The name should capture the WHAT of the stack, not the individual parts. ` +
    `Avoid generic words like "stack" or "PRs". Use "&" or "+" to combine when a stack covers multiple themes.\n\n` +
    `Output ONLY a JSON object mapping the original key to the generated name. No preamble, no fences.\n\n` +
    `Stacks (key → list of PR titles, top to bottom):\n${JSON.stringify(
      payload,
      null,
      2
    )}`;

  let parsed;
  try {
    const out = await callClaude(prompt, { timeoutMs: 60_000 });
    parsed = parseJsonLoose(out);
  } catch (err) {
    console.warn("[stack-names] callClaude failed:", err.message);
    return;
  }
  if (!parsed || typeof parsed !== "object") return;

  for (const { ck, stack } of needs) {
    const name = parsed[ck];
    if (typeof name === "string" && name.trim()) {
      stack.name = name.trim();
      cached[ck] = stack.name;
    }
  }
  saveDiskCache(STACK_NAMES_CACHE_FILE, cached, STACK_NAMES_TTL_MS);
}

// ---------- caching ----------
function clearClaudeBackedCaches() {
  // Stack names are the only Claude-backed disk cache now (Jira goes through direct REST).
  try {
    fs.unlinkSync(STACK_NAMES_CACHE_FILE);
  } catch {
    /* file may not exist */
  }
}

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

// Restack a stack onto origin/main by running `gt restack` inside its worktree.
// Heavily guarded:
//   - looks up the stack by key from current model (no client-supplied paths)
//   - refuses if the stack has upstream PRs (would skip over someone else's work)
//   - refuses if the stack has no worktree (gt sync from main handles those)
//   - refuses if the worktree has uncommitted changes (would clobber WIP)
//   - on any failure runs `git rebase --abort` to leave the branch state clean
async function restackStack(stackKey) {
  if (!stackKey || typeof stackKey !== "string") {
    return { ok: false, error: "stack_key required" };
  }
  // Always read fresh — we want the up-to-date worktree path and behind count.
  const model = await getData(true);
  const stack = model.stacks.find((s) => s.stack_key === stackKey);
  if (!stack) return { ok: false, error: `unknown stack ${stackKey}` };
  if (stack.upstream) {
    return {
      ok: false,
      error:
        "Stack sits on top of upstream PRs from another author — restacking onto origin/main would skip past them. Restack manually.",
    };
  }
  if (!stack.worktree?.path) {
    return {
      ok: false,
      error:
        "Stack has no worktree. Run `gt sync` from the main checkout instead.",
    };
  }
  if ((stack.behind_origin || 0) === 0) {
    return { ok: false, error: "Already up to date with origin/main." };
  }
  if (stack.restack_check && stack.restack_check.ok === false) {
    return {
      ok: false,
      error:
        `Predicted merge conflicts in:\n  ${stack.restack_check.conflicts.join(
          "\n  "
        )}\n\nResolve manually with \`gt restack\` in the worktree, then retry.`,
    };
  }

  const wt = stack.worktree.path;
  // Reject if anything is uncommitted in the worktree — gt restack would refuse
  // anyway, and we don't want to touch a dirty tree.
  try {
    const dirty = (
      await execP(`git -C '${wt}' status --porcelain`, { maxBuffer: 1e6 })
    ).stdout.trim();
    if (dirty) {
      return {
        ok: false,
        error: `Worktree has uncommitted changes. Commit or stash before restacking.\n\n${dirty
          .split("\n")
          .slice(0, 10)
          .join("\n")}`,
      };
    }
  } catch (e) {
    return { ok: false, error: `git status failed: ${e.message}` };
  }

  // Run `gt restack`. On conflict gt leaves a half-finished rebase in place; we
  // detect that via the rebase-state files and abort to restore the branch.
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const r = await execP(`gt restack`, {
      cwd: wt,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 120_000,
    });
    stdout = r.stdout;
    stderr = r.stderr;
  } catch (e) {
    exitCode = e.code || 1;
    stdout = e.stdout || "";
    stderr = e.stderr || e.message || "";
  }

  // Check for an in-progress rebase regardless of exit code — belt-and-braces.
  const inRebase = await isRebaseInProgress(wt);
  if (inRebase || exitCode !== 0) {
    let abortMsg = "";
    if (inRebase) {
      try {
        await execP(`git -C '${wt}' rebase --abort`);
        abortMsg = "Aborted in-progress rebase; branch state restored.";
      } catch (e) {
        abortMsg = `WARNING: failed to abort rebase: ${e.message}. Investigate worktree manually.`;
      }
    }
    // Invalidate cache so next /api/data refetches even though nothing changed
    // — keeps the UI consistent if the user hits ↻ Refresh.
    cache.ts = 0;
    return {
      ok: false,
      error: [
        "gt restack failed.",
        abortMsg,
        "--- stdout ---",
        stdout.slice(-2000),
        "--- stderr ---",
        stderr.slice(-2000),
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  // Restack succeeded locally. Now push the rewritten branches so the GitHub
  // PRs reflect the new commits. `-u` (update-only) prevents creating new PRs;
  // `--no-edit --no-interactive` skips all prompts; the default push mode is
  // --force-with-lease, which refuses if anyone else pushed in the meantime.
  let pushOut = "";
  let pushErr = "";
  let pushExit = 0;
  try {
    const r = await execP(`gt submit --stack -u --no-edit --no-interactive`, {
      cwd: wt,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 180_000,
    });
    pushOut = r.stdout;
    pushErr = r.stderr;
  } catch (e) {
    pushExit = e.code || 1;
    pushOut = e.stdout || "";
    pushErr = e.stderr || e.message || "";
  }

  // Invalidate cache regardless — local branch SHAs changed even if the push failed.
  cache.ts = 0;

  if (pushExit !== 0) {
    // Restack already happened; don't undo it. Surface a partial-success error
    // so the user knows the push needs a manual retry.
    return {
      ok: false,
      error: [
        "Restacked locally, but `gt submit` failed to push.",
        "Local branches are correctly rebased; retry the push manually with `gt submit -u` from the worktree.",
        "--- restack stdout ---",
        stdout.slice(-1500),
        "--- submit stdout ---",
        pushOut.slice(-1500),
        "--- submit stderr ---",
        pushErr.slice(-1500),
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  return {
    ok: true,
    message: [
      "Restacked and pushed successfully.",
      "--- restack ---",
      stdout.trim(),
      "--- submit ---",
      pushOut.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

async function isRebaseInProgress(wt) {
  try {
    const gitDir = (
      await execP(`git -C '${wt}' rev-parse --git-dir`)
    ).stdout.trim();
    const abs = gitDir.startsWith("/") ? gitDir : path.join(wt, gitDir);
    return (
      fs.existsSync(path.join(abs, "rebase-merge")) ||
      fs.existsSync(path.join(abs, "rebase-apply"))
    );
  } catch {
    return false;
  }
}

async function getData(forceRefresh = false, opts = {}) {
  if (opts.intelligent) clearClaudeBackedCaches();

  const now = Date.now();
  if (
    !forceRefresh &&
    !opts.intelligent &&
    cache.data &&
    now - cache.ts < CACHE_TTL_MS
  ) {
    return cache.data;
  }
  if (cache.building) return cache.building;
  cache.building = (async () => {
    try {
      const data = await buildModel();
      cache = { ts: Date.now(), data, building: null };
      return data;
    } catch (err) {
      cache.building = null;
      throw err;
    }
  })();
  return cache.building;
}

// ---------- recommendations (Claude-backed) ----------
let recsCache = loadRecsFromDisk();
let recsBuilding = null;

function loadRecsFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(RECS_CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveRecsToDisk(recs) {
  try {
    fs.writeFileSync(RECS_CACHE_FILE, JSON.stringify(recs, null, 2));
  } catch (err) {
    console.warn("[recs] save failed:", err.message);
  }
}

function buildRecsPayload(model) {
  // Trim to the smallest payload that still gives Claude enough to make sharp recommendations.
  return {
    stacks: model.stacks.map((s) => ({
      name: s.name,
      category: s.category,
      jira: s.jira_keys,
      counts: s.counts,
      needs_restack: s.needs_restack,
      top_pr: s.top_pr?.num || null,
      bottom_pr: s.prs[s.prs.length - 1]?.num || null,
      worktree: s.worktree?.name || null,
      upstream: s.upstream
        ? {
            n: s.upstream.n,
            author: s.upstream.author,
            approved: s.upstream.approved,
            changes_requested: s.upstream.changes_requested,
            review_required: s.upstream.review_required,
          }
        : null,
      prs: s.prs.map((p) => ({
        n: p.num,
        d: p.decision,
        h: p.human_comments,
        b: p.bot_comments,
      })),
    })),
    untouched_jira: (model.untouched_jira || []).slice(0, 8).map((j) => ({
      key: j.key,
      type: j.type,
      summary: j.summary,
      days_old: Math.floor(
        (Date.now() - new Date(j.updated).getTime()) / 86400000
      ),
    })),
    stale_worktrees: model.stale_worktrees.map((w) => ({
      name: w.name,
      reason: w.reason,
    })),
  };
}

async function generateRecommendations(model) {
  const payload = buildRecsPayload(model);
  const prompt =
    `You are reviewing my live PR/stack dashboard and producing actionable recommendations.\n\n` +
    `Output 3-6 single-sentence recommendations as raw HTML <li> elements (no <ol> wrapper, no markdown, no preamble — just <li>...</li> joined by newlines). Rules:\n` +
    `- Start with <strong>action phrase</strong>.\n` +
    `- Reference PR numbers as <a href="https://app.graphite.com/github/pr/revefi/rcode/NUM" target="_blank" rel="noopener">#NUM</a>.\n` +
    `- Reference Jira tickets as <a href="https://revefi.atlassian.net/browse/KEY" target="_blank" rel="noopener">KEY</a>.\n` +
    `- Wrap commands like \`gt restack\` in <code>...</code>.\n` +
    `- Order most actionable first: human review comments, ready-to-merge, blocked upstream, restacks needed, fresh review requests, stale worktrees, new work pick.\n` +
    `- Skip categories that don't apply.\n\n` +
    `Field key: counts.{created,merged,approved,pending,changes_requested}; per-PR d=reviewDecision (APPROVED|REVIEW_REQUIRED|CHANGES_REQUESTED|empty), h=human review comments (open), b=bot review comments (open).\n\n` +
    `Data: ${JSON.stringify(payload)}`;

  return callClaude(prompt, { timeoutMs: 90_000 });
}

async function getRecommendations(forceRefresh = false) {
  if (!forceRefresh && recsCache) return recsCache;
  if (recsBuilding) return recsBuilding;
  recsBuilding = (async () => {
    try {
      const model = await getData(false);
      const html = await generateRecommendations(model);
      const recs = {
        ts: new Date().toISOString(),
        html,
      };
      recsCache = recs;
      saveRecsToDisk(recs);
      return recs;
    } finally {
      recsBuilding = null;
    }
  })();
  return recsBuilding;
}

// ---------- HTTP server ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

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

const server = http.createServer(async (req, res) => {
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

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        cached: !!cache.data,
        age_ms: Date.now() - cache.ts,
        recs_cached: !!recsCache,
        recs_ts: recsCache?.ts || null,
        jira_configured: jiraConfigured(),
      })
    );
    return;
  }
  serveStatic(req, res);
});

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
