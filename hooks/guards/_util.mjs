import { execSync, spawn } from 'node:child_process';
import fs, { readSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Cache the resolved absolute path of the browzer binary (per-process).
let cachedBrowzerPath = null;

/**
 * Resolves the absolute path of the `browzer` binary via `command -v`.
 * Returns the path string, or "" if not found or the resolved path is
 * relative (which would indicate a PATH-relative or directory-relative
 * entry that could be hijacked).
 */
export function resolveBrowzerBinary() {
  if (cachedBrowzerPath !== null) return cachedBrowzerPath;
  try {
    const out = execSync('command -v browzer', {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: '/bin/sh',
    })
      .toString()
      .trim();
    // Only accept an absolute path — reject relative paths like ./browzer
    // that could be hijacked by a file in the CWD or node_modules/.bin/.
    if (out.startsWith('/') && fs.existsSync(out)) {
      cachedBrowzerPath = out;
      return out;
    }
  } catch {
    // command -v failed or browzer not in PATH
  }
  cachedBrowzerPath = '';
  return '';
}

export function readHookInput() {
  // Safety: abort if we can't read stdin within 500ms. This prevents the
  // hook from hanging indefinitely when the harness closes without piping.
  const abortTimer = setTimeout(() => {
    process.stderr.write('[browzer] readHookInput timed out after 500ms\n');
    process.exit(0);
  }, 500);
  try {
    const chunks = [];
    const buf = Buffer.alloc(1 << 16);
    while (true) {
      let n;
      try {
        n = readSync(0, buf, 0, buf.length, null);
      } catch {
        break;
      }
      if (!n) break;
      chunks.push(buf.slice(0, n).toString('utf8'));
      if (n < buf.length) break;
    }
    clearTimeout(abortTimer);
    try {
      return JSON.parse(chunks.join('') || '{}');
    } catch {
      return {};
    }
  } catch (_e) {
    clearTimeout(abortTimer);
    return {};
  }
}

const SOCKET_PATH =
  process.env.BROWZER_DAEMON_SOCKET ??
  `/tmp/browzer-daemon.${process.getuid?.() ?? 0}.sock`;
const CONFIG_PATH = path.join(os.homedir(), '.browzer', 'config.json');
const CREDS_PATH = path.join(os.homedir(), '.browzer', 'credentials');

/**
 * Returns true when hooks are enabled. Honors BROWZER_HOOK=off and the
 * config.json `hook: "off"` setting. Default ON.
 *
 * When `hookId` is supplied (kebab-case identifier — typically the guard
 * filename minus the `browzer-` prefix), the comma-separated env var
 * `BROWZER_HOOK_DISABLE` is also consulted: if `hookId` appears in the
 * list, the hook is disabled for this invocation only. Empty entries
 * and surrounding whitespace are tolerated. The binary `BROWZER_HOOK=off`
 * still wins (silences every hook regardless of the granular list).
 */
export function isHookEnabled(hookId) {
  const env = (process.env.BROWZER_HOOK ?? '').toLowerCase();
  if (env === 'off' || env === '0' || env === 'false') return false;
  if (hookId) {
    const disable = process.env.BROWZER_HOOK_DISABLE ?? '';
    if (disable) {
      const wanted = String(hookId).trim().toLowerCase();
      const disabled = disable
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (disabled.includes(wanted)) return false;
    }
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (cfg.hook === 'off' || cfg.hook === false) return false;
  } catch {
    // Missing config = default on.
  }
  return true;
}

/**
 * Returns true when this CWD looks like a browzer-initialized workspace
 * (creds file + .browzer/config.json present). Used to skip hooks in
 * unrelated repos.
 */
export function isInBrowzerWorkspace(cwd = process.cwd()) {
  if (!fs.existsSync(CREDS_PATH)) return false;
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, '.browzer', 'config.json'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

/** Resolve the workspace root for a CWD, or null. */
export function workspaceRootFor(cwd = process.cwd()) {
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, '.browzer', 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Default timeout (ms) for a single daemon JSON-RPC round-trip. */
const DAEMON_CALL_TIMEOUT_MS = 1500;

/**
 * Matches file/path targets that belong to config, docs, or out-of-index
 * surfaces. Used by guards to skip non-code paths and avoid false positives.
 *
 * Covers: .claude, .github, .vscode, .husky, .changeset, node_modules, dist,
 * build, coverage, .turbo, .next — plus common non-code extensions.
 */
export const CONFIG_SURFACE_RE =
  /(^|[\s/*])(\.claude|\.github|\.vscode|\.husky|\.changeset|node_modules|dist|build|coverage|\.turbo|\.next)([/\s]|$)|\.(json|ya?ml|toml|md|mdx|lock|env|gitignore|editorconfig|prettierrc|eslintrc)(?![a-z0-9])/i;

/**
 * Calls a daemon JSON-RPC method with a 1.5s timeout. Resolves with the
 * `result` field, rejects on error or timeout.
 */
export function daemonCall(
  method,
  params,
  { timeoutMs = DAEMON_CALL_TIMEOUT_MS } = {},
) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET_PATH);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('daemon_timeout'));
    }, timeoutMs);
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      sock.end();
      try {
        const r = JSON.parse(buf.slice(0, nl));
        if (r.error) return reject(new Error(r.error.message));
        resolve(r.result);
      } catch (e) {
        reject(e);
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`,
    );
  });
}

let daemonSpawnAttempted = false;

/**
 * Fire-and-forget respawn of the daemon. Idempotent per hook process.
 *
 * The daemon self-exits after `daemon.idle_timeout_seconds` (default 600s).
 * Only the SessionStart hook respawns it — which fires once per Claude
 * Code session. So a long-running session sees the daemon die mid-flight
 * and never recover without manual `browzer daemon start`.
 *
 * Guards that talk to the daemon call this from their `catch` branch so
 * the next hook firing finds a live socket. Spawn is detached + unref'd,
 * adding zero hot-path latency; the current call still misses the rewrite
 * (intentional — matches the existing graceful-degradation model).
 */
export function ensureDaemon() {
  if (daemonSpawnAttempted) return;
  daemonSpawnAttempted = true;
  const browzerBin = resolveBrowzerBinary();
  if (!browzerBin) return;
  try {
    const child = spawn(browzerBin, ['daemon', 'start', '--background'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    /* swallow — never block the guard on spawn failure */
  }
}

/** Returns extension classification: 'code' | 'config' | 'doc' | 'binary' | 'other'. */
const NON_CODE_EXT = new Set([
  '.md',
  '.mdx',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.lock',
  '.env',
]);
const CONFIG_PATH_RE =
  /(^|\/)(\.claude|\.github|\.vscode|\.husky|\.changeset|node_modules|dist|build|coverage|\.turbo|\.next)(\/|$)/i;

export function classifyPath(p) {
  if (CONFIG_PATH_RE.test(p)) return 'config';
  const ext = path.extname(p).toLowerCase();
  if (NON_CODE_EXT.has(ext)) return 'doc';
  return 'code';
}

/** Estimate token count from byte length (~4 chars/token). */
export function tokensOf(bytes) {
  return Math.ceil(bytes / 4);
}

/**
 * Append a single JSON-line event to `~/.browzer/pending-events.jsonl` for
 * later replay when the daemon `Track` round-trip fails.
 *
 * POSIX `O_APPEND` makes writes ≤ PIPE_BUF (≥4096 on every supported OS)
 * atomic across concurrent appenders, and event payloads are ~200-400 bytes,
 * so a plain `appendFileSync` is safe without an explicit lock.
 *
 * Caps the file at 10MB by rotating to `<file>.1` (single-generation, oldest
 * dropped). Never throws — failures degrade silently to stderr.
 */
const PENDING_EVENTS_PATH = path.join(
  os.homedir(),
  '.browzer',
  'pending-events.jsonl',
);
const PENDING_EVENTS_LOCK_PATH = `${PENDING_EVENTS_PATH}.lock`;
const PENDING_EVENTS_CAP_BYTES = 10 * 1024 * 1024;
const STALE_LOCK_AGE_MS = 30 * 1000;

/**
 * Atomic create-or-fail lockfile (`O_CREAT | O_EXCL`). Used to serialize
 * the stat+rename rotation window across processes. Stale locks (older
 * than 30s and owned by a dead PID) are force-unlinked before retry.
 *
 * The append itself remains lock-free — POSIX `O_APPEND` makes writes
 * ≤ PIPE_BUF (≥4096 bytes on every supported OS) atomic across
 * concurrent appenders, and event payloads are ~200-400 bytes.
 */
function acquireLock(lockPath) {
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e?.code !== 'EEXIST') return false;
    // Probe for a stale lock: mtime older than 30s AND owning PID dead.
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > STALE_LOCK_AGE_MS) {
        let stale = true;
        try {
          const pidStr = fs.readFileSync(lockPath, 'utf8').trim();
          const pid = Number.parseInt(pidStr, 10);
          if (Number.isFinite(pid) && pid > 0) {
            try {
              process.kill(pid, 0); // signal 0 = liveness probe
              stale = false; // PID alive → not stale
            } catch (err) {
              if (err?.code === 'EPERM') stale = false; // alive, owned by another user
              // ESRCH or other → dead → stale
            }
          }
        } catch {
          /* unreadable lock contents → treat as stale */
        }
        if (stale) {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            /* swallow */
          }
          try {
            fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
            return true;
          } catch {
            return false;
          }
        }
      }
    } catch {
      /* stat failed → another process won the race */
    }
    return false;
  }
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* swallow */
  }
}

export function appendPendingEvent(event) {
  try {
    const dir = path.dirname(PENDING_EVENTS_PATH);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* parent likely exists */
    }
    // Rotation window — guarded by sidecar lockfile so concurrent processes
    // don't race stat→rename. If we can't take the lock, skip rotation this
    // call (another process is rotating). Append below is unaffected.
    let locked = false;
    try {
      locked = acquireLock(PENDING_EVENTS_LOCK_PATH);
      if (locked) {
        try {
          const st = fs.statSync(PENDING_EVENTS_PATH);
          if (st.size > PENDING_EVENTS_CAP_BYTES) {
            try {
              fs.renameSync(PENDING_EVENTS_PATH, `${PENDING_EVENTS_PATH}.1`);
            } catch {
              /* swallow — rotation is best-effort */
            }
          }
        } catch (e) {
          if (e?.code !== 'ENOENT') {
            // unexpected stat error — fall through to append attempt
          }
        }
      }
    } finally {
      if (locked) releaseLock(PENDING_EVENTS_LOCK_PATH);
    }
    fs.appendFileSync(PENDING_EVENTS_PATH, `${JSON.stringify(event)}\n`);
  } catch (e) {
    try {
      process.stderr.write(
        `[browzer] appendPendingEvent failed: ${e?.message ?? e}\n`,
      );
    } catch {
      /* nothing left to do */
    }
  }
}

/**
 * Wraps a `Track` JSON-RPC call with the standard fallback: on failure,
 * persist the payload to the pending-events JSONL queue and kick a
 * detached daemon respawn so the next hook firing finds a live socket.
 *
 * Hooks should call this instead of inlining the try/catch around
 * `daemonCall('Track', payload)`.
 */
export async function trackEvent(payload) {
  try {
    await daemonCall('Track', payload);
  } catch {
    appendPendingEvent({ ...payload, method: 'Track' });
    ensureDaemon();
  }
}

/**
 * Path patterns whose owners should never be force-rewritten via the
 * Read/Bash daemon path-swap. Configs and infra files are tiny, demand
 * exact-text edits, and historically triggered the Edit-loop bug
 * (2026-04-16 retro §3.1) when their Read returned a tempPath that the
 * Edit harness could not reconcile against the original file_path.
 */
export const NEVER_REWRITE_RE =
  /(^|\/)(Dockerfile|drizzle\.config\.ts|tsup\.config\.ts)$|\.(sql|toml|env(\.[a-z]+)?|ya?ml)$|(^|\/)package\.json$|(^|\/)CLAUDE\.md$|(^|\/)AGENTS\.md$|(^|\/)\.env(\.|$)/i;

/**
 * Lightweight shell tokenizer: returns the input string with single-quoted,
 * double-quoted, $(...) command substitutions and <<DELIM heredoc bodies
 * removed, leaving only the "shell skeleton" — the parts the parent shell
 * interprets as command tokens. Used by guards that must not match
 * substrings appearing inside quoted argument bodies (2026-04-16 retro §3.6:
 * `git commit -m "$(cat <<'EOF' ... browzer explore ... EOF)"` was being
 * blocked by browzer-contract.mjs because of naive substring matching).
 *
 * Not a full POSIX parser — handles the cases that bite the hook surface:
 * single-quoted strings, double-quoted strings (with backslash escapes),
 * $(...) substitution, and <<DELIM / <<-DELIM / <<'DELIM' / <<"DELIM"
 * heredocs. ANSI-C $'...' is treated as single-quoted (close enough).
 */
export function stripQuoted(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    // Single-quoted: literal until next ' (no escapes)
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) return out; // unterminated → drop the rest
      i = end + 1;
      continue;
    }
    // ANSI-C $'...' — same termination as single-quoted
    if (c === '$' && input[i + 1] === "'") {
      const end = input.indexOf("'", i + 2);
      if (end === -1) return out;
      i = end + 1;
      continue;
    }
    // Double-quoted: skip until next unescaped "
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (input[j] === '\\' && j + 1 < n) {
          j += 2;
          continue;
        }
        if (input[j] === '"') break;
        j++;
      }
      i = j + 1;
      continue;
    }
    // $(...) command substitution: skip nested parens (depth-aware)
    if (c === '$' && input[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (input[j] === '(') depth++;
        else if (input[j] === ')') depth--;
        j++;
      }
      i = j;
      continue;
    }
    // Heredoc: <<DELIM, <<-DELIM, <<'DELIM', <<"DELIM"
    if (c === '<' && input[i + 1] === '<') {
      const rest = input.slice(i);
      const m = rest.match(
        /^<<-?\s*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_][\w]*))/,
      );
      if (m) {
        const delim = m[1] || m[2] || m[3];
        const headerEnd = i + m[0].length;
        // Find delim on its own line (allow leading tabs for <<-)
        const re = new RegExp(
          `\\n[\\t ]*${delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\n|$)`,
        );
        const bodyMatch = re.exec(input.slice(headerEnd));
        if (bodyMatch) {
          i = headerEnd + bodyMatch.index + bodyMatch[0].length;
          continue;
        }
        // Unterminated heredoc → drop the rest
        return out + input.slice(i, headerEnd);
      }
    }
    out += c;
    i++;
  }
  return out;
}
