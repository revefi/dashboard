// GitHub interactions via the `gh` CLI: REST list/view + a bulk GraphQL
// query for review threads + CI rollup. All read-only.

const { shRetry, shWithInput } = require("./shell");
const { GH_REPO_FLAG } = require("./config");

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
  const login = await getLogin();
  const stdout = await shRetry(
    `gh api "repos/revefi/rcode/pulls?state=closed&per_page=50" ` +
      `--jq '[.[] | select(.user.login == "${login}") | select(.merged_at != null) | ` +
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
  const latest = new Map();
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

module.exports = {
  getLogin,
  fetchOpenPRs,
  fetchRecentMergedPRs,
  fetchAnyPR,
  fetchPRMeta,
  fetchPrSignalsBulk,
  summarizeChecks,
};
