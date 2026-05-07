// "Action items" — Claude-backed recommendations rendered as <li> bullets.
// Cached on disk because regeneration costs Claude tokens; the user clicks
// the ⟳ button when they want a refresh.

const fs = require("fs");
const { RECS_CACHE_FILE } = require("./config");
const { callClaude } = require("./claude");
const { getData } = require("./cache");

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
  // Trim to the smallest payload that still gives Claude enough to make sharp
  // recommendations.
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

function getRecsCacheState() {
  return { cached: !!recsCache, ts: recsCache?.ts || null };
}

module.exports = {
  getRecommendations,
  getRecsCacheState,
};
