// Claude CLI helper + everything we drive through it: session scoring (for
// "claude --resume <sid>" suggestions per stack) and stack-name generation.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { execP } = require("./shell");
const { loadDiskCache, saveDiskCache } = require("./disk-cache");
const {
  encodeProjectDir,
  REPO,
  SESSIONS_ROOT,
  MAIN_SESSIONS_DIR,
  STACK_NAMES_CACHE_FILE,
  STACK_NAMES_TTL_MS,
} = require("./config");

function callClaude(prompt, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "text"];
    // Default to Sonnet 4.6 — better stack-name + recommendation quality than
    // Haiku at modest extra latency. Pass `opts.model` to override per call,
    // or `opts.model: false` to let the CLI pick.
    if (opts.model !== false)
      args.push("--model", opts.model || "claude-sonnet-4-6");
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
  const candidate = text.slice(firstBrace);
  for (let end = candidate.length; end > 0; end--) {
    try {
      return JSON.parse(candidate.slice(0, end));
    } catch {}
  }
  return null;
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
      path.join(
        SESSIONS_ROOT,
        encodeProjectDir(`${REPO}/.claude/worktrees/${worktreeName}`)
      )
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

// ---------- stack-name generation (Claude, cached by PR-set hash) ----------
function stackPrHash(stack) {
  return [...stack.prs.map((p) => p.num)].sort((a, b) => a - b).join(",");
}

function stackNameCacheKey(stack) {
  return `${stack.stack_key}:${stackPrHash(stack)}`;
}

async function enhanceStackNamesWithClaude(stacks) {
  const cached = loadDiskCache(STACK_NAMES_CACHE_FILE) || {};

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

module.exports = {
  callClaude,
  parseJsonLoose,
  listSessions,
  scoreSessionsForStack,
  enhanceStackNamesWithClaude,
};
