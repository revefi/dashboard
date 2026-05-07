// Shell-out helpers. Every shell command in the dashboard goes through one
// of these so the cwd, buffer size, and stdin handling are consistent.

const { exec, execFile, spawn } = require("child_process");
const { promisify } = require("util");
const { REPO } = require("./config");

const execP = promisify(exec);
const execFileP = promisify(execFile);

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

module.exports = { sh, shRetry, shWithInput, execP, execFileP, spawn };
