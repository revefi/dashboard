// Env-derived constants and paths. Single source of truth — every other
// module pulls config from here instead of recomputing.

const path = require("path");

// Claude session dir name = the absolute project path with every non-alnum,
// non-hyphen character replaced by "-". Matches what `claude` CLI produces
// under ~/.claude/projects/.
function encodeProjectDir(absPath) {
  return absPath.replace(/[^A-Za-z0-9-]/g, "-");
}

const REPO = process.env.WORKSPACE_PATH;
if (!REPO) {
  console.error(
    "ERROR: WORKSPACE_PATH env var not set. Add `export WORKSPACE_PATH=/path/to/rcode` to ~/.zshrc and reload."
  );
  process.exit(1);
}

const HOME = process.env.HOME || "/";
const SESSIONS_ROOT = path.join(HOME, ".claude", "projects");
const MAIN_SESSIONS_DIR = path.join(SESSIONS_ROOT, encodeProjectDir(REPO));
const PORT = parseInt(process.env.PORT || "7787", 10);
const CACHE_TTL_MS = 30_000;

// __dirname here is src/server/, so go up two levels for STATIC_DIR/CACHE_DIR.
const ROOT = path.join(__dirname, "..", "..");
const STATIC_DIR = path.join(ROOT, "public");
const CACHE_DIR = path.join(ROOT, "cache");
const RECS_CACHE_FILE = path.join(CACHE_DIR, "recommendations.json");
const STACK_NAMES_CACHE_FILE = path.join(CACHE_DIR, "stack-names.json");
const STACK_NAMES_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const JIRA_BASE = "https://revefi.atlassian.net";
const GH_REPO_FLAG = "--repo revefi/rcode";

module.exports = {
  encodeProjectDir,
  REPO,
  HOME,
  SESSIONS_ROOT,
  MAIN_SESSIONS_DIR,
  PORT,
  CACHE_TTL_MS,
  STATIC_DIR,
  CACHE_DIR,
  RECS_CACHE_FILE,
  STACK_NAMES_CACHE_FILE,
  STACK_NAMES_TTL_MS,
  JIRA_BASE,
  GH_REPO_FLAG,
};
