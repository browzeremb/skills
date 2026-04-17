import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
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
 */
export function isHookEnabled() {
  const env = (process.env.BROWZER_HOOK ?? '').toLowerCase();
  if (env === 'off' || env === '0' || env === 'false') return false;
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

/**
 * Returns `{ workspaceId, root }` for a starting directory, or null when no
 * .browzer/config.json is found anywhere up the tree.
 *
 * Callers (e.g. `browzer-rewrite-read.mjs`) forward `workspaceId` to the
 * daemon so the per-workspace manifest cache can drive
 * `filterLevel: "aggressive"`.
 */
export function workspaceInfoFor(cwd = process.cwd()) {
  const root = workspaceRootFor(cwd);
  if (!root) return null;
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(root, '.browzer', 'config.json'), 'utf8'),
    );
    if (!cfg.workspaceId) return null;
    return { workspaceId: cfg.workspaceId, root };
  } catch {
    return null;
  }
}

/** Default timeout (ms) for a single daemon JSON-RPC round-trip. */
export const DAEMON_CALL_TIMEOUT_MS = 1500;

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

/** sha256 hex of an absolute path. */
export function pathHash(absPath) {
  return crypto.createHash('sha256').update(absPath).digest('hex');
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
