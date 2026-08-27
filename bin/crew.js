#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';
import { emitKeypressEvents } from 'node:readline';
import { renderAsciiGraph } from './graph.js';

// ==================== pkg ====================
// Read package.json relative to this file. Works both unbundled (src/pkg.js -> ../package.json)
// and bundled (bin/crew.js -> ../package.json) since both sit one dir below the repo root.
export const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// ==================== colors ====================
// ---------------------------------------------------------------------------
// Colors — ANSI only (no dependency). Disabled when not a TTY, NO_COLOR is set,
// or TERM=dumb, so piped/redirected output stays clean.
// ---------------------------------------------------------------------------
export const COLOR = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const wrap = (n) => (s) => (COLOR ? `\x1b[${n}m${s}\x1b[0m` : `${s}`);
export const c = {
  bold: wrap(1),
  dim: wrap(2),
  underline: wrap(4),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  cyan: wrap(36),
};
// Truecolor when the terminal advertises it, otherwise fall back to the xterm-256 cube.
const TRUECOLOR = COLOR && /^(truecolor|24bit)$/i.test(process.env.COLORTERM || '');
function rgbTo256(r, g, b) {
  const to6 = (v) => (v < 48 ? 0 : v > 247 ? 5 : Math.round((v - 35) / 40));
  return 16 + 36 * to6(r) + 6 * to6(g) + to6(b);
}
export function fgRGB(r, g, b) {
  if (!COLOR) return (s) => `${s}`;
  const code = TRUECOLOR ? `38;2;${r};${g};${b}` : `38;5;${rgbTo256(r, g, b)}`;
  return (s) => `\x1b[${code}m${s}\x1b[0m`;
}
// A subdued gray for low-priority annotations (guard descriptions, etc.) — darker than c.dim.
export const faint = fgRGB(110, 110, 110);
// Chrome (labels, separators, hints): the dim ATTRIBUTE, not a color — the terminal fades it
// toward its own background, so it stays legible on both light and dark themes (unlike bright-
// black \x1b[90m, which a light theme maps to a light gray that's nearly invisible on white).
// Closes with 22m, never 39m (39m restores the foreground color, it doesn't turn dim off).
const DIM = '\x1b[2m', UNDIM = '\x1b[22m';
function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
// An ordered palette where each color sits ~137.5 deg (golden angle) from the previous
// one, so consecutive indices are maximally distant in hue. Mid S/L keep it readable on
// both light and dark backgrounds. Index N is stable and reproducible — not random.
function rgbForIndex(i) {
  const hue = (i * 137.508) % 360;
  return hslToRgb(hue, 0.75, 0.45);
}
export function colorForIndex(i) {
  const [r, g, b] = rgbForIndex(i);
  return fgRGB(r, g, b);
}
// Assign every known service a stable rank (sorted name order) -> golden-angle color.
// Same service set always yields the same color per name, and neighbours differ sharply.
// Built once per command so list/groups/run all agree.
export function serviceColors(cfg) {
  const names = Object.keys(cfg.services || {}).sort();
  const map = new Map();
  names.forEach((n, i) => map.set(n, colorForIndex(i)));
  return map;
}

// ==================== util ====================
export function tildify(p) {
  const h = homedir();
  return p === h || p.startsWith(h + '/') ? '~' + p.slice(h.length) : p;
}

// ---------------------------------------------------------------------------
// Errors — expected failures print a clean one-line message, never a stack.
// ---------------------------------------------------------------------------
export class CrewError extends Error {}
export function fail(msg) {
  throw new CrewError(msg);
}
export function warn(msg) {
  console.error(c.yellow(`crew: ${msg}`));
}

// ---------------------------------------------------------------------------
// Path helpers — ~ expansion + relative-to-cwd resolution everywhere.
// ---------------------------------------------------------------------------
export function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}
export function resolvePath(p) {
  const e = expandHome(String(p));
  return isAbsolute(e) ? e : resolve(process.cwd(), e);
}
export function pathExists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shell quoting — wrap substituted values so spaces/metacharacters are safe.
// ---------------------------------------------------------------------------
export function shellQuote(v) {
  const s = String(v);
  if (s === '') return "''";
  if (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

// ---------------------------------------------------------------------------
// Placeholders — {name} tokens inside a resolved command string.
// ---------------------------------------------------------------------------
export const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;
export function placeholdersIn(str) {
  const set = new Set();
  let m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(str))) set.add(m[1]);
  return [...set];
}
export function substitute(str, values) {
  // Unknown placeholders are left intact (e.g. crew fills {envfile} per-service later).
  return str.replace(PLACEHOLDER_RE, (m, k) => (k in values ? shellQuote(values[k]) : m));
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
export function sanitize(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, '_');
}

export function launch(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { stdio: 'inherit', ...opts });
  if (r.error) {
    if (r.error.code === 'ENOENT')
      fail(`'${bin}' not found on PATH. Install it and try again.`);
    fail(`failed to launch '${bin}': ${r.error.message}`);
  }
  process.exit(r.status ?? 0);
}

// GET a URL as text, following redirects (GitHub raw -> CDN). Zero-dep (node:http/https).
export function fetchUrl(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https:') ? httpsGet : httpGet;
    get(url, { headers: { 'User-Agent': 'crew' } }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        return resolve(fetchUrl(new URL(headers.location, url).toString(), redirects - 1));
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// exitCode is a number (normal exit) or a signal-name string (killed). Aggregate:
// first non-zero numeric wins; else 130 if anything was signalled; else 0/1.
export function exitCodeFromEvents(events) {
  if (!Array.isArray(events)) return 1;
  let killedBySignal = false;
  for (const e of events) {
    const code = e && e.exitCode;
    if (typeof code === 'number' && code !== 0) return code;
    if (typeof code === 'string') killedBySignal = true; // signal name, e.g. 'SIGTERM'
  }
  return killedBySignal ? 130 : 1;
}

// ==================== config ====================
// Machine-local services directory; relative service paths resolve against it. Set once
// per machine via `crew dir` (stored in the user-level config, never in a committed
// ./.crew.json), so shared configs can use short relative paths like "bee-beepro-backend".
let SERVICES_DIR = null;
// Resolve a SERVICE path: `~`/absolute is used as-is (escape hatch for repos outside the
// services dir); anything relative resolves against SERVICES_DIR.
export function resolveServicePath(p) {
  const e = expandHome(String(p));
  if (isAbsolute(e)) return e;
  if (!SERVICES_DIR)
    fail(
      `service path '${p}' is relative but no services directory is set.\n` +
        `  Set it in Settings: crew config`
    );
  return resolve(SERVICES_DIR, e);
}

// Which services' folders don't exist under `dir` (a candidate services directory) — the consistency
// check behind `crew dir`, `crew check` and the editor's Settings warning. Absolute/`~` paths resolve
// as-is; relative paths join `dir` (a null dir means every relative path counts as missing). Warn-only:
// a wrong `servicesDir` should never silently invalidate — or auto-delete — services.
export function missingServiceFolders(cfg, dir) {
  const abs = dir ? resolvePath(dir) : null;
  const out = [];
  for (const [name, p] of Object.entries((cfg && cfg.services) || {})) {
    if (!p || !p.path) continue;
    const e = expandHome(String(p.path));
    const full = isAbsolute(e) ? e : abs ? resolve(abs, e) : null;
    if (!full || !pathExists(full)) out.push(name);
  }
  return out;
}

// Shared NON-blocking gate for the folder-consuming commands (start/workspace/claude/graph/
// resolve). A service whose `path` folder is absent is treated as if it didn't exist: excluded from the
// graph AND the selector (so you can't pick or draw a phantom), while the SHARED config is never touched.
// `warnMissing` surfaces the misses with direction-aware advice; the caller shows `emptyServicesState`
// when nothing is left. (`crew check` keeps its own full report; `crew list` just adds the banner.)
function presentCfg(cfg) {
  const miss = new Set(missingServiceFolders(cfg, SERVICES_DIR));
  const services = {};
  for (const [n, p] of Object.entries((cfg && cfg.services) || {})) if (!miss.has(n)) services[n] = p;
  return { ...cfg, services };
}
function warnMissing(cfg) {
  const missing = missingServiceFolders(cfg, SERVICES_DIR);
  if (!missing.length) return missing;
  const total = Object.keys((cfg && cfg.services) || {}).length;
  // No services dir, or a MAJORITY missing -> the services dir is the likely culprit. A minority -> the
  // individual paths are. Advise accordingly; informational only — the command runs on whatever remains.
  if (!SERVICES_DIR || missing.length > Math.floor(total / 2)) {
    warn(`${missing.length}/${total} service folder(s) not found${SERVICES_DIR ? ` under ${tildify(SERVICES_DIR)}` : ''} — check your services dir:  crew config › Settings › config › servicesDir`);
  } else {
    const where = (p) => { const e = expandHome(String(p.path || '')); const full = isAbsolute(e) ? e : (SERVICES_DIR ? resolve(SERVICES_DIR, e) : e); return tildify(full); };
    warn(`service folder(s) missing — fix each path (or remove it):  ${missing.map((n) => `${n} → ${where(cfg.services[n])}`).join('  ')}`);
  }
  return missing;
}
function emptyServicesState(headline) {
  console.log('\n  ' + c.bold(headline));
  console.log(c.dim('  Make sure your config has services and their paths are correct') + (SERVICES_DIR ? c.dim(` (checked under ${tildify(SERVICES_DIR)})`) : '') + c.dim('.'));
  console.log(c.dim('  Set your services dir:  crew config › Settings › config › servicesDir') + '\n');
}

// ---------------------------------------------------------------------------
// Config — user-level at ~/.config/crew/config.json, service-local ./.crew.json
// merges on top. v1 configs migrate to v2 in memory and are written back.
// ---------------------------------------------------------------------------
// `start` is crew's one core task — the streamed command (kill-others + interactive viewer). `debug` runs
// under it (the per-node toggle), so it streams too. Everything else in a service's `tasks` map is optional
// data with no core command yet (a future generic runner will funnel it). This set drives display only.
export const STREAMED_TASKS = new Set(['start', 'debug']);

export function defaultConfig() {
  return {
    version: 2,
    workspaceName: 'crew',
    services: {},
  };
}

export function userConfigPath(flags) {
  if (flags.config) return resolvePath(flags.config);
  return join(homedir(), '.config', 'crew', 'config.json');
}
export function crewHomeFor(configPath) {
  // The dir that holds the config also holds generated workspaces.
  return dirname(configPath);
}
// Machine-local settings (currently just servicesDir) live beside the config as
// `local.json` — never committed. This keeps config.json fully shareable; teammates set
// their own servicesDir with `crew dir`. Add `local.json` to .gitignore when committing.
export function machineConfigPath(flags) {
  return join(crewHomeFor(userConfigPath(flags)), 'local.json');
}
export function loadMachine(flags) {
  const p = machineConfigPath(flags);
  if (!pathExists(p)) return {};
  try {
    const m = JSON.parse(readFileSync(p, 'utf8'));
    if (m && m.projectsDir && !m.servicesDir) { m.servicesDir = m.projectsDir; delete m.projectsDir; } // key renamed
    return m;
  } catch {
    return {};
  }
}
export function writeMachine(flags, obj) {
  const p = machineConfigPath(flags);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

// Migrate a config object in place to v2. Returns true if anything changed.
export function migrate(cfg) {
  let changed = false;
  if (cfg.projects && !cfg.services) { // key renamed: `projects` -> `services`
    cfg.services = cfg.projects;
    delete cfg.projects;
    changed = true;
  }
  if (typeof cfg.version !== 'number' || cfg.version < 2) {
    // v1 -> v2: a service's single `start` block becomes tasks.start.
    for (const p of Object.values(cfg.services || {})) {
      if (p && p.start && typeof p.start === 'object') {
        p.tasks = p.tasks || {};
        if (p.start.command && p.tasks.start == null) p.tasks.start = p.start.command;
        delete p.start; // cwd/defaults/allowed dropped: v2 fills placeholders from args only
      }
    }
    cfg.version = 2;
    changed = true;
  }
  if ('longRunning' in cfg) { // retired: `start` is always streamed, so the switch no longer exists
    delete cfg.longRunning;
    changed = true;
  }
  if (!cfg.services) {
    cfg.services = {};
    changed = true;
  }
  // Groups were removed in favour of the on-the-fly picker + remembered selection; drop any.
  if (cfg.groups) {
    delete cfg.groups;
    changed = true;
  }
  if (!cfg.workspaceName) {
    cfg.workspaceName = 'crew';
    changed = true;
  }
  // Rename the short-lived `checks` feature to `guards` (top-level registry + per-service).
  if (cfg.checks && typeof cfg.checks === 'object') {
    cfg.guards = { ...cfg.checks, ...(cfg.guards || {}) };
    delete cfg.checks;
    changed = true;
  }
  for (const p of Object.values(cfg.services || {})) {
    if (p && Array.isArray(p.checks) && !p.guards) {
      p.guards = p.checks;
      changed = true;
    }
  }
  // Self-heal: drop fields removed in later versions so a config edited by an older crew
  // gets cleaned up (and written back) the first time a newer crew loads it.
  const DEPRECATED_SERVICE_FIELDS = ['relatedDirs', 'cwd', 'start', 'checks'];
  for (const p of Object.values(cfg.services || {})) {
    for (const dead of DEPRECATED_SERVICE_FIELDS) {
      if (p && typeof p === 'object' && dead in p) {
        delete p[dead];
        changed = true;
      }
    }
  }
  return changed;
}

// Load (and migrate-in-place) the user-level config. Writes back if migrated.
export function loadUserConfig(flags) {
  const path = userConfigPath(flags);
  if (!pathExists(path)) return { path, cfg: defaultConfig(), existed: false };
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`config file is not valid JSON: ${path}`);
  }
  let changed = migrate(cfg);
  if (cfg.projectsDir && !cfg.servicesDir) { cfg.servicesDir = cfg.projectsDir; delete cfg.projectsDir; changed = true; } // key renamed
  // servicesDir is machine-local: it belongs in local.json, not the committable config.
  // Migrate any legacy value out of config.json into local.json so config.json stays
  // shareable.
  const machine = loadMachine(flags);
  let servicesDir = machine.servicesDir;
  if (cfg.servicesDir) {
    if (!servicesDir) {
      servicesDir = cfg.servicesDir;
      try {
        writeMachine(flags, { ...machine, servicesDir });
      } catch {
        /* read-only fs */
      }
    }
    delete cfg.servicesDir;
    changed = true;
  }
  // NB: `local.json.overrides` is NOT migrated up — it's now the machine-local, per-user/secret OVERLAY that
  // merges over `config.json.overrides` at run time (mergeOverrides). Auto-hoisting it would leak secrets
  // into the committable config, so we never touch it here.
  if (changed) {
    try {
      writeUserConfig(path, cfg);
    } catch {
      /* read-only fs — proceed with the in-memory migration */
    }
  }
  SERVICES_DIR = servicesDir ? resolvePath(servicesDir) : null;
  return { path, cfg, existed: true };
}

export function writeUserConfig(path, cfg) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
}

// Merge service-local ./.crew.json on top of the user config (read-only overlay).
export function loadMerged(flags) {
  const { cfg: user, path } = loadUserConfig(flags);
  const merged = JSON.parse(JSON.stringify(user));
  const localPath = resolve(process.cwd(), '.crew.json');
  let localUsed = null;
  if (pathExists(localPath)) {
    let local;
    try {
      local = JSON.parse(readFileSync(localPath, 'utf8'));
    } catch {
      fail(`service-local config is not valid JSON: ${localPath}`);
    }
    if (local.workspaceName) merged.workspaceName = local.workspaceName;
    Object.assign(merged.services, local.services || {});
    merged.guards = { ...(merged.guards || {}), ...(local.guards || {}) };
    localUsed = localPath;
  }
  return { cfg: merged, userPath: path, localPath: localUsed };
}

// ---------------------------------------------------------------------------
// Selection helpers — resolve names to members, remember the last picked set.
// ---------------------------------------------------------------------------
export function membersFor(cfg, names, debug = []) {
  const known = Object.keys(cfg.services || {});
  const missing = names.filter((n) => !cfg.services[n]);
  if (missing.length)
    fail(
      `unknown service(s): ${missing.join(', ')}.\n` +
        `  services: ${known.join(', ') || '(none) — run: crew config'}`
    );
  const dbg = new Set(debug);
  // A member launches `tasks.debug` (not `tasks.start`) only when it was debug-toggled AND actually has a
  // debug task. `task` is left UNSET otherwise, so resolveRun falls back to the command's own task (start).
  return names.map((n) => {
    const service = cfg.services[n];
    const useDebug = dbg.has(n) && service.tasks && service.tasks.debug != null;
    return useDebug ? { name: n, service, task: 'debug' } : { name: n, service };
  });
}

// The remembered selection is global (shared by start/workspace/claude/run) and machine-
// local (local.json beside the config) — ephemeral per-machine state, never committed.
export function loadLastSelection(flags) {
  const s = loadMachine(flags).lastSelection;
  return Array.isArray(s) ? s : [];
}
export function saveLastSelection(flags, names) {
  try {
    writeMachine(flags, { ...loadMachine(flags), lastSelection: names });
  } catch {
    /* read-only fs — selection just won't persist */
  }
}
// Remembered per-service DEBUG set (machine-local) — which picked services launch their `tasks.debug`
// instead of `tasks.start`. Toggled with `d` in the graph selector; a subset of the run selection.
export function loadLastDebug(flags) {
  const d = loadMachine(flags).lastDebug;
  return Array.isArray(d) ? d : [];
}
export function saveLastDebug(flags, names) {
  try {
    writeMachine(flags, { ...loadMachine(flags), lastDebug: names });
  } catch {
    /* read-only fs — preference just won't persist */
  }
}
// Per-run DISABLED overrides (machine-local): { service: [key…] } where key is `VAR` / `peer.VAR`. Toggled
// with `e` in the graph selector; honored by overrideVarsFor. Default (absent) = every override enabled.
export function loadOverridesOff(flags) {
  const o = loadMachine(flags).overridesOff;
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
}
export function saveOverridesOff(flags, map) {
  try {
    writeMachine(flags, { ...loadMachine(flags), overridesOff: map });
  } catch {
    /* read-only fs — preference just won't persist */
  }
}

// Log-viewer filter memory: we persist the HIDDEN names (global, machine-local), not the shown
// ones — so a service/guard absent from a later run is simply ignored and anything NEW defaults
// to visible (saving "shown" would silently hide new entries).
export function loadHiddenLog(flags) {
  const h = loadMachine(flags).hiddenLog;
  return Array.isArray(h) ? h : [];
}
export function saveHiddenLog(flags, names) {
  try {
    writeMachine(flags, { ...loadMachine(flags), hiddenLog: names });
  } catch {
    /* read-only fs — preference just won't persist */
  }
}
// Log-viewer wrap/cut preference (global, machine-local). Default: wrap.
export function loadLogWrap(flags) {
  const w = loadMachine(flags).logWrap;
  return typeof w === 'boolean' ? w : true;
}
export function saveLogWrap(flags, wrap) {
  try {
    writeMachine(flags, { ...loadMachine(flags), logWrap: wrap });
  } catch {
    /* read-only fs — preference just won't persist */
  }
}
// Graph-view prefs (machine-local), shared by every graph UI (crew graph pager + the start/workspace/
// claude selector). `graphRefs` = show reference edges (default on). `graphShown` = the crew-graph node
// filter (null = all). Persisted so a toggle/filter sticks across runs.
export function loadGraphRefs(flags) {
  const r = loadMachine(flags).graphRefs;
  return typeof r === 'boolean' ? r : true;
}
export function saveGraphRefs(flags, on) {
  try { writeMachine(flags, { ...loadMachine(flags), graphRefs: on }); } catch { /* read-only fs */ }
}
export function loadGraphShown(flags) {
  const s = loadMachine(flags).graphShown;
  return Array.isArray(s) ? s : null;
}
export function saveGraphShown(flags, names) {
  try { writeMachine(flags, { ...loadMachine(flags), graphShown: names }); } catch { /* read-only fs */ }
}
// Shared footer bar for the graph views. mode: 'select' (interactive picker) | 'pager' (read-only graph).
// Order: state -> how to move -> what to toggle (f/r together) -> action -> exit. Count turns RED when
// not all nodes are shown/selected. `scroll` (pager, only when the graph overflows) and `warn` (select,
// e.g. "not connected") are optional. Returns the inner bar text; the caller adds the reverse-video + pad.
function graphFooter({ mode, total, sel, vis, shown, hasRef, showRef, warn = '', scroll = '', dbg = false, env = false }) {
  const red = (n, d) => (n < d ? `\x1b[31m${n}/${d}\x1b[39m` : `${n}/${d}`); // red when partial; 39m keeps the reverse bar (not a full reset)
  const parts = [];
  if (mode === 'select') { // selector shows TWO counts: `sel` = picked-to-run, `shown` = visible after the f-filter
    parts.push(`${sel}/${total} sel · ${red(vis, total)} shown${warn ? ` ${warn}` : ''}`);
    parts.push('↑↓←→ move', 'space pick', ...(dbg ? ['d debug'] : []), ...(env ? ['e env'] : []), 'a all'); // d/e only when the focused node is local + has a debug task / overrides
  } else {
    parts.push(red(shown, total) + ' shown' + (warn ? ` ${warn}` : ''));
    if (scroll) parts.push(scroll);
  }
  parts.push('f filter');
  if (hasRef) parts.push(`r refs ${showRef ? 'on' : 'off'}`);
  if (mode === 'select') parts.push('enter run');
  parts.push(mode === 'select' ? 'esc cancel' : 'esc quit');
  return footerText(parts);
}

// Shared footer rendering for every raw-mode view (graph pager, selector, guards editor), so they all
// look identical: a ` · `-joined hint line (footerText) painted as one full-width reverse-video bar
// (footerBar). Callers prepend `\x1b[K` + any cursor positioning. ANSI inside survives the bar as long
// as it resets with `\x1b[39m`/`\x1b[27m` (fg/attr only), never a full `\x1b[0m`.
function footerText(parts) { return ` ${parts.filter(Boolean).join(' · ')} `; }
function footerBar(inner, cols) {
  const wide = [...inner.replace(/\x1b\[[0-9;]*m/g, '')].length; // display width, ANSI-stripped
  return '\x1b[7m' + inner + ' '.repeat(Math.max(0, cols - wide)) + '\x1b[0m';
}
// Render a line as a dimmed backdrop behind a modal: STRIP its own colours/reverse and repaint the plain
// text in faint dark-grey, so the whole background recedes uniformly (not a colourful faint wash). 0m at end.
function dimText(s) { return '\x1b[2m\x1b[38;5;240m' + String(s).replace(/\x1b\[[0-9;]*m/g, '') + '\x1b[0m'; }

// Split one stdin `data` chunk into individual key tokens — a single read can bundle several
// keystrokes (fast typing, paste, PTY batching, e.g. space+Enter arriving as " \r"). An escape
// sequence (CSI `\x1b[…<final>`, SS3 `\x1bO…`, incl. SGR mouse ending in M/m) stays one token;
// everything else is one char. Lets a key handler process a coalesced chunk key-by-key.
function splitKeys(s) {
  const out = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\x1b' && (s[i + 1] === '[' || s[i + 1] === 'O')) {
      let j = i + 2;
      while (j < s.length && !/[A-Za-z~]/.test(s[j])) j++; // params run until the final letter/~
      out.push(s.slice(i, j + 1)); i = j + 1;
    } else if (s[i] === '\x1b' && (s[i + 1] === 'b' || s[i + 1] === 'f')) { out.push(s.slice(i, i + 2)); i += 2; } // Alt-b / Alt-f only (word move) — the sole meta bindings
    else { out.push(s[i]); i++; } // everything else, INCLUDING a lone ESC: its following key stays a separate token (so a coalesced "esc then s" isn't misread as Alt-s)
  }
  return out;
}

// A right-anchored pick panel that OVERLAYS a graph/form view. The underlying view stays drawn to the
// left; the caller paints `.rows(h)` over the screen's rightmost columns each frame and feeds keys to
// `.key(k)`. `.key` returns 'apply' (close, take `.selected`), 'cancel' (close, discard), 'change' (stay
// open, repaint) or null (ignored). Two modes: MULTI (default) = checkboxes, `space`/`a` toggle, `⏎`
// applies the whole set (graph node filter, service guard links); SINGLE (`{single:true}`) = radio, `⏎`
// (or space) picks the cursor row and applies immediately (service `type`). Self-contained cursor/scroll/
// selection — no screen clear, so the view never disappears. `esc`/`q` cancel.
function makeFilterPanel(items, { paint, title = 'Show nodes', single = false } = {}) {
  // An item is a selectable string, or a `{header:'TEXT'}` non-selectable group label (skipped by the
  // cursor, excluded from `selected`/`a`). Headers are inert when none are passed (f/config stay flat).
  const isH = (n) => n && typeof n === 'object' && 'header' in n;
  const text = (n) => (isH(n) ? n.header : n);
  const disp = (s) => [...String(s).replace(/\x1b\[[0-9;]*m/g, '')].length;         // display width, ANSI-stripped
  const colOf = (n) => { const f = paint && paint.get && paint.get(n); return typeof f === 'function' ? f : (x) => x; };
  const pick = items.filter((n) => !isH(n));                                // the selectable items
  const nameMax = items.reduce((m, n) => Math.max(m, disp(text(n))), 0);
  const innerW = Math.max(disp(title) + 4, nameMax + 6);                    // "─ title ─" and " ▸[x] name" both fit
  const H = '─';
  const firstSel = () => { const i = items.findIndex((n) => !isH(n)); return i < 0 ? 0 : i; };
  const step = (from, dir) => { let i = from; do { i += dir; } while (i >= 0 && i < items.length && isH(items[i])); return i >= 0 && i < items.length ? i : from; };
  let selected = new Set(pick), cursor = firstSel(), scroll = 0, active = false;
  const pad = (s, cur) => { const body = s + ' '.repeat(Math.max(0, innerW - disp(s))); return '│' + (cur ? '\x1b[7m' + body + '\x1b[27m' : body) + '│'; };
  return {
    get active() { return active; },
    get selected() { return selected; },
    get width() { return innerW + 2; },                                     // │ … │
    open(pre) { // single: pre is the current value (string) -> cursor lands on it; multi: pre is an array (even empty = exact set; null = all)
      if (single) { const v = Array.isArray(pre) ? pre[0] : pre; selected = new Set(v != null && pick.includes(v) ? [v] : []); cursor = v != null && items.includes(v) ? items.indexOf(v) : firstSel(); }
      else { const p = Array.isArray(pre) ? pre.filter((n) => pick.includes(n)) : pick.slice(); selected = new Set(p); cursor = firstSel(); }
      scroll = 0; active = true;
    },
    close() { active = false; },
    key(k) {
      if (k === '\x1b') return 'cancel';
      if (k === 'j' || k === '\x1b[B') { cursor = step(cursor, 1); return 'change'; }
      if (k === 'k' || k === '\x1b[A') { cursor = step(cursor, -1); return 'change'; }
      if (single) { if ((k === '\r' || k === '\n' || k === ' ') && !isH(items[cursor])) { selected = new Set([items[cursor]]); return 'apply'; } return null; }
      if (k === '\r' || k === '\n') return 'apply';
      if (k === ' ') { const n = items[cursor]; if (isH(n)) return null; selected.has(n) ? selected.delete(n) : selected.add(n); return 'change'; }
      if (k === 'a') { selected = pick.every((n) => selected.has(n)) ? new Set() : new Set(pick); return 'change'; }
      return null;
    },
    // Unboxed, full-WIDTH list lines (no border) for rendering INSIDE a pane rather than as an overlay —
    // used by the config editor so a pick fills the right column like the map editor. Same cursor/scroll/marks.
    bareRows(maxH, width) {
      const vis = Math.max(1, Math.min(items.length, maxH));
      if (cursor < scroll) scroll = cursor; else if (cursor >= scroll + vis) scroll = cursor - vis + 1;
      scroll = Math.max(0, Math.min(scroll, Math.max(0, items.length - vis)));
      const padW = (str) => str + ' '.repeat(Math.max(0, width - disp(str)));
      const out = [];
      for (let i = 0; i < vis; i++) {
        const idx = scroll + i, n = items[idx], cur = idx === cursor;
        if (isH(n)) { out.push(padW(`  \x1b[2m${text(n)}\x1b[22m`)); continue; }
        const mark = single ? (selected.has(n) ? '(•)' : '( )') : (selected.has(n) ? '[x]' : '[ ]');
        out.push(cur ? '\x1b[7m' + padW(` ▸ ${mark} ${n}`) + '\x1b[27m' : padW(` ${' '} ${mark} ${colOf(n)(n)}`));
      }
      return out;
    },
    // Boxed panel as an array of full rows, capped to `maxH` (scrolls the item list to keep the cursor in view).
    rows(maxH) {
      const chrome = 4;                                                     // title border + separator + hint + bottom border
      const vis = Math.max(1, Math.min(items.length, (maxH || items.length + chrome) - chrome));
      if (cursor < scroll) scroll = cursor; else if (cursor >= scroll + vis) scroll = cursor - vis + 1;
      scroll = Math.max(0, Math.min(scroll, Math.max(0, items.length - vis)));
      const up = scroll > 0, down = scroll + vis < items.length;           // more items off-screen?
      const t = `${H} ${title} `;
      const out = ['┌' + t + H.repeat(Math.max(0, innerW - disp(t) - 1)) + (up ? '↑' : H) + '┐'];
      for (let i = 0; i < vis; i++) {
        const idx = scroll + i, n = items[idx], cur = idx === cursor;
        if (isH(n)) { out.push(pad(`  \x1b[2m${text(n)}\x1b[22m`, false)); continue; }
        const mark = single ? (selected.has(n) ? '(•)' : '( )') : (selected.has(n) ? '[x]' : '[ ]');
        out.push(pad(` ${cur ? '▸' : ' '}${mark} ${cur ? n : colOf(n)(n)}`, cur));
      }
      out.push('├' + H.repeat(innerW - 1) + (down ? '↓' : H) + '┤');
      const hint = single ? ' ↑↓·↵·esc' : ' space·a·↵·esc';
      out.push('│' + hint + ' '.repeat(Math.max(0, innerW - disp(hint))) + '│');
      out.push('└' + H.repeat(innerW) + '┘');
      return out;
    },
  };
}

export const SERVICE_TYPES = ['frontend', 'backend', 'fullstack', 'other'];

// ---------------------------------------------------------------------------
// Config-validation key sets (used by `crew check`).
// ---------------------------------------------------------------------------
export const TOP_KEYS = new Set(['version', 'workspaceName', 'workspaceSettings', 'services', 'guards', 'overrides']);
export const SERVICE_KEYS = new Set(['path', 'type', 'runner', 'env', 'local', 'match', 'tasks', 'guards', 'defaultBranch']);
export const GUARD_KEYS = new Set(['comment', 'command', 'message']);
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
// Strip keys the schema doesn't know (top-level / per-service / per-guard) — the visual editor calls this
// on every write so a save fully normalizes the file (unknown/typo/removed keys are dropped, not carried).
export function pruneConfig(cfg) {
  for (const k of Object.keys(cfg)) if (!TOP_KEYS.has(k)) delete cfg[k];
  for (const p of Object.values(cfg.services || {})) if (isObj(p)) for (const k of Object.keys(p)) if (!SERVICE_KEYS.has(k)) delete p[k];
  for (const g of Object.values(cfg.guards || {})) if (isObj(g)) for (const k of Object.keys(g)) if (!GUARD_KEYS.has(k)) delete g[k];
  return cfg;
}

// ==================== wiring ====================
// Directed dependency edges among the given [name, service] entries: name -> Set(peer).
// Same rule as `crew graph` (exact hostname match).
export function dependencyEdges(cfg, entries) {
  const meta = {};
  for (const [name, service] of entries) {
    meta[name] = { files: serviceEnvFiles(service), ...serviceIdentity(service) };
  }
  const edges = new Map(entries.map(([n]) => [n, new Set()]));
  for (const [name] of entries) {
    const seen = new Map();
    for (const f of meta[name].files) {
      let text = '';
      try {
        text = readFileSync(f.path, 'utf8');
      } catch {
        /* skip */
      }
      for (const u of text.match(URL_RE) || []) {
        const p = urlHostPath(u);
        if (p) seen.set(p.host + '\n' + p.path, p);
      }
    }
    for (const { host, path } of seen.values()) {
      let best = null;
      let bestLen = 0;
      for (const [t] of entries)
        for (const tok of meta[t].tokens) {
          const len = tokenMatchLen(host, path, tok);
          if (len > bestLen) {
            bestLen = len;
            best = t;
          }
        }
      if (best && best !== name && !isReferenceEdge(cfg, name, best)) edges.get(name).add(best);
    }
  }
  return edges;
}

// Connected components (undirected) of the induced dependency subgraph over `names` — using
// a precomputed directed `edges` map, so this is pure/cheap enough to call on every keypress.
export function componentsFrom(edges, names) {
  const set = new Set(names);
  const adj = new Map(names.map((n) => [n, new Set()]));
  for (const from of names)
    for (const to of edges.get(from) || [])
      if (set.has(to)) {
        adj.get(from).add(to);
        adj.get(to).add(from);
      }
  const seen = new Set();
  const comps = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    const stack = [n];
    const comp = [];
    seen.add(n);
    while (stack.length) {
      const x = stack.pop();
      comp.push(x);
      for (const y of adj.get(x)) if (!seen.has(y)) (seen.add(y), stack.push(y));
    }
    comps.push(comp);
  }
  return comps;
}

// Single-line connectivity status for a selection, using precomputed `edges`. Empty when
// there's nothing to say (unless verbose, which also emits the <2 hint and the ✓ line).
// Disconnected => one inline line listing the islands (they run with no local wiring between).
export function connectivityStatus(cfg, edges, names, verbose = false) {
  const valid = names.filter((n) => cfg.services[n]);
  if (valid.length < 2) return verbose ? c.dim('  select 2+ services to check local wiring') : '';
  const comps = componentsFrom(edges, valid);
  if (comps.length <= 1)
    return verbose ? '  ' + c.green('✓') + c.dim(' connected') : '';
  const paint = serviceColors(cfg);
  const islands = comps
    .sort((a, b) => b.length - a.length)
    .map((comp) => comp.map((n) => paint.get(n)(n)).join(c.dim('·')))
    .join(c.dim('  |  '));
  return '  ' + c.yellow('⚠ not connected:') + ' ' + islands;
}

// Verify every member's path exists. Names the offending service.
export function validateMemberPaths(members) {
  for (const m of members) {
    const p = resolveServicePath(m.service.path);
    if (!pathExists(p)) fail(`service '${m.name}': path not found: ${p}`);
  }
}

// Build a deduped absolute-path list of member service paths, first-seen order.
export function dirList(members) {
  const seen = new Set();
  const out = [];
  for (const m of members) {
    const abs = resolveServicePath(m.service.path);
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

export function serviceDir(service) {
  return resolveServicePath(service.path);
}

// ---------------------------------------------------------------------------
// Task resolution — tasks[task] -> runner{task} -> skip. Strict placeholders.
// ---------------------------------------------------------------------------
export function resolveRun(cfg, task, members, args) {
  const runnable = [];
  const skipped = [];
  for (const m of members) {
    const t = m.task || task; // a member can override the task (e.g. 'debug' from the selector); else the command's task
    let template;
    if (m.service.tasks && m.service.tasks[t] != null) template = m.service.tasks[t];
    else if (m.service.runner) template = m.service.runner;
    else {
      skipped.push(m.name);
      continue;
    }
    runnable.push({ name: m.name, service: m.service, template, task: t });
  }
  if (runnable.length === 0)
    fail(`no service in target can run task '${task}' (all run-less for this task)`);

  // Reserved placeholders crew fills itself (not from user args): {task} = the task name;
  // {envfile} = the per-service wired env file crew materializes at start (see cmdStart).
  const RESERVED = new Set(['task', 'envfile']);
  // Union of placeholders across all runnable commands, excluding the reserved ones.
  const union = new Set();
  for (const r of runnable)
    for (const p of placeholdersIn(r.template)) if (!RESERVED.has(p)) union.add(p);

  // Parse user args: key=value fills {key}; bare positional fills a remaining one.
  const keyVals = {};
  const positionals = [];
  for (const a of args) {
    const eq = a.indexOf('=');
    if (eq > 0 && /^[A-Za-z0-9_]+$/.test(a.slice(0, eq))) keyVals[a.slice(0, eq)] = a.slice(eq + 1);
    else positionals.push(a);
  }

  // Unknown key=value (matches no placeholder in the target): collect a warning and skip, don't
  // abort — lets `crew start backend env=local` run even though backend has no {env}. Returned (not
  // printed here) so the caller can route it into the viewer instead of leaking onto the screen.
  const argWarnings = [];
  const unknown = Object.keys(keyVals).filter((k) => !union.has(k));
  if (unknown.length)
    argWarnings.push(
      `ignoring unused argument(s): ${unknown.join(', ')}. ` +
        `Task '${task}' takes: ${[...union].join(', ') || '(none)'}`
    );

  const remaining = [...union].filter((k) => !(k in keyVals)).sort();
  if (positionals.length > remaining.length)
    fail(
      `too many positional args (${positionals.length}) for ${remaining.length} ` +
        `unfilled placeholder(s): ${remaining.join(', ') || '(none)'}`
    );

  const values = { task, ...keyVals };
  remaining.forEach((k, i) => {
    if (i < positionals.length) values[k] = positionals[i];
  });

  // Per-service value set: {env} is DERIVED from the chain — the entry (root) runs at the
  // selection env; every other service inherits the env-variant its consumer's env file points
  // at (see resolveEnvs). Everything else is shared. Strict-check + substitution run per service.
  const derived = values.env != null ? resolveEnvs(cfg, members, values.env) : { resolved: new Map(), warnings: [] };
  const unresolved = new Set();
  for (const r of runnable) {
    const env = derived.resolved.get(r.name);
    r._values = env == null ? { ...values, task: r.task } : { ...values, env, task: r.task }; // {task} resolves per-member (start/debug)
    for (const p of placeholdersIn(r.template))
      if (!RESERVED.has(p) && !(p in r._values)) unresolved.add(p);
    // Only the env-file path needs its placeholders resolved when the command actually sources
    // it via {envfile}; a task that doesn't reference {envfile} doesn't touch the env file, so don't demand {env}.
    if (r.service.env && r.template.includes('{envfile}'))
      for (const p of placeholdersIn(r.service.env))
        if (!RESERVED.has(p) && !(p in r._values)) unresolved.add(p);
  }
  if (unresolved.size)
    fail(
      `unresolved placeholder(s): ${[...unresolved].join(', ')}. ` +
        `Provide as a positional or key=value.`
    );

  for (const r of runnable) {
    r.resolved = substitute(r.template, r._values); // {envfile} left intact for cmdStart
    // Resolve the base env-file path (if declared) with the same values — raw (no shell
    // quoting): it's a filesystem path crew reads, not a shell token.
    r.envFile = r.service.env
      ? r.service.env.replace(PLACEHOLDER_RE, (m, k) => (k in r._values ? r._values[k] : m))
      : null;
  }
  return { runnable, skipped, warnings: [...argWarnings, ...derived.warnings] };
}

// Scan <dir>/.envs, parse each file's name as <env>[-<slug>] (slug optional; some services
// name files plainly, e.g. `pre`, `qa`). Returns [{env, slug, path}].
export function envFilesFor(dir) {
  const envsDir = join(dir, '.envs');
  let names = [];
  try {
    // Skip hidden/editor junk, but KEEP dotfile env files (`.env`, `.env.qa`, …) — some services
    // (e.g. the loader) name their envs that way, and the graph must read them for edges.
    names = readdirSync(envsDir).filter((n) => !n.startsWith('.') || n === '.env' || n.startsWith('.env.'));
  } catch {
    return [];
  }
  return names.map((name) => {
    // Dotfile convention `.env.<env>` (e.g. the loader: .env.qa, .env.pre) → env is <env>.
    const dot = /^\.env\.(.+)$/.exec(name);
    if (dot) return { env: dot[1], slug: '', path: join(envsDir, name) };
    if (name === '.env') return { env: 'default', slug: '', path: join(envsDir, name) };
    const base = name.replace(/\.env$/, '');
    const dash = base.indexOf('-');
    const env = dash > 0 ? base.slice(0, dash) : base;
    const slug = dash > 0 ? base.slice(dash + 1) : '';
    return { env, slug, path: join(envsDir, name) };
  });
}

// Enumerate a service's env files. If it declares `env` (a path template containing {env}), resolve
// that template against the filesystem — {env} becomes a wildcard, captured CONSISTENTLY across every
// occurrence — so monorepo layouts like `.envs/<app>/{env}/{env}-foo.env` (or a `../.envs/...` path)
// are found and the env label comes from the template, not a fixed `.envs` dir. This makes the `env`
// field the single source of truth for env-file location (wiring AND the graph). No template (or a
// static `env` with no {env}) -> the default `<dir>/.envs` scan.
export function serviceEnvFiles(service) {
  let dir;
  try {
    dir = resolveServicePath(service.path);
  } catch {
    return [];
  }
  const tmpl = service && service.env;
  if (!tmpl || !tmpl.includes('{env}')) return envFilesFor(dir);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const segs = tmpl.split('/');
  const firstGlob = segs.findIndex((s) => s.includes('{env}'));
  const base = join(dir, ...segs.slice(0, firstGlob)); // static prefix (path.join collapses . / ..)
  const rest = segs.slice(firstGlob);
  const out = [];
  const walk = (d, i, boundEnv) => {
    const seg = rest[i];
    const isLast = i === rest.length - 1;
    const globbed = seg.includes('{env}');
    const re = globbed ? new RegExp('^' + seg.split('{env}').map(esc).join('(.+?)') + '$') : null;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      let env = boundEnv;
      if (globbed) {
        if (e.name.startsWith('.') && !seg.startsWith('.')) continue; // dotfiles aren't env variants
        const m = re.exec(e.name);
        if (!m) continue;
        const vals = m.slice(1);
        if (!vals.every((v) => v === vals[0])) continue; // every {env} occurrence must agree
        if (boundEnv != null && vals[0] !== boundEnv) continue;
        env = vals[0];
      } else if (e.name !== seg) {
        continue; // literal segment must match exactly
      }
      const p = join(d, e.name);
      if (isLast) {
        if (!e.isDirectory()) out.push({ env, slug: '', path: p });
      } else if (e.isDirectory()) {
        walk(p, i + 1, env);
      }
    }
  };
  walk(base, 0, null);
  return out;
}
export const URL_RE = /\bhttps?:\/\/[^\s"'`)}<]+/g;
// Split a URL into host + path (lowercased, scheme/port/query/trailing-slash dropped).
export function urlHostPath(url) {
  const m = url.match(/^https?:\/\/([^/?#]+)([^?#\s]*)/i);
  if (!m) return null;
  const host = m[1].replace(/:\d+$/, '').toLowerCase();
  const path = (m[2] || '').replace(/\/+$/, '').toLowerCase();
  return { host, path };
}
// A match token identifies a service by EXACT host, optionally narrowed by a path prefix:
//   - `api.getbee.io`                       → matches any URL on that host (host-swap wiring).
//   - `host/plugin/v2/BeePlugin.js`         → matches only URLs on that host whose path is (or is
//     under) that path — used when two services share a host but differ by path, or when the
//     local rewrite must change the path too (full-URL wiring; see wireText). Exact host, no
//     globs → no cross-service collisions. Returns the matched length (host or host+path) so the
//     most-specific token wins.
export function tokenMatchLen(host, path, tok) {
  tok = String(tok).toLowerCase();
  if (!tok) return 0;
  const slash = tok.indexOf('/');
  if (slash === -1) return tok === host ? tok.length : 0; // host-only token
  const tokHost = tok.slice(0, slash);
  const tokPath = tok.slice(slash).replace(/\/+$/, ''); // e.g. '/plugin/v2/beeplugin.js'
  if (host !== tokHost) return 0;
  return path === tokPath || path.startsWith(tokPath + '/') ? tok.length : 0;
}

// The scheme://host[:port] prefix of a URL (drops path/query/fragment). '' if not a URL.
export function originOf(url) {
  const m = String(url).match(/^https?:\/\/[^/?#\s]+/i);
  return m ? m[0] : '';
}
// Rewrite env-file text for local wiring: every URL matching a co-running peer's token is
// pointed at that peer locally. A host-only token swaps just the origin (path/query preserved);
// a host+path token replaces the WHOLE URL with the peer's full `local` (so the local path can
// differ from the deployed one — e.g. `…/plugin/v2/BeePlugin.js` → `localhost:8088/v2/api/loader`).
// Most-specific token wins. Peers absent from `peers` stay remote. `peers` = [{ tokens, origin, local }].
export function wireText(text, peers) {
  return text.replace(URL_RE, (url) => {
    const p = urlHostPath(url);
    if (!p) return url;
    let best = null;
    let bestLen = 0;
    let bestTok = null;
    for (const peer of peers)
      for (const tok of peer.tokens) {
        const len = tokenMatchLen(p.host, p.path, tok);
        if (len > bestLen) {
          bestLen = len;
          best = peer;
          bestTok = tok;
        }
      }
    if (!best) return url;
    if (String(bestTok).includes('/')) return best.local; // path token: replace the whole URL
    const o = originOf(url);
    return o ? best.origin + url.slice(o.length) : url; // host token: swap origin, keep path
  });
}

// Local-wiring env overrides (config.json `overrides` — committable, no secrets). When crew starts a
// service locally it materializes a wired env for it; `overrides["<service>"]` upserts extra
// `KEY=value` lines into that env. Two forms:
//   - bare `VAR: val`  — applied whenever the service runs (e.g. a Temporal queue so your local
//     worker consumes `foo-local` not shared `foo`);
//   - `whenLocal: { "<peer>": { VAR: val } }` — applied ONLY when that peer is also being started
//     (e.g. point a URL at a local dependency's exact host+path, but only while it's up).
// `whenLocal` beats bare (applied last). `running` = names of all services being started.
// Secrets/personal values live in local.json (untracked), never in the shared config. Overrides
// beat the base env file and the URL swap.
export const OVERRIDE_WHEN_LOCAL = 'whenLocal';
export function overrideVarsFor(overrides, name, running, off) {
  const skip = off instanceof Set ? off : new Set(off || []); // per-run disabled keys: bare `VAR` or `peer.VAR` (the `e` toggle)
  const o = overrides && overrides[name];
  if (!o || typeof o !== 'object') return {};
  const vars = {};
  for (const [k, v] of Object.entries(o)) if (k !== OVERRIDE_WHEN_LOCAL && !skip.has(k)) vars[k] = v;
  const wl = o[OVERRIDE_WHEN_LOCAL];
  if (wl && typeof wl === 'object') for (const peer of running || []) if (wl[peer] && typeof wl[peer] === 'object') for (const [k, v] of Object.entries(wl[peer])) if (!skip.has(`${peer}.${k}`)) vars[k] = v;
  return vars;
}
// The keys `overrideVarsFor`/the `e` toggle use to identify each override of a service: bare `VAR`, and
// `peer.VAR` for a whenLocal entry. Order: bare first, then per-peer. Each row = { key, var, value, peer }.
export function overrideEntries(mergedForService) {
  const o = mergedForService || {};
  const out = [];
  for (const [k, v] of Object.entries(o)) if (k !== OVERRIDE_WHEN_LOCAL) out.push({ key: k, var: k, value: String(v), peer: '' });
  const wl = o[OVERRIDE_WHEN_LOCAL];
  if (wl && typeof wl === 'object') for (const peer of Object.keys(wl)) if (wl[peer] && typeof wl[peer] === 'object') for (const [vk, vv] of Object.entries(wl[peer])) out.push({ key: `${peer}.${vk}`, var: vk, value: String(vv), peer });
  return out;
}
// TWO-LAYER overrides: `config.json.overrides` (committable, shared, non-secret) MERGED with
// `local.json.overrides` (machine-local, gitignored — per-user/secret values like a DB password).
// local WINS, per service + per var + per whenLocal[peer][var]. So DB_HOST/PORT/NAME can be shared in
// the config while only DB_PASSWORD lives in each dev's local.json.
export function mergeOverrides(cfgOv, localOv) {
  const out = {};
  for (const p of new Set([...Object.keys(cfgOv || {}), ...Object.keys(localOv || {})])) {
    const a = (cfgOv && cfgOv[p]) || {}, b = (localOv && localOv[p]) || {}, m = {};
    for (const [k, v] of Object.entries(a)) if (k !== OVERRIDE_WHEN_LOCAL) m[k] = v;
    for (const [k, v] of Object.entries(b)) if (k !== OVERRIDE_WHEN_LOCAL) m[k] = v; // local bare wins
    const aw = a[OVERRIDE_WHEN_LOCAL], bw = b[OVERRIDE_WHEN_LOCAL];
    if ((aw && typeof aw === 'object') || (bw && typeof bw === 'object')) {
      const wl = {};
      for (const peer of new Set([...Object.keys(aw || {}), ...Object.keys(bw || {})])) wl[peer] = { ...((aw && aw[peer]) || {}), ...((bw && bw[peer]) || {}) }; // local peer-var wins
      m[OVERRIDE_WHEN_LOCAL] = wl;
    }
    if (Object.keys(m).length) out[p] = m;
  }
  return out;
}
// dotenv/sh-safe: quote only values with characters outside a safe set, so plain keys/tokens
// stay unquoted (max compat with both `. envfile` sourcing and dotenv-style loaders).
export function envOverrideValue(v) {
  const s = String(v);
  return /^[A-Za-z0-9_.:@/=+-]*$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}
// Upsert each KEY=value into env-file text: replace an existing assignment (optionally
// `export`-prefixed) in place, else append. Returns the new text and the keys applied.
export function applyEnvOverrides(text, vars) {
  const applied = [];
  const warnings = []; // collected (not printed) so the caller can route them into the viewer, not the screen
  let out = text;
  for (const [k, v] of Object.entries(vars || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      warnings.push(`override: skipping invalid env var name '${k}'`);
      continue;
    }
    if (v === null || typeof v === 'object') {
      warnings.push(`override: '${k}' must be a string value — got ${Array.isArray(v) ? 'array' : typeof v}`);
      continue;
    }
    const line = `${k}=${envOverrideValue(v)}`;
    const re = new RegExp(`^([ \\t]*(?:export[ \\t]+)?)${k}=.*$`, 'm');
    if (re.test(out)) out = out.replace(re, (_m, pre) => pre + line);
    else out += (out === '' || out.endsWith('\n') ? '' : '\n') + line + '\n';
    applied.push(k);
  }
  return { text: out, applied, warnings };
}

// Best-effort copy to the system clipboard (zero-dep: shell out to the platform tool). Returns
// the tool used, or null if none is available. macOS = pbcopy; Linux = wl-copy / xclip / xsel.
export function clipboardCopy(text) {
  const tools =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of tools) {
    const r = spawnSync(cmd, args, { input: text });
    if (!r.error && r.status === 0) return cmd;
  }
  return null;
}

// A service's id comes from config `match`, an ENV-LABELED map `{ env: host | [hosts] }` — the
// complete hostname(s) it is served under per environment (exact strings, optionally host/path).
// `tokens` = the flat host list (identity for edges + wiring); `envOf` maps each host token
// (lowercased) to its env label (so a matched URL reveals which env it points at — the basis for
// env derivation). No `match` = no id, so nothing can point at it.
export function serviceIdentity(service) {
  const m = service && service.match;
  const tokens = [];
  const envOf = new Map();
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    for (const [env, v] of Object.entries(m)) {
      for (const h of Array.isArray(v) ? v : [v]) {
        if (!h) continue;
        tokens.push(h);
        envOf.set(String(h).toLowerCase(), env);
      }
    }
  }
  return { tokens, envOf, source: tokens.length ? 'match' : 'none' };
}

// A URL from a non-frontend INTO a `type: frontend` service is a REFERENCE (a link-back /
// allowed-origin / redirect base — e.g. a backend embedding the app's public URL), NOT a runtime
// dependency. It's still shown in `crew graph` (marked), but excluded from connectivity and env
// derivation — so a backend that merely links to the frontend can't make an unrelated selection
// look "connected", nor seed the frontend's env. Nothing legitimately *depends on* a frontend
// except another frontend embedding it (which stays an edge). Uses the declared `type` only.
export function isReferenceEdge(cfg, from, to) {
  const f = cfg.services && cfg.services[from];
  const t = cfg.services && cfg.services[to];
  return !!(t && t.type === 'frontend' && f && f.type !== 'frontend');
}

// Tarjan's strongly-connected components over adjacency `adj` (Map node -> Set(neighbors)),
// visiting `nodes`. Returns an array of components (each an array of node names). Used to find
// the "entry clusters" for env derivation: a dependency cycle (e.g. frontend <-> backend refs)
// collapses into one component so it's seeded as a single unit rather than breaking root-finding.
export function stronglyConnected(nodes, adj) {
  let idx = 0;
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [], comps = [];
  const strong = (v) => {
    index.set(v, idx); low.set(v, idx); idx++; stack.push(v); onStack.add(v);
    for (const w of adj.get(v) || []) {
      if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = []; let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      comps.push(comp);
    }
  };
  for (const v of nodes) if (!index.has(v)) strong(v);
  return comps;
}

// Derive each selected service's run-env from the chain. The selection env `selEnv` seeds the
// ENTRY CLUSTERS (source SCCs — services nothing else in the selection depends on); every other
// service inherits the env-variant its consumer's env file actually points at (host -> env via the
// labeled `match`). BFS from the seeds, so the claim CLOSEST TO an entry wins; within one file the
// MAJORITY label wins. Disagreements, missing envs and unreached nodes are reported, never silently
// mis-resolved. Returns { resolved: Map(name -> env), warnings: string[] }.
export function resolveEnvs(cfg, selection, selEnv) {
  const names = (selection || [])
    .map((m) => (typeof m === 'string' ? m : m.name))
    .filter((n) => cfg.services && cfg.services[n]);
  const set = new Set(names);
  const warnings = [];
  const resolved = new Map();
  if (selEnv == null || !names.length) return { resolved, warnings };

  const meta = {};
  for (const n of names) {
    const p = cfg.services[n];
    const byEnv = {};
    for (const f of serviceEnvFiles(p)) if (!(f.env in byEnv)) byEnv[f.env] = f.path;
    meta[n] = { byEnv, envs: Object.keys(byEnv), ...serviceIdentity(p) };
  }

  // Best (longest-token) peer a URL points at, plus that peer's env label for the matched host.
  const matchUrl = (host, path) => {
    let best = null, bestLen = 0, bestEnv = null;
    for (const t of names)
      for (const tok of meta[t].tokens) {
        const len = tokenMatchLen(host, path, tok);
        if (len > bestLen) { bestLen = len; best = t; bestEnv = meta[t].envOf.get(String(tok).toLowerCase()) ?? null; }
      }
    return best ? { target: best, env: bestEnv } : null;
  };

  // Consumer `n`'s claims when running at env `e`: per target, the MAJORITY env-label its file
  // points at (tie -> lexical), with minority labels as `alt` (within-file disagreement = dirt).
  const claimsOf = (n, e) => {
    const file = meta[n].byEnv[e];
    if (!file) return [];
    let text = ''; try { text = readFileSync(file, 'utf8'); } catch { return []; }
    const byT = new Map(); // target -> Map(env -> count)
    for (const u of text.match(URL_RE) || []) {
      const p = urlHostPath(u); if (!p) continue;
      const hit = matchUrl(p.host, p.path);
      if (!hit || hit.target === n || hit.env == null) continue;
      if (isReferenceEdge(cfg, n, hit.target)) continue; // link-back, not a dependency
      const em = byT.get(hit.target) || new Map();
      em.set(hit.env, (em.get(hit.env) || 0) + 1); byT.set(hit.target, em);
    }
    const out = [];
    for (const [target, envs] of byT) {
      const sorted = [...envs.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      out.push({ target, env: sorted[0][0], alt: sorted.slice(1).map((x) => x[0]) });
    }
    return out;
  };

  // Structural edges (scan ALL of a consumer's env files) for SCC/entry detection.
  const adj = new Map(names.map((n) => [n, new Set()]));
  for (const n of names)
    for (const e of meta[n].envs)
      for (const c of claimsOf(n, e)) if (set.has(c.target)) adj.get(n).add(c.target);

  // Entry clusters = source SCCs (no inbound edge from another component).
  const comps = stronglyConnected(names, adj);
  const compOf = new Map(); comps.forEach((c, i) => c.forEach((n) => compOf.set(n, i)));
  const inbound = new Array(comps.length).fill(false);
  for (const n of names) for (const t of adj.get(n)) if (compOf.get(n) !== compOf.get(t)) inbound[compOf.get(t)] = true;

  const q = [];
  const seed = (n, note) => {
    resolved.set(n, selEnv);
    q.push(n);
    if (!meta[n].envs.includes(selEnv)) warnings.push(`${n}: no '${selEnv}' env file — running ${selEnv} anyway`);
    if (note) warnings.push(note);
  };
  // BFS from the current seeds; first claim wins (closest to an entry); disagreements warned.
  const drain = () => {
    while (q.length) {
      const n = q.shift();
      for (const c of claimsOf(n, resolved.get(n))) {
        if (!set.has(c.target)) continue;
        if (c.alt.length) warnings.push(`${c.target}: ${n}@${resolved.get(n)} points at ${c.env} (also ${c.alt.join(',')}) — dirty?`);
        if (!resolved.has(c.target)) { resolved.set(c.target, c.env); q.push(c.target); }
        else if (resolved.get(c.target) !== c.env) warnings.push(`${c.target}: keeping ${resolved.get(c.target)} (closer to entry) vs ${c.env} from ${n}`);
      }
    }
  };

  // Primary entries: source SCCs (nothing in the selection depends on them). Seed at selEnv, derive.
  comps.forEach((comp, i) => { if (!inbound[i]) for (const n of comp) seed(n); });
  drain();

  // Any node still unreached is the entry of its OWN subtree — e.g. the product you're running
  // has an inbound "reference" edge (a backend links back to the frontend), so it isn't a graph
  // source even though it's the real entry. Seed the most-upstream unreached node(s) at selEnv and
  // keep deriving; repeat until everything has an env. (This is why no reference-marker is needed.)
  while (names.some((n) => !resolved.has(n))) {
    const un = names.filter((n) => !resolved.has(n));
    const tops = un.filter((n) => !un.some((m) => m !== n && adj.get(m).has(n)));
    for (const n of tops.length ? tops : [un[0]]) seed(n, `${n}: no upstream consumer selected — running as entry at ${selEnv}`);
    drain();
  }
  return { resolved, warnings };
}

// ==================== prompt ====================
export function canInteractive() {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

// Arrow-key menu (needs an interactive TTY). Single-select returns the chosen item;
// multi-select returns the checked items in toggle order. Esc/q/Ctrl-C -> null.
// Up/Down (or k/j) move; Space toggles (multi); Enter confirms.
// `footer(selection)` (optional) returns a live status block redrawn on every keypress —
// `selection` is the checked items (multi) or the highlighted item. May be multi-line.
export function menu({ title, items, label, multi = false, start = 0, preselected = [], footer = null, erase = false }) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const out = process.stdout;
    let idx = Math.max(0, Math.min(start, items.length - 1));
    const checked = new Set(preselected.filter((v) => items.includes(v)));
    const order = [...checked];
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const hint = multi
      ? '  (↑/↓ move, Space toggle, Enter confirm, Esc cancel)'
      : '  (↑/↓ move, Enter select, Esc cancel)';
    out.write(`${title}${c.dim(hint)}\n`);
    out.write('\x1b[?25l'); // hide cursor

    // Count SCREEN rows, not logical lines: a long line (e.g. the connectivity footer) wraps to
    // several rows, and the cursor-rewind must match or the redraw drifts and duplicates lines.
    const cols = () => process.stdout.columns || 80;
    const rowsOf = (s) => Math.max(1, Math.ceil(s.replace(/\x1b\[[0-9;]*m/g, '').length / cols()));
    let prevLines = 0; // screen rows drawn last render (items + footer), for cursor rewind
    const render = (first) => {
      if (!first) {
        out.write(`\x1b[${prevLines}A`); // back to the top of the block
        out.write('\x1b[0J'); // erase it (items + any stale footer)
      }
      let lines = 0;
      const put = (s) => {
        out.write(s + '\n');
        lines += rowsOf(s);
      };
      items.forEach((it, i) => {
        const cursor = i === idx;
        const ptr = cursor ? c.cyan('❯ ') : '  ';
        const box = multi ? (checked.has(it) ? c.green('◉ ') : '◯ ') : '';
        put(`${ptr}${box}${label(it, cursor)}`);
      });
      if (footer) {
        const f = footer(multi ? order : items[idx]);
        if (f) for (const fl of f.split('\n')) put(fl);
      }
      prevLines = lines;
    };
    render(true);

    const cleanup = () => {
      // `erase`: wipe the whole block (title + items + footer) so it leaves no scrollback trace.
      if (erase) out.write(`\x1b[${prevLines + 1}A\x1b[0J`);
      out.write('\x1b[?25h'); // show cursor
      stdin.removeListener('keypress', onKey);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') {
        idx = (idx - 1 + items.length) % items.length;
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        idx = (idx + 1) % items.length;
        render();
      } else if (multi && key.name === 'space') {
        const it = items[idx];
        if (checked.has(it)) {
          checked.delete(it);
          order.splice(order.indexOf(it), 1);
        } else {
          checked.add(it);
          order.push(it);
        }
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(multi ? order : items[idx]);
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup();
        resolve(null);
      }
    };
    stdin.on('keypress', onKey);
  });
}


// ==================== runner ====================
// ---------------------------------------------------------------------------
// Process runner (POSIX: macOS + Linux). Own implementation, no dependency.
//
// Each command runs in its OWN process group (spawn detached), so teardown signals
// the whole group by pgid — catching grandchildren that reparent away (e.g. a dev
// server's autoreload child) which a ppid-walking tree-kill would miss. Two modes:
// kill-others (long-running) and wait-all (run-to-completion), with SIGTERM -> grace
// -> SIGKILL escalation; a second Ctrl-C force-kills, but only after a window (see
// SIGINT_FORCE_AFTER_MS) so an impatient double-tap can't skip teardown. crew never forwards stdin, so
// detaching the children (which removes them from the TTY foreground group) is safe;
// we forward SIGINT/SIGTERM/SIGHUP to each group ourselves.
// ---------------------------------------------------------------------------
const KILL_GRACE_MS = Number(process.env.CREW_KILL_GRACE_MS) || 5000;
// A second Ctrl-C only force-kills once this long has passed since the first — so an
// impatient double-tap can't skip the graceful group teardown (which orphans supervisord/
// gunicorn-style children). Within the window, extra Ctrl-C is ignored with a nudge.
const SIGINT_FORCE_AFTER_MS = Number(process.env.CREW_FORCE_AFTER_MS) || 10000;

export function runFanout(commands, { killOthers, announceExits, interactive = false, notices = [], guards = [], hidden = [], saveHidden = () => {}, logWrap = true, saveWrap = () => {} }) {
  return new Promise((resolve) => {
    const results = [];
    const live = new Set();
    const spawned = [];
    const timers = [];
    let aborting = false;
    let firstSigintAt = 0;
    let stopRequested = false; // the user asked to quit (vs processes exiting on their own)
    let allStopped = false; // every process has exited but the viewer is held open to review
    let settled = false; // settle() runs once
    let viewerRepaint = () => {}; // set by the interactive viewer so finish() can refresh its footer
    let viewerRunGuards = null; // set by the viewer: runs guards live as rows, resolves pass/fail

    let menuOpen = false; // reentrancy guard for the key handler
    let detachKeys = () => {};
    // Interactive log viewer (created below when streamed to a TTY): keeps a tagged line
    // history and repaints a filtered view, so hiding every service clears the screen. It owns
    // an alternate screen while running. null = plain prefixed streaming (piped / CI).
    let viewer = null;
    const LOG_HISTORY = Number(process.env.CREW_LOG_HISTORY) || 5000;
    // Cap the VISIBLE length of any single log line. Without it, a stream with few newlines (a
    // minified bundle, a base64/binary spew, a giant JSON) makes `pending` grow unbounded and
    // `splitRows` produce hundreds of thousands of wrapped rows per repaint — which wedges the
    // viewer. Overlong lines are clipped with a marker; the process still runs.
    const MAX_LINE = Number(process.env.CREW_MAX_LINE) || 4000;

    // Shared line-aware logger: prefix only at line starts; when a different command
    // interrupts an unterminated line, close it first (standard prefixed-logger behavior).
    const lastWrite = { proc: null, char: '\n' };
    const rawWrite = (s) => {
      try {
        process.stdout.write(s);
      } catch {
        /* EPIPE handled by the stdout 'error' listener */
      }
    };
    const render = (proc, text) => {
      if (!text) return;
      if (lastWrite.proc && lastWrite.proc !== proc && lastWrite.char !== '\n') {
        rawWrite('\n');
        lastWrite.char = '\n';
      }
      // Prefix each non-empty line start. Built per-segment (split on '\n'), not per
      // character — a char loop here pegs the event loop under a high-volume log stream
      // and starves signal handling (Ctrl-C stops responding).
      const pfx = proc._prefix;
      const lines = text.split('\n');
      let out = '';
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) {
          out += '\n';
          lastWrite.char = '\n';
        }
        const seg = lines[i];
        if (seg) {
          if (lastWrite.char === '\n') out += pfx;
          out += seg;
          lastWrite.char = seg[seg.length - 1];
        }
      }
      lastWrite.proc = proc;
      rawWrite(out);
    };
    // Route output: the interactive viewer (if active) captures line history and repaints a
    // filtered view; otherwise stream straight through with per-line prefixes.
    const emit = (proc, text) => {
      if (!text) return;
      if (viewer) return viewer.feed(proc, text);
      render(proc, text);
    };
    const note = (proc, msg) => emit(proc, (lastWrite.char === '\n' ? '' : '\n') + msg + '\n');

    const killGroup = (proc, signal) => {
      if (!proc.pid) return;
      try {
        process.kill(-proc.pid, signal); // negative pid -> the whole process group
      } catch (e) {
        if (e.code !== 'ESRCH') {
          try {
            proc.kill(signal);
          } catch {
            /* already gone */
          }
        }
      }
    };
    const tearDown = (signal) => {
      aborting = true;
      for (const p of live) {
        p._killedByUs = true;
        killGroup(p, signal);
      }
      if (signal !== 'SIGKILL' && live.size) {
        const t = setTimeout(() => {
          for (const p of live) killGroup(p, 'SIGKILL');
        }, KILL_GRACE_MS);
        t.unref();
        timers.push(t);
      }
    };
    const forceKill = () => {
      for (const p of live) killGroup(p, 'SIGKILL');
    };

    // Graceful stop with a double-tap escape hatch (first request -> SIGTERM group + grace; a
    // second within the window force-kills). Shared by the OS SIGINT and the interactive key,
    // since raw mode (the filter UI) swallows the signal so Ctrl-C must be handled by hand.
    const requestStop = () => {
      stopRequested = true;
      if (live.size === 0) return settle(); // nothing running (or all already exited) -> leave now
      const now = Date.now();
      if (!firstSigintAt) {
        firstSigintAt = now;
        return tearDown('SIGINT'); // graceful: SIGTERM group -> grace -> SIGKILL
      }
      if (now - firstSigintAt >= SIGINT_FORCE_AFTER_MS) return forceKill();
      // Still inside the graceful window — ignore the extra request, just nudge.
      const left = Math.ceil((SIGINT_FORCE_AFTER_MS - (now - firstSigintAt)) / 1000);
      if (lastWrite.char !== '\n') rawWrite('\n');
      rawWrite(c.dim(`crew: shutting down… press Ctrl-C again in ${left}s to force-kill\n`));
      lastWrite.char = '\n';
    };

    const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = SIGNALS.map((sig) => {
      const h = () => (sig === 'SIGINT' ? requestStop() : tearDown('SIGTERM'));
      process.on(sig, h);
      return [sig, h];
    });
    const onStdoutErr = () => tearDown('SIGTERM');
    process.stdout.on('error', onStdoutErr);

    const settle = () => {
      if (settled) return;
      settled = true;
      detachKeys(); // leave the alternate screen + restore raw mode before we resolve
      for (const [sig, h] of handlers) process.removeListener(sig, h);
      process.stdout.removeListener('error', onStdoutErr);
      for (const t of timers) clearTimeout(t);
      // Final sweep: SIGKILL each service's process group to reap stragglers that
      // outlived their tracked shell — e.g. a supervisord/gunicorn worker orphaned on a
      // "clean" exit. The leader is already gone, so -pgid only hits survivors (ESRCH is
      // ignored). This is why crew reaps such orphans even when the app's own shutdown
      // (or a wrapper like `uv run`/supervisord) fails to.
      for (const pr of spawned) killGroup(pr, 'SIGKILL');
      if (lastWrite.char !== '\n') rawWrite('\n');
      if (COLOR) rawWrite('\x1b[0m');
      resolve(results);
    };

    const finish = (proc, exitCode) => {
      if (!live.has(proc)) return; // 'error' and 'close' can both fire — settle once
      live.delete(proc);
      results.push({ name: proc._name, index: proc._index, exitCode });
      if (announceExits) note(proc, (exitCode ? c.red : c.dim)(`exited (${exitCode})`));
      if (killOthers && !aborting && live.size) tearDown('SIGTERM');
      if (live.size === 0) {
        // If processes exited on their OWN (crash / boot failure) and the user hasn't asked to
        // quit, hold the interactive viewer open so the error stays on screen — they read it, then
        // press Esc to leave. Otherwise (piped, or a user-requested stop) settle immediately.
        if (interactive && !stopRequested) {
          allStopped = true;
          viewerRepaint();
        } else settle();
      }
    };

    // Spawn all commands. Deferred behind the guard phase (below) so nothing starts until guards
    // pass — and so the viewer is already on screen showing each command as it launches.
    const startSpawn = () => {
      if (settled || stopRequested) return;
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];
        const child = spawn('/bin/sh', ['-c', cmd.command], {
          detached: true, // own process group -> group-kill catches reparented children
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...(COLOR ? { FORCE_COLOR: '1' } : {}), ...process.env },
        });
        child._name = cmd.name;
        child._index = i;
        child._color = cmd.color;
        child._prefix = cmd.color(`[${cmd.name}] `);
        child._killedByUs = false;
        live.add(child);
        spawned.push(child);
        note(child, c.dim(`▶ ${cmd.command}`)); // show the executed command up front
        child.stdout.on('data', (b) => emit(child, b.toString('utf8')));
        child.stderr.on('data', (b) => emit(child, b.toString('utf8')));
        child.on('error', (err) => {
          note(child, c.red(`failed to start: ${err.message}`));
          finish(child, 1);
        });
        child.on('close', (code, signal) => finish(child, code ?? signal));
      }
      if (live.size === 0) settle();
    };

    // Interactive log viewer (streamed mode on a TTY): a full-screen pager on the alternate
    // screen showing the SELECTED services' history, scrollable (keyboard + mouse wheel) with a
    // wrap/cut toggle and a pinned footer. Mouse is captured (SGR) so the wheel scrolls OUR
    // viewport, not the shell — so during the run you only ever see logs. On exit we leave the
    // alternate screen and dump the full history to the terminal, so the logs persist in
    // scrollback. Keys route through requestStop() since raw mode swallows SIGINT. No-op when
    // piped/CI (viewer stays null; output streams with prefixes).
    if (interactive && commands.length) {
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      if (stdin.setRawMode) stdin.setRawMode(true);
      stdin.resume();
      // Guards appear as pseudo-services (`[vpn]`/`[aws]`) — filterable rows. Their names join the
      // service names in the filter list + hidden memory. Rows are added live by viewerRunGuards.
      const guardProcs = new Map(guards.map((g) => [g.name, { _name: g.name, _color: (s) => c.dim(s) }]));
      const names = [...commands.map((cmd) => cmd.name), ...guards.map((g) => g.name)];
      const history = []; // { proc, text } complete lines (capped at LOG_HISTORY); { notice:true } rows are unprefixed + always shown
      for (const n of notices) history.push({ proc: null, text: c.yellow(n), notice: true }); // pre-run skips/warnings, shown inside the viewer (not leaked to the main screen)
      const pending = new Map(); // proc -> partial line not yet terminated
      const shown = new Set(names.filter((n) => !hidden.includes(n))); // persisted hidden applied
      let wrap = logWrap; // wrap long lines vs cut them to one row (persisted preference)
      let scroll = 0; // screen-rows scrolled up from the live bottom (0 = follow tail)
      let active = true; // false while the filter picker owns the screen
      let dirty = false;
      let searching = false; // true while typing a search query
      let query = ''; // active substring filter over rows ('' = off)
      let copyMsg = ''; // transient footer confirmation after a copy
      let copyTimer = null;

      // Uniform prefix width: pad every `[name]` to the longest name so the log text columns line
      // up. Uses the proc's own color (guards are gray). Viewer-only; the piped path keeps `_prefix`.
      const maxName = Math.max(0, ...names.map((n) => n.length));
      const fillW = maxName + 2; // width inside [ ]; the longest name still gets a 1-dot leader
      // `[name ····]` — name in its color, a dim dot leader to the aligned `]`, log right after.
      const prefixFor = (proc) => {
        const color = proc._color || ((s) => s);
        const dots = '·'.repeat(Math.max(1, fillW - proc._name.length - 1));
        return color(`[${proc._name} `) + c.dim(dots) + color(']') + ' ';
      };
      // A history row is visible when its service is shown AND (no search, or the LOG TEXT
      // matches — search is content-only; service names are filtered via `f`, not `/`).
      const matches = (proc, text) =>
        shown.has(proc._name) && (!query || text.replace(ESC, '').toLowerCase().includes(query.toLowerCase()));

      const rows = () => process.stdout.rows || 24;
      const cols = () => process.stdout.columns || 80;
      const ESC = /\x1b\[[0-9;]*m/g;
      // ANSI-aware line wrap: split into rows of <= w VISIBLE columns, carrying SGR codes verbatim
      // (so colors survive) and never counting them toward width.
      const splitRows = (s, w) => {
        const out = [];
        let cur = '';
        let vis = 0;
        let i = 0;
        while (i < s.length) {
          if (s[i] === '\x1b') {
            const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
            if (m) {
              cur += m[0];
              i += m[0].length;
              continue;
            }
          }
          cur += s[i++];
          if (++vis === w) {
            out.push(cur);
            cur = '';
            vis = 0;
          }
        }
        if (cur !== '' || out.length === 0) out.push(cur);
        return out;
      };
      const cutRow = (s, w) => {
        let out = '';
        let vis = 0;
        let i = 0;
        while (i < s.length && vis < w) {
          if (s[i] === '\x1b') {
            const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
            if (m) {
              out += m[0];
              i += m[0].length;
              continue;
            }
          }
          out += s[i++];
          vis++;
        }
        return out;
      };
      // Flatten the filtered history into screen rows (each <= terminal width).
      const screenRows = () => {
        const w = cols();
        const out = [];
        for (const h of history) {
          if (h.notice) { if (query && !h.text.replace(ESC, '').toLowerCase().includes(query.toLowerCase())) continue; } // notice rows ignore the service (`f`) filter, honor search
          else if (!matches(h.proc, h.text)) continue;
          const line = (h.notice ? '' : prefixFor(h.proc)) + h.text;
          if (wrap) for (const rr of splitRows(line, w)) out.push(rr);
          else out.push(cutRow(line, w));
        }
        return out;
      };
      const footerText = () => {
        if (copyMsg) return copyMsg;
        if (searching) return c.dim('search: ') + query + c.cyan('▌') + c.dim('   (Enter apply · Esc clear)');
        if (allStopped) return c.red('■ stopped') + c.dim(' — scroll to review · [/] search · [esc] exit');
        const pos = scroll > 0 ? c.yellow(`  ↑${scroll}`) : '';
        // Count goes RED when anything is hidden, so a suppressed service/guard is always obvious.
        const nShown = `${shown.size}/${names.length}`;
        const count = shown.size < names.length ? c.red(nShown) : c.dim(nShown);
        const q = query ? c.cyan(`  /${query}`) : '';
        return c.dim('crew: [f] filter (') + count + c.dim(`)  [/] search  [w] ${wrap ? 'cut' : 'wrap'}  [c] copy  [esc] stop`) + q + pos;
      };
      // Full repaint: body rows painted by absolute position (so scroll is exact), footer on the
      // last row. One batched write to minimize flicker; cursor hidden.
      const paint = () => {
        const r = rows();
        const H = Math.max(1, r - 1);
        const all = screenRows();
        const maxScroll = Math.max(0, all.length - H);
        if (scroll > maxScroll) scroll = maxScroll;
        const endExcl = all.length - scroll;
        const start = Math.max(0, endExcl - H);
        const win = all.slice(start, endExcl);
        let buf = '\x1b[?25l';
        for (let i = 0; i < H; i++) buf += `\x1b[${i + 1};1H\x1b[2K` + (i < win.length ? win[i] : '');
        buf += `\x1b[${r};1H\x1b[2K` + footerText();
        rawWrite(buf);
        dirty = false;
      };
      viewerRepaint = paint; // let finish() refresh the footer when all processes exit

      // Run guards live as rows (⏳ → ✓/✗) inside the already-open viewer; resolve pass/fail.
      viewerRunGuards = async () => {
        const rows = guards.map((g) => {
          const row = { proc: guardProcs.get(g.name), text: c.dim(`⏳ ${g.comment || 'checking…'}`) };
          history.push(row);
          return { g, row };
        });
        paint();
        const results = await Promise.all(
          guards.map(
            (g) =>
              new Promise((res) => {
                const ch = spawn('/bin/sh', ['-c', g.command], { stdio: 'ignore' });
                ch.on('error', () => res(false));
                ch.on('close', (code) => res(code === 0));
              })
          )
        );
        let allOk = true;
        rows.forEach(({ g, row }, i) => {
          if (results[i]) row.text = `${c.green('✓')} ${g.comment || 'passed'}`;
          else {
            allOk = false;
            row.text = c.red(`✗ ${g.message || 'guard failed'}`);
          }
        });
        paint();
        return allOk;
      };
      const scrollBy = (d) => {
        const H = Math.max(1, rows() - 1);
        const maxScroll = Math.max(0, screenRows().length - H);
        scroll = Math.min(maxScroll, Math.max(0, scroll + d));
        paint();
      };

      viewer = {
        feed(proc, text) {
          const parts = ((pending.get(proc) || '') + text).split('\n');
          let rem = parts.pop(); // trailing element is the incomplete remainder
          // Bound `pending`: an unterminated line longer than the cap is flushed now (as a
          // complete line) so a newline-less stream can't accumulate megabytes in memory.
          if (rem.length > MAX_LINE) {
            parts.push(rem);
            rem = '';
          }
          pending.set(proc, rem);
          let added = 0;
          for (const raw of parts) {
            // Clip overlong lines so splitRows/screenRows stay cheap (see MAX_LINE).
            const line = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) + c.dim(` …[+${raw.length - MAX_LINE} chars]`) : raw;
            history.push({ proc, text: line });
            if (history.length > LOG_HISTORY) history.shift();
            if (matches(proc, line)) added += wrap ? splitRows(prefixFor(proc) + line, cols()).length : 1;
          }
          if (!active || !added) return;
          if (scroll > 0) scroll += added; // hold position when scrolled up into history
          dirty = true; // throttled repaint follows the tail
        },
      };
      const tick = setInterval(() => {
        if (dirty && active && !menuOpen) paint();
      }, 60);
      if (tick.unref) tick.unref();

      let onData;
      const openFilter = async () => {
        if (menuOpen) return;
        menuOpen = true;
        active = false; // capture to history only; let the picker own the screen
        stdin.removeListener('data', onData);
        rawWrite('\x1b[?1000l\x1b[?1006l'); // disable mouse for the menu
        rawWrite('\x1b[2J\x1b[H\x1b[?25h'); // clear + show cursor for the menu
        let sel = null;
        try {
          sel = await menu({
            title: 'Show logs for (Space toggles, Enter applies)',
            items: names,
            label: (o, cur) => (cur ? c.bold(o) : o),
            multi: true,
            preselected: [...shown],
          });
        } catch {
          sel = null;
        }
        if (Array.isArray(sel)) {
          shown.clear();
          for (const n of sel) shown.add(n);
          saveHidden(names.filter((n) => !shown.has(n))); // remember the hidden set globally
        }
        // menu() pauses stdin + may drop raw mode on close — re-assert or the keys go dead.
        if (stdin.setRawMode) stdin.setRawMode(true);
        stdin.resume();
        rawWrite('\x1b[?1000h\x1b[?1006h'); // re-enable mouse
        scroll = 0;
        active = true;
        menuOpen = false;
        stdin.on('data', onData);
        paint();
      };
      onData = (b) => {
        if (menuOpen) return;
        const s = b.toString('utf8');
        // Search-input mode: type a substring; Enter applies, Esc clears. Ctrl-C still stops.
        if (searching) {
          if (s === '\x03') return requestStop();
          if (s === '\r' || s === '\n') {
            searching = false;
            scroll = 0;
            return paint();
          }
          if (s === '\x1b') {
            searching = false;
            query = '';
            scroll = 0;
            return paint();
          }
          if (s === '\x7f' || s === '\b') {
            query = query.slice(0, -1);
            return paint();
          }
          if (s.length === 1 && s >= ' ') {
            query += s;
            scroll = 0;
            return paint();
          }
          return; // ignore escape sequences (arrows, etc.) while typing
        }
        // Mouse wheel (SGR: ESC [ < btn ; x ; y M|m): 64 = wheel up, 65 = wheel down.
        let mouse = false;
        for (const m of s.matchAll(/\x1b\[<(\d+);\d+;\d+[Mm]/g)) {
          const btn = Number(m[1]);
          if (btn === 64) (scrollBy(3), (mouse = true));
          else if (btn === 65) (scrollBy(-3), (mouse = true));
        }
        if (mouse) return;
        // Quit on Ctrl-C or a bare ESC. (Arrow/PgUp keys are longer sequences like `\x1b[A`,
        // so `s === '\x1b'` matches only a lone Escape.) In search mode ESC clears instead (above).
        if (s === '\x03' || s === '\x1b') return requestStop();
        if (s === '/') {
          searching = true;
          return paint();
        }
        if (s === 'f') return void openFilter();
        if (s === 'w') {
          wrap = !wrap;
          scroll = 0;
          saveWrap(wrap); // remember wrap/cut across runs
          return paint();
        }
        if (s === 'c') {
          // Copy the FILTERED view (current service + keyword filters) as full lines — ANSI
          // stripped, `[name]` prefixed, ignoring the wrap/cut display transform. Not the whole
          // history; not the on-screen window — exactly what the filters select.
          const lines = history.filter((h) => !h.notice && matches(h.proc, h.text)).map((h) => `[${h.proc._name}] ${h.text.replace(ESC, '')}`); // notice rows are crew meta, not log output
          const tool = lines.length ? clipboardCopy(lines.join('\n') + '\n') : 'empty';
          copyMsg = !lines.length
            ? c.dim('nothing to copy (filtered view is empty)')
            : tool
              ? c.green('✓ ') + c.dim(`copied ${lines.length} line${lines.length === 1 ? '' : 's'} to clipboard`)
              : c.yellow('⚠ ') + c.dim('no clipboard tool found (pbcopy/wl-copy/xclip/xsel)');
          paint();
          if (copyTimer) clearTimeout(copyTimer);
          copyTimer = setTimeout(() => {
            copyMsg = '';
            if (viewer) paint();
          }, 1600);
          return;
        }
        if (s === '\x1b[A' || s === 'k') return scrollBy(1); // up = older
        if (s === '\x1b[B' || s === 'j') return scrollBy(-1); // down = newer
        if (s === '\x1b[5~') return scrollBy(rows() - 1); // PgUp
        if (s === '\x1b[6~') return scrollBy(-(rows() - 1)); // PgDn
        if (s === 'g') {
          scroll = Number.MAX_SAFE_INTEGER;
          return scrollBy(0); // jump to oldest (clamped)
        }
        if (s === 'G') {
          scroll = 0;
          return paint(); // jump to live tail
        }
      };
      const onResize = () => {
        if (!menuOpen) paint();
      };
      stdin.on('data', onData);
      process.stdout.on('resize', onResize);
      detachKeys = () => {
        clearInterval(tick);
        if (copyTimer) clearTimeout(copyTimer);
        viewer = null; // stop capturing
        stdin.removeListener('data', onData);
        process.stdout.removeListener('resize', onResize);
        rawWrite('\x1b[?1000l\x1b[?1006l\x1b[?25h'); // disable mouse, show cursor
        rawWrite('\x1b[?1049l'); // leave the alternate screen -> restore the terminal as it was
        if (stdin.setRawMode) stdin.setRawMode(wasRaw);
        stdin.pause();
        // No history dump: leaving the alternate screen restores the terminal to before the run
        // (the `crew start …` command + prompt), rather than flooding it with the log tail.
      };
      rawWrite('\x1b[?1049h\x1b[?1000h\x1b[?1006h'); // enter the alternate screen + enable mouse
      paint();
    }

    // Guard phase then spawn. Interactive: the viewer is already up; run guards as live rows and
    // only spawn once they pass (holding the viewer open on failure). Non-interactive / no guards:
    // spawn straight away (non-interactive guards already ran + gated in cmdStart).
    if (viewerRunGuards && guards.length) {
      viewerRunGuards().then((ok) => {
        if (settled || stopRequested) return; // user quit during the guard phase
        if (ok) startSpawn();
        else {
          allStopped = true; // guards failed: hold the viewer so the ✗ + message stay on screen
          viewerRepaint();
        }
      });
    } else {
      startSpawn();
    }
  });
}

// ---------------------------------------------------------------------------
// Guards — named shell probes a service can require (VPN up, AWS logged in, …). crew is
// agnostic: a guard passes iff its command exits 0. Deduped by name across the target, so
// a guard shared by several services runs once. Any failure prints its message and aborts
// before anything starts.
// ---------------------------------------------------------------------------
// The target's guard specs, deduped by name (a guard shared by several services runs once).
// Errors if any referenced guard is undefined. [{ name, command, comment, message }].
export function collectGuards(cfg, members) {
  const registry = cfg.guards || {};
  const names = [];
  const seen = new Set();
  for (const m of members)
    for (const gn of m.service.guards || [])
      if (!seen.has(gn)) {
        seen.add(gn);
        names.push(gn);
      }
  const undef = names.filter((n) => !registry[n] || !registry[n].command);
  if (undef.length) fail(`undefined guard(s): ${undef.join(', ')}. Define them with: crew guards add`);
  return names.map((n) => ({
    name: n,
    command: registry[n].command,
    comment: registry[n].comment || '',
    message: registry[n].message || 'guard failed',
  }));
}

// Non-interactive path: run the guards now, print the ✓/✗ block, abort on any failure. (The
// interactive path instead runs them as live rows inside the log viewer — see runFanout.)
export async function runGuards(cfg, members) {
  const specs = collectGuards(cfg, members);
  if (!specs.length) return;
  const results = await Promise.all(
    specs.map(
      (g) =>
        new Promise((res) => {
          const ch = spawn('/bin/sh', ['-c', g.command], { stdio: 'ignore' });
          ch.on('error', () => res(false));
          ch.on('close', (code) => res(code === 0));
        })
    )
  );
  console.log(c.dim('guards:'));
  let failed = 0;
  specs.forEach((g, i) => {
    const note = g.comment ? '  ' + faint(g.comment) : '';
    if (results[i]) console.log(`  ${c.green('✓')} ${g.name}${note}`);
    else {
      failed++;
      console.log(`  ${c.red('✗')} ${g.name}${note}`);
      console.log(`      ${c.red(g.message)}`);
    }
  });
  if (failed) fail(`${failed > 1 ? 'guards' : 'guard'} failed — nothing started.`);
}

// Local service wiring: for each runnable whose command uses {envfile}, load its base env
// (service.env), rewrite any URL pointing at a CO-RUNNING peer to that peer's `local`
// origin, and materialize a FRESH temp file per run (stateless — regenerated every start,
// deleted on teardown). {envfile} in the command is replaced with the temp path. Peers not
// in the running set (or without a `local`) stay remote.
export function wireRun(userPath, runnable, members, { overrides = {}, overridesOff = {} }) {
  const peers = members
    .filter((m) => m.service.local)
    .map((m) => ({ name: m.name, tokens: serviceIdentity(m.service).tokens, origin: originOf(m.service.local) || m.service.local, local: m.service.local }));
  const tmpDir = join(crewHomeFor(userPath), 'tmp');
  const tempPaths = [];
  const warnings = []; // override warnings, collected (not printed) so the caller can route them into the viewer
  // Trigger set for `whenLocal` overrides: every service being started (self included).
  const running = runnable.map((r) => r.name);
  for (const r of runnable) {
    if (!r.resolved.includes('{envfile}')) continue;
    if (!r.envFile) fail(`service '${r.name}' uses {envfile} but has no "env" field in config`);
    const basePath = resolve(serviceDir(r.service), r.envFile);
    if (!pathExists(basePath)) fail(`service '${r.name}': env file not found: ${basePath}`);
    const myPeers = peers.filter((p) => p.name !== r.name);
    const overrideVars = overrideVarsFor(overrides, r.name, running, overridesOff[r.name]);
    let baseText = '';
    try {
      baseText = readFileSync(basePath, 'utf8');
    } catch (e) {
      fail(`service '${r.name}': cannot read env file ${basePath}: ${e.message}`);
    }
    // Normalize CRLF/CR -> LF: some env files ship with Windows line endings, and `. {envfile}`
    // would otherwise choke on `^M` and leave a trailing \r on every value.
    baseText = baseText.replace(/\r\n?/g, '\n');
    mkdirSync(tmpDir, { recursive: true });
    const out = join(tmpDir, `${sanitize(r.name)}.env`);
    const ov = applyEnvOverrides(wireText(baseText, myPeers), overrideVars);
    for (const w of ov.warnings) warnings.push(`${r.name}: ${w}`);
    writeFileSync(out, ov.text);
    tempPaths.push(out);
    r.resolved = r.resolved.replace(/\{envfile\}/g, shellQuote(out));
  }
  return { cleanup: () => tempPaths.forEach((p) => { try { unlinkSync(p); } catch {} }), warnings };
}

// ==================== selection ====================
// ---------------------------------------------------------------------------
// Selection — a set of services chosen per-run, picked interactively (preselected with the
// last selection). No groups; the remembered selection replaces them.
// ---------------------------------------------------------------------------
// Pick services on the dependency graph itself and return the chosen members, or null if
// cancelled / nothing chosen. Selection is ALWAYS interactive — services are never named on the
// CLI. Persists the chosen set globally. The graph selector is the one true picker (the old
// `--list` flat multiselect was retired).
export async function selectMembers(flags, cfg, opts = {}) {
  const known = Object.keys(cfg.services || {});
  if (!known.length) fail('no services configured yet — run: crew config');
  if (!canInteractive()) fail('crew needs an interactive terminal to pick services');
  const res = await graphSelect(flags, cfg, { selEnv: opts.selEnv, debugToggle: opts.debugToggle });
  if (!res || !res.picked || !res.picked.length) { console.log(c.dim('nothing selected')); return null; }
  saveLastSelection(flags, res.picked);
  if (opts.debugToggle) saveLastDebug(flags, res.debug || []); // don't clobber the remembered debug set from workspace/claude runs
  return membersFor(cfg, res.picked, res.debug || []);
}

// ==================== commands ====================
// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
// `crew start` — crew's one core run command. Picks a co-running set (multiselect graph selector), wires
// their env, gates on guards, then STREAMS them (kill-others on first exit / Ctrl-C, interactive log viewer
// on a TTY). Per-node `d` debug toggle swaps a member to its `tasks.debug`. There is no run-to-completion
// mode and no other core task — optional tasks in a service's `tasks` map have no core command yet.
export async function cmdStart(flags, rest) {
  let { cfg, userPath } = loadMerged(flags);
  warnMissing(cfg);                 // heads-up about broken paths...
  cfg = presentCfg(cfg);            // ...then run on only the services whose folder exists
  if (!Object.keys(cfg.services).length) { emptyServicesState('Nothing to start — no service folders found.'); process.exit(1); }
  const args = rest.filter((a) => a.includes('='));
  const bare = rest.filter((a) => !a.includes('='));
  if (bare.length) warn(`ignoring '${bare.join(' ')}' — services are chosen in the picker`);
  const envArg = args.find((a) => a.startsWith('env='));
  // start must know the base env unselected services point at (drives the {env} chain + wiring);
  // require it up front and fail fast, rather than prompting after the picker.
  if (!envArg) fail('crew start needs an environment (what unselected services point at) — e.g. crew start env=pre');
  const members = await selectMembers(flags, cfg, { selEnv: envArg.slice(4), debugToggle: true });
  if (!members) return;
  validateMemberPaths(members);

  const { runnable, skipped, warnings } = resolveRun(cfg, 'start', members, args);

  // Materialize wired env files (fills {envfile}); fresh per run, cleaned up after.
  // Env overrides live in the config (committable — no secrets); applied to each service's wired env.
  const overrides = mergeOverrides(cfg.overrides, loadMachine(flags).overrides); // shared (config) + per-user/secret (local.json), local wins
  const overridesOff = loadOverridesOff(flags); // per-run disabled overrides (the `e` toggle)
  const { cleanup, warnings: wireWarnings } = wireRun(userPath, runnable, members, { overrides, overridesOff });

  const cmds = runnable.map((r) => `cd ${shellQuote(serviceDir(r.service))} && ${r.resolved}`);

  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  // Skips + warnings (from resolveRun AND wireRun's env overrides). When the interactive viewer owns
  // an alternate screen, printing these to the MAIN screen would leave them as scrollback residue
  // once the viewer exits (the "spirit" of the run). So in interactive mode feed them INTO the viewer
  // as notice rows; otherwise (piped — no alt screen) print inline as before.
  const allWarnings = [...(warnings || []), ...(wireWarnings || [])];
  const notices = [...skipped.map((s) => `skipping ${s} (no task 'start')`), ...allWarnings];
  if (!interactive) { for (const s of skipped) console.log(`skipping ${s} (no task 'start')`); for (const wn of allWarnings) warn(wn); }
  // Guards gate the run. Interactive: pass the specs to runFanout, which runs them as live rows
  // inside the viewer (so the screen appears immediately) and gates the spawn. Non-interactive:
  // run them here (prints the ✓/✗ block, aborts on failure) before anything starts.
  let guardSpecs = [];
  if (interactive) guardSpecs = collectGuards(cfg, runnable);
  else await runGuards(cfg, runnable);

  const paint = serviceColors(cfg); // same per-service colors as `crew list`
  const commands = runnable.map((r, i) => ({
    command: cmds[i],
    name: r.name,
    color: paint.get(r.name) || ((s) => s),
  }));

  // STREAM: the first exit (any) tears the whole group down; Ctrl-C too. On a TTY, enable the interactive
  // scrollable log viewer (no-op when piped/CI). Guards are seeded as [name] rows; the hidden-log filter is
  // remembered globally in local.json.
  const results = await runFanout(commands, {
    killOthers: true,
    announceExits: true,
    interactive,
    notices,
    guards: guardSpecs,
    hidden: loadHiddenLog(flags),
    saveHidden: (h) => saveHiddenLog(flags, h),
    logWrap: loadLogWrap(flags),
    saveWrap: (w) => saveLogWrap(flags, w),
  });
  cleanup(); // remove the wired temp env files
  process.exit(exitCodeFromEvents(results));
}

// A stable id for a selection: sorted member names joined — same set => same id regardless
// of pick order, so workspace files / claude sessions stay tied to the set, not the order.
function selectionLabel(members) {
  return sanitize(members.map((m) => m.name).sort().join('+')) || 'selection';
}

export async function cmdWorkspace(flags, rest) {
  let { cfg, userPath } = loadMerged(flags);
  warnMissing(cfg); cfg = presentCfg(cfg);
  if (!Object.keys(cfg.services).length) { emptyServicesState('Nothing to open — no service folders found.'); process.exit(1); }
  if (rest.length) warn(`ignoring '${rest.join(' ')}' — services are chosen in the picker`);
  const members = await selectMembers(flags, cfg);
  if (!members) return;
  validateMemberPaths(members);
  const dirs = dirList(members);

  const wsDir = join(crewHomeFor(userPath), 'workspaces');
  const wsFile = join(wsDir, `${selectionLabel(members)}.code-workspace`);
  // Workspace-level VSCode settings from config (e.g. quiet the Jest extension's per-folder
  // auto-run: { "jest.enable": false } or { "jest.runMode": "on-demand" }). crew injects
  // nothing by default — fully agnostic.
  const settings = cfg.workspaceSettings && typeof cfg.workspaceSettings === 'object' ? cfg.workspaceSettings : {};
  const wsJson = { folders: dirs.map((p) => ({ path: p })), settings };

  mkdirSync(wsDir, { recursive: true });
  writeFileSync(wsFile, JSON.stringify(wsJson, null, 2) + '\n');
  launch('code', [wsFile]);
}

export async function cmdClaude(flags, rest) {
  let { cfg, userPath } = loadMerged(flags);
  warnMissing(cfg); cfg = presentCfg(cfg);
  if (!Object.keys(cfg.services).length) { emptyServicesState('Nothing to open — no service folders found.'); process.exit(1); }
  // Optional first bare arg = a session name for the chat history (always kept under crew's
  // sessions dir). Omitted => a stable name auto-derived from the selected services.
  const session = rest.filter((a) => !a.includes('='))[0];
  const members = await selectMembers(flags, cfg);
  if (!members) return;
  validateMemberPaths(members);
  const dirs = dirList(members);

  // Claude Code keys its history off the cwd path (~/.claude/services/<cwd-slug>/), so a
  // fixed, crew-owned cwd keeps history tied to the session name — not any single service's
  // dir. All services stay reachable via the --add-dir list below.
  const cwd = join(crewHomeFor(userPath), 'sessions', session ? sanitize(session) : selectionLabel(members));
  mkdirSync(cwd, { recursive: true });

  const cliArgs = [];
  for (const d of dirs) cliArgs.push('--add-dir', d);
  launch('claude', cliArgs, { cwd });
}

export function cmdList(flags) {
  const { cfg, localPath } = loadMerged(flags);
  const services = Object.entries(cfg.services || {});
  const paint = serviceColors(cfg);
  if (services.length === 0) {
    console.log(c.dim('No services configured yet.'));
    console.log(`Run ${c.cyan('crew config')} to add one.`);
    return;
  }
  warnMissing(cfg);   // list shows ALL services (red/green dot below), plus a direction-aware banner

  // --- Services -------------------------------------------------------------
  console.log(c.bold(c.underline('Services')));
  if (services.length === 0) console.log(c.dim('  (none)'));
  for (const [name, p] of services) {
    // Tolerant of an unset services dir: show the raw relative path instead of crashing.
    let abs = null;
    try {
      abs = resolveServicePath(p.path);
    } catch {
      abs = null;
    }
    const ok = abs ? pathExists(abs) : false;
    const dot = ok ? c.green('●') : c.red('●');
    const type = p.type || 'other';
    const shown = abs ? tildify(abs) : `${p.path}  ${c.dim('(set services dir: crew config)')}`;
    const pathCell = ok ? shown : c.red(shown + (abs ? '  ✗ missing' : ''));
    console.log(`  ${dot} ${c.bold(paint.get(name)(name))}`); // header: status + name only

    // Every field is a labeled row, columns aligned per service (type/path like runner/branch/…).
    const taskEntries = Object.entries(p.tasks || {});
    const labels = ['type', 'path', ...(p.runner ? ['runner'] : []), ...taskEntries.map(([t]) => t), ...(p.guards && p.guards.length ? ['guards'] : []), ...(p.defaultBranch ? ['branch'] : [])];
    const labelW = Math.max(6, ...labels.map((s) => s.length));
    const lab = (s) => c.dim(s.padEnd(labelW + 2));
    console.log(`      ${lab('type')}${type}`);
    console.log(`      ${lab('path')}${pathCell}`);
    if (p.runner) console.log(`      ${lab('runner')}${p.runner}`);
    for (const [t, cmd] of taskEntries) {
      const kind = STREAMED_TASKS.has(t) ? c.yellow('service') : c.green('task');
      console.log(`      ${lab(t)}${cmd}  ${c.dim('[')}${kind}${c.dim(']')}`);
    }
    if (!p.runner && taskEntries.length === 0) console.log(`      ${c.dim('(run-less)')}`);
    if (p.guards && p.guards.length) console.log(`      ${lab('guards')}${p.guards.join(', ')}`);
    if (p.defaultBranch) console.log(`      ${lab('branch')}${p.defaultBranch}`);
  }

  // --- Footer ---------------------------------------------------------------
  const last = loadLastSelection(flags).filter((n) => cfg.services[n]);
  if (last.length)
    console.log('\n' + c.dim('last selection  ') + last.map((n) => paint.get(n)(n)).join(c.dim(', ')));
  console.log(
    (last.length ? '' : '\n') +
      c.dim('config        ') +
      c.dim(tildify(userConfigPath(flags))) +
      (localPath ? c.dim(`  (+ ${tildify(localPath)})`) : '')
  );
  const machinePath = machineConfigPath(flags);
  console.log(c.dim('local         ') + c.dim(tildify(machinePath)) + (pathExists(machinePath) ? '' : c.dim('  (none yet)')));
}

// crew graph [list] — read-only dependency graph derived from env files (no wiring). Default draws
// the ASCII diagram (bin/graph.js); `crew graph list` prints the plain adjacency text below.
// Each service's id comes ONLY from config `match` (complete hostnames, exact string match);
// crew resolve <env> [service...] — read-only: show the env each service would run at for a
// selection (from the chain), without starting anything. No services given -> the remembered
// selection (else all). The dry-run that validates derivation before you `crew start`.
export function cmdResolve(flags, rest) {
  let { cfg } = loadMerged(flags);
  warnMissing(cfg); cfg = presentCfg(cfg);             // resolve reads env files — skip services whose folder is absent
  const selEnv = (rest || []).find((a) => !a.includes('='));
  if (!selEnv) fail('resolve: usage: crew resolve <env> [service...]');
  const explicit = (rest || []).filter((a) => a !== selEnv && !a.includes('='));
  const machine = loadMachine(flags);
  let names = explicit.length
    ? explicit
    : (Array.isArray(machine.lastSelection) && machine.lastSelection.length ? machine.lastSelection : Object.keys(cfg.services || {}));
  names = names.filter((n) => cfg.services && cfg.services[n]);
  if (!names.length) return void emptyServicesState('Nothing to resolve.');

  const { resolved, warnings } = resolveEnvs(cfg, names, selEnv);
  const paint = serviceColors(cfg);
  const w = Math.max(...names.map((n) => n.length));
  console.log(c.bold('Resolved envs') + c.dim(`  — selection env = ${selEnv}  (${names.length} service${names.length > 1 ? 's' : ''})`));
  console.log(c.dim('  entry runs at the selection env; deps inherit the env their consumer points at.'));
  for (const n of names) {
    const e = resolved.get(n) || selEnv;
    const tag = e === selEnv ? c.dim(e) : c.cyan(e);
    const label = paint.get(n) ? paint.get(n)(n) : n;
    console.log(`  ${label}${' '.repeat(Math.max(2, w - n.length + 2))}${tag}`);
  }
  if (warnings.length) {
    console.log('\n' + c.yellow('⚠ notes:'));
    for (const wn of warnings) console.log('  ' + c.dim(wn));
  }
}

// Crew-service edges derived from .envs URLs: `real` = dependency edges, `ref` = reference
// edges (non-frontend -> frontend link-backs). Feeds the ascii renderer (`crew graph`).
export function collectGraphEdges(cfg) {
  const entries = Object.entries(cfg.services || {});
  const meta = {};
  for (const [name, service] of entries) {
    meta[name] = { files: serviceEnvFiles(service), ...serviceIdentity(service) };
  }
  const real = [], ref = [];
  for (const [name] of entries) {
    const seen = new Map();
    for (const f of meta[name].files) {
      let text = '';
      try { text = readFileSync(f.path, 'utf8'); } catch { /* skip */ }
      for (const u of text.match(URL_RE) || []) {
        const p = urlHostPath(u);
        if (p) seen.set(p.host + '\n' + p.path, p);
      }
    }
    const targets = new Set();
    for (const { host, path } of seen.values()) {
      let best = null, bestLen = 0;
      for (const [t] of entries)
        for (const tok of meta[t].tokens) {
          const len = tokenMatchLen(host, path, tok);
          if (len > bestLen) { bestLen = len; best = t; }
        }
      if (best && best !== name) targets.add(best);
    }
    for (const t of targets) (isReferenceEdge(cfg, name, t) ? ref : real).push([name, t]);
  }
  return { nodes: entries.map(([n]) => n), real, ref };
}

// edge P→T when a URL in P's envs has a host equal to one of T's match hosts (tokenMatchLen).
// localhost URLs match no id, so they drop out.
// Interactive graph picker for `crew start` (and workspace / claude): navigate the dependency graph and
// toggle which services run. ↑↓ = layer, ←→ = neighbour in the layer, space = toggle, a = all/none,
// enter = confirm, esc = cancel. Selected nodes render in their own colour and read `[local]`; the rest
// are grayed and read `[<base env>]` (where they stay remote). Returns the picked names, null if cancelled,
// or undefined if it can't run (non-TTY) so the caller falls back to the flat menu().
async function graphSelect(flags, cfg, opts = {}) {
  const stdout = process.stdout, stdin = process.stdin;
  const names = Object.keys(cfg.services || {});
  if (!stdout.isTTY || !stdin.isTTY || !names.length) return undefined; // undefined = can't run here -> caller falls back to flat menu
  const { nodes, real, ref } = collectGraphEdges(cfg);
  if (!nodes.length) return undefined;
  const edges = [...real.map(([f, t]) => ({ from: f, to: t })), ...ref.map(([f, t]) => ({ from: f, to: t, ref: true }))];
  let showRef = loadGraphRefs(flags);                 // persisted, shared with `crew graph`
  const hasRef = ref.length > 0;
  const paint = serviceColors(cfg);
  const prefix = (n) => { const f = paint.get(n); if (!f) return ''; const s = f('\x01'); const i = s.indexOf('\x01'); return i > 0 ? s.slice(0, i) : ''; };
  const GRAY = DIM, selEnv = opts.selEnv;
  const depEdges = dependencyEdges(cfg, Object.entries(cfg.services));
  let active = new Set(loadLastSelection(flags).filter((n) => nodes.includes(n)));
  if (!active.size) active = new Set(nodes);        // default: everything selected
  let shown = new Set((loadGraphShown(flags) || nodes).filter((n) => nodes.includes(n))); // visible set (f-filter), persisted + shared with `crew graph`
  if (!shown.size) shown = new Set(nodes);
  for (const n of [...active]) if (!shown.has(n)) active.delete(n); // a hidden node can't be run
  const debugToggle = !!opts.debugToggle; // per-node debug is a `start` concept only (workspace/claude share this picker)
  const canDebug = (n) => { const t = cfg.services[n] && cfg.services[n].tasks; return debugToggle && !!(t && t.debug != null); }; // running node has a `tasks.debug`
  // debug ⊂ active: which local services launch `tasks.debug`. Only eligible + running nodes qualify.
  let debug = new Set(debugToggle ? loadLastDebug(flags).filter((n) => active.has(n) && canDebug(n)) : []);
  // `e` overrides toggle (start only, same gate as debug): merged config+local overrides per service; `e`
  // overlays a checklist to enable/disable each for THIS run. Disabled set persisted machine-local.
  const cfgOv = debugToggle ? (cfg.overrides || {}) : {};                 // global (shared, committable)
  const localOv = debugToggle ? (loadMachine(flags).overrides || {}) : {}; // local (machine-only, wins)
  const mergedOv = debugToggle ? mergeOverrides(cfgOv, localOv) : {};
  const ovEntriesFor = (n) => overrideEntries(mergedOv[n]);
  const canEnv = (n) => debugToggle && active.has(n) && ovEntriesFor(n).length > 0;
  const off = loadOverridesOff(flags);            // { service: [disabled key…] }, mutated + persisted on apply
  let ePanel = null, eNode = null, eLabelKey = null; // overrides checklist (built per node when `e` is pressed)
  let cursor = [...nodes].find((n) => shown.has(n)) || nodes[0];
  const panel = makeFilterPanel(nodes, { paint, title: 'Show nodes' }); // `f` overlays this on the graph's right
  const remoteEnv = selEnv != null ? resolveEnvs(cfg, nodes, selEnv).resolved : new Map(); // where each service is deployed (crew resolve) — shown for the ones NOT run locally
  // Keep box widths STABLE across select/deselect. 'local' and a node's remote env differ in length, and
  // toggling one would change that box's width and reflow the whole (now order-sensitive) layout — nodes
  // would jump. sublabelWidth = the widest env label; the renderer pads every [env] field to it (spaces
  // OUTSIDE the tight brackets), so CW is identical for any active set -> geometry never moves on toggle.
  const envW = selEnv == null ? 0 : Math.max('local'.length, 'debug'.length, (selEnv || '').length, ...[...remoteEnv.values()].map((v) => (v || '').length));
  const draw = () => renderAsciiGraph(nodes.filter((n) => shown.has(n)), edges.filter((e) => shown.has(e.from) && shown.has(e.to) && (showRef || !e.ref)), {
    colorOf: (n) => (active.has(n) ? prefix(n) : GRAY),                                          // running set keeps per-source colours; the rest grayed
    sublabel: selEnv != null ? (n) => (active.has(n) ? (debug.has(n) ? 'debug' : 'local') : (remoteEnv.get(n) || selEnv)) : undefined, // [debug] = local under a debugger; [local] = plain local; else the resolved remote env
    sublabelWidth: envW,                                                                        // fixed [env] field width -> box width stays put when the sublabel changes
    cursor, withLayout: true,
  });
  return new Promise((resolve) => {
    const w = (x) => stdout.write(x);
    const wasRaw = stdin.isRaw;
    let top = 0, vpad = 0, layout = draw(); // vpad = current vertical centring offset
    const body = () => Math.max(3, (stdout.rows || 24) - 1); // reserve 1 row: the footer bar
    const cleanup = () => { stdin.removeListener('data', onData); stdout.removeListener('resize', repaint); w('\x1b[?7h\x1b[?25h\x1b[?1049l'); if (stdin.setRawMode) stdin.setRawMode(wasRaw); stdin.pause(); };
    const cpw = (s) => [...s.replace(/\x1b\[[0-9;]*m/g, '')].length; // display width, ANSI-stripped
    const repaint = () => {
      const R = body(), cols = stdout.columns || 80, lines = layout.text.split('\n');
      const gw = Math.max(0, ...lines.map(cpw)), mx = ' '.repeat(Math.max(0, (cols - gw) >> 1)); // centre horizontally
      vpad = 0;
      if (lines.length <= R) { vpad = (R - lines.length) >> 1; top = 0; }                          // fits vertically -> centre it
      else { const y = layout.place.get(cursor).y0; if (y < top) top = y; else if (y + 3 > top + R) top = y + 3 - R; top = Math.max(0, Math.min(top, lines.length - R)); } // taller -> scroll cursor into view
      // A modal (node filter `f` or overrides `e`) dims the whole graph + footer and floats a CENTERED box.
      const modal = panel.active ? panel : (ePanel && ePanel.active ? ePanel : null);
      const shade = modal ? dimText : (x) => x;
      let out = '\x1b[H';
      for (let i = 0; i < R; i++) { const li = i - vpad; out += '\x1b[K' + shade(li >= 0 && top + li < lines.length ? mx + lines[top + li] : '') + '\x1b[0m\r\n'; }
      const split = cpw(connectivityStatus(cfg, depEdges, [...active], false)) > 0; // non-verbose returns islands text only when disconnected
      const bar = graphFooter({ mode: 'select', total: nodes.length, sel: active.size, vis: shown.size, hasRef, showRef, warn: split ? '⚠ not connected' : '', dbg: active.has(cursor) && canDebug(cursor), env: canEnv(cursor) });
      out += '\x1b[K' + shade(footerBar(bar, cols)); // one full-width reverse-video footer (shared with the pager + guards editor)
      if (modal) { // centered box over the dimmed backdrop (bright)
        const pr = modal.rows(R), w = modal.width, mtop = Math.max(1, ((R - pr.length) >> 1) + 1), col = Math.max(1, ((cols - w) >> 1) + 1);
        for (let i = 0; i < pr.length && mtop + i <= R; i++) out += `\x1b[${mtop + i};${col}H` + pr[i];
        out += '\x1b[0m';
      }
      w(out);
    };
    let snap = null; // pre-open state captured when `f` opens the panel, so esc can revert
    const previewShown = (list) => { // live preview while toggling: update the graph now, DON'T persist (that waits for Enter)
      shown = new Set(list);
      for (const n of [...active]) if (!shown.has(n)) { active.delete(n); debug.delete(n); } // a hidden node can't be run (or debugged)
      if (!shown.has(cursor)) cursor = nodes.find((n) => shown.has(n)) || cursor;
      layout = draw();
    };
    const restoreSnap = () => { if (!snap) return; shown = new Set(snap.shown); active = new Set(snap.active); debug = new Set(snap.debug); cursor = snap.cursor; layout = draw(); };
    const moveH = (d) => { const p = layout.place.get(cursor); if (!p) return; const list = layout.layers[p.layer], i = list.indexOf(cursor); cursor = list[Math.max(0, Math.min(list.length - 1, i + d))]; }; // no-op when the graph is empty (everything filtered out)
    const moveV = (d) => { const p0 = layout.place.get(cursor); if (!p0) return; let l = p0.layer + d; while (l >= 0 && l < layout.layers.length && !layout.layers[l].length) l += d; if (l < 0 || l >= layout.layers.length || !layout.layers[l].length) return; const cx = p0.cx; let best = layout.layers[l][0], bd = Infinity; for (const n of layout.layers[l]) { const dd = Math.abs(layout.place.get(n).cx - cx); if (dd < bd) { bd = dd; best = n; } } cursor = best; };
    // Handle ONE key. Returns true once the selector has resolved (so onData stops feeding the rest of a
    // coalesced chunk — e.g. Enter then esc arriving as one read must apply the filter AND still act).
    const handleKey = (key) => {
      // Mouse is not used in the selector — reporting is never enabled (below), so no SGR sequences arrive.
      // Node enable/disable + scrolling are keyboard-only (space / ↑↓←→).
      if (panel.active) { // filter panel owns keys while open: space previews live, Enter confirms + persists, esc/q revert
        const r = panel.key(key);
        if (r === 'change') previewShown([...panel.selected]);                           // graph updates on every toggle (no persist yet)
        else if (r === 'apply') { if (panel.selected.size) saveGraphShown(flags, [...shown]); else restoreSnap(); panel.close(); } // Enter: keep + persist (nothing left -> revert)
        else if (r === 'cancel') { restoreSnap(); panel.close(); }                       // esc: back to the pre-open graph
        repaint();
        return false;
      }
      if (ePanel && ePanel.active) { // overrides checklist owns keys: space toggles, Enter persists the disabled set, esc reverts
        const r = ePanel.key(key);
        if (r === 'apply') { const disabled = [...eLabelKey.entries()].filter(([lbl]) => !ePanel.selected.has(lbl)).map(([, k]) => k); if (disabled.length) off[eNode] = disabled; else delete off[eNode]; saveOverridesOff(flags, off); ePanel = null; }
        else if (r === 'cancel') ePanel = null;
        repaint();
        return false;
      }
      if (key === '\x03' || key === '\x1b') { cleanup(); resolve(null); return true; }
      if (key === '\r' || key === '\n') { cleanup(); resolve({ picked: [...active], debug: [...debug] }); return true; }
      if (key === 'r' && hasRef) { showRef = !showRef; saveGraphRefs(flags, showRef); layout = draw(); repaint(); return false; }
      if (key === 'f') { snap = { shown: new Set(shown), active: new Set(active), debug: new Set(debug), cursor }; panel.open([...shown]); repaint(); return false; }
      if (key === 'd') { if (active.has(cursor) && canDebug(cursor)) { debug.has(cursor) ? debug.delete(cursor) : debug.add(cursor); layout = draw(); repaint(); } return false; } // toggle debug — only for a running node that has a `tasks.debug`
      if (key === 'e') { // open the overrides checklist for the focused node — grouped GLOBAL (shared) then LOCAL (wins)
        if (!canEnv(cursor)) return false;
        const lEntries = overrideEntries(localOv[cursor]);
        const localKeys = new Set(lEntries.map((e) => e.key));
        const gEntries = overrideEntries(cfgOv[cursor]).filter((e) => !localKeys.has(e.key)); // a global shadowed by a local shows only under local (which wins)
        const items = []; eLabelKey = new Map();
        const addRow = (en) => { const lbl = `${en.var} = ${en.value}${en.peer ? `  (when ${en.peer})` : ''}`; eLabelKey.set(lbl, en.key); items.push(lbl); };
        if (gEntries.length) { items.push({ header: 'global (shared config)' }); gEntries.forEach(addRow); }
        if (lEntries.length) { items.push({ header: 'local (wins · machine-only)' }); lEntries.forEach(addRow); }
        const offSet = new Set(off[cursor] || []); eNode = cursor;
        ePanel = makeFilterPanel(items, { title: `overrides · ${cursor}` });
        ePanel.open(items.filter((x) => typeof x === 'string' && !offSet.has(eLabelKey.get(x)))); // preselect the ENABLED ones
        repaint(); return false;
      }
      if (key === ' ') { if (active.has(cursor)) { active.delete(cursor); debug.delete(cursor); } else active.add(cursor); }
      else if (key === 'a') { active = [...shown].every((n) => active.has(n)) ? new Set() : new Set(shown); for (const n of [...debug]) if (!active.has(n)) debug.delete(n); } // all/none among VISIBLE nodes; debug ⊂ active
      else if (key === '\x1b[C' || key === 'l') moveH(1);
      else if (key === '\x1b[D' || key === 'h') moveH(-1);
      else if (key === '\x1b[B' || key === 'j') moveV(1);
      else if (key === '\x1b[A' || key === 'k') moveV(-1);
      else return false;
      layout = draw(); repaint();
      return false;
    };
    const onData = (buf) => { for (const key of splitKeys(buf.toString())) if (handleKey(key)) return; };
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    w('\x1b[?1049h\x1b[?25l\x1b[?7l'); // alt screen + hide cursor + no-wrap (no mouse reporting — selector is keyboard-only)
    stdin.on('data', onData); stdout.on('resize', repaint);
    repaint();
  });
}

// Show a (possibly tall) block in an ALTERNATE-SCREEN pager — like the log viewer, so it vanishes on
// exit instead of scrolling into the terminal history. Vertical scroll only. 'r' resolves 'refs',
// esc resolves 'quit'. If `meta.filter` is given ({nodes, shown, paint, render(shownSet)->text,
// onApply(list)}), 'f' overlays a node-filter panel IN PLACE (graph stays visible) and re-renders on
// apply — otherwise 'f' resolves 'filter'. Non-TTY: plain print (so `| less`, redirects, CI work).
function pagerView(text, meta = {}) {
  const stdout = process.stdout, stdin = process.stdin;
  if (!stdout.isTTY || !stdin.isTTY) { console.log(text); return Promise.resolve('quit'); }
  return new Promise((resolve) => {
    let lines = text.split('\n');
    const w = (x) => stdout.write(x);
    const wasRaw = stdin.isRaw;
    const filter = meta.filter || null;
    const panel = filter ? makeFilterPanel(filter.nodes, { paint: filter.paint, title: 'Show nodes' }) : null;
    let shown = filter ? new Set(filter.shown) : null, shownCount = meta.shown, snap = null;
    let top = 0;
    const body = () => Math.max(1, (stdout.rows || 24) - 1);
    const maxTop = () => Math.max(0, lines.length - body());
    const cpw = (s) => [...s.replace(/\x1b\[[0-9;]*m/g, '')].length;
    const paint = () => {
      const R = body(), cols = stdout.columns || 80;
      const gw = Math.max(0, ...lines.map(cpw)), mx = ' '.repeat(Math.max(0, (cols - gw) >> 1)); // centre horizontally
      let vpad = 0;
      if (lines.length <= R) { vpad = (R - lines.length) >> 1; top = 0; } else top = Math.max(0, Math.min(maxTop(), top)); // centre vertically when it fits
      let out = '\x1b[H';
      for (let i = 0; i < R; i++) { const li = i - vpad; out += '\x1b[K' + (li >= 0 && top + li < lines.length ? mx + lines[top + li] : '') + '\x1b[0m\r\n'; }
      const scroll = lines.length > R ? `↑↓ scroll ${top + 1}-${Math.min(top + R, lines.length)}/${lines.length}` : ''; // position only when it overflows
      const bar = graphFooter({ mode: 'pager', shown: shownCount, total: meta.total, hasRef: meta.hasRef, showRef: meta.showRef, scroll });
      out += '\x1b[K' + footerBar(bar, cols); // full-width reverse-video bar (shared with the selector + guards editor)
      if (panel && panel.active) {                                                        // filter panel overlays the graph's right columns
        const pr = panel.rows(R), col = Math.max(1, cols - panel.width + 1);
        for (let i = 0; i < pr.length && i < R; i++) out += `\x1b[${i + 1};${col}H` + pr[i];
        out += '\x1b[0m';
      }
      w(out);
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdout.removeListener('resize', paint);
      w('\x1b[?7h\x1b[?25h\x1b[?1049l'); // restore wrap + cursor, leave the alternate screen
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const filterRender = (set) => { shown = new Set(set); shownCount = shown.size; lines = filter.render(shown).split('\n'); };
    // Handle ONE key; returns true once the pager has resolved, so onData stops feeding the rest of a
    // coalesced chunk (e.g. Enter then esc arriving as one read must apply the filter AND still act).
    const handleKey = (key) => {
      const R = body();
      if (panel && panel.active) { // filter panel owns keys while open: space previews live, Enter confirms, esc/q revert
        const r = panel.key(key);
        if (r === 'change') filterRender(panel.selected);                    // graph re-renders on every toggle (no persist yet)
        else if (r === 'apply') { if (shown.size) filter.onApply([...shown]); else filterRender(snap); panel.close(); } // Enter: persist (nothing left -> revert)
        else if (r === 'cancel') { filterRender(snap); panel.close(); }      // esc: back to the pre-open graph
        paint(); return false;
      }
      if (key === '\x1b' || key === '\x03') { cleanup(); resolve('quit'); return true; }
      if (key === 'f') { if (panel) { snap = new Set(shown); panel.open([...shown]); paint(); return false; } cleanup(); resolve('filter'); return true; }
      if (key === 'r') { cleanup(); resolve('refs'); return true; }
      if (key === 'j' || key === '\x1b[B') top += 1;
      else if (key === 'k' || key === '\x1b[A') top -= 1;
      else if (key === ' ' || key === '\x1b[6~') top += R;
      else if (key === 'b' || key === '\x1b[5~') top -= R;
      paint();
      return false;
    };
    const onData = (buf) => { for (const key of splitKeys(buf.toString())) if (handleKey(key)) return; };
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    w('\x1b[?1049h\x1b[?25l\x1b[?7l'); // alt screen, hide cursor, disable line-wrap
    stdin.on('data', onData);
    stdout.on('resize', paint);
    paint();
  });
}

export async function cmdGraph(flags, rest) {
  let { cfg } = loadMerged(flags);
  warnMissing(cfg); cfg = presentCfg(cfg);             // broken services are dropped from the graph (as if absent)
  if ((rest || [])[0] !== 'list') {                    // default = drawn ascii diagram; `list` = adjacency text
    const { nodes: allNodes, real, ref } = collectGraphEdges(cfg);
    if (!allNodes.length) return void emptyServicesState('Nothing to show here.');
    const allEdges = [...real.map(([f, t]) => ({ from: f, to: t })), ...ref.map(([f, t]) => ({ from: f, to: t, ref: true }))];
    const paint = serviceColors(cfg);
    const clr = (n) => { const g = paint.get(n); if (!g) return ''; const t = g('\u0001'); const m = t.indexOf('\u0001'); return m > 0 ? t.slice(0, m) : ''; };
    const draw = (shown, showRef) => renderAsciiGraph(allNodes.filter((n) => shown.has(n)), allEdges.filter((e) => shown.has(e.from) && shown.has(e.to) && (showRef || !e.ref)), { colorOf: clr });
    let showRef = loadGraphRefs(flags);                 // persisted, shared with the selector
    const savedShown = loadGraphShown(flags);           // persisted node filter (null = all)
    let shown = new Set((savedShown || allNodes).filter((n) => allNodes.includes(n)));
    if (!shown.size) shown = new Set(allNodes);
    const hasRef = ref.length > 0;                      // only offer the toggle when there ARE reference edges
    if (!process.stdout.isTTY || !process.stdin.isTTY) return void console.log(draw(shown, showRef));
    for (;;) {                                          // page the graph; 'f' overlays a node filter in place, 'r' toggles reference edges
      const reason = await pagerView(draw(shown, showRef), {
        mode: 'pager', shown: shown.size, total: allNodes.length, hasRef, showRef,
        filter: { nodes: allNodes, shown, paint, render: (s) => draw(s, showRef), onApply: (list) => { shown = new Set(list); saveGraphShown(flags, list); } },
      });
      if (reason === 'refs') { showRef = !showRef; saveGraphRefs(flags, showRef); continue; }
      break;                                            // 'quit'
    }
    return;
  }
  const paint = serviceColors(cfg);
  const services = Object.entries(cfg.services || {});
  if (!services.length) return void emptyServicesState('Nothing to show here.');

  const meta = {};
  for (const [name, service] of services) {
    meta[name] = { files: serviceEnvFiles(service), ...serviceIdentity(service) };
  }

  console.log(c.bold('Dependency graph') + c.dim('  — edges auto-discovered from .envs, no wiring'));
  console.log(
    c.dim(
      [
        'How it works:',
        '  1. Give each service an id so crew can recognize it when another service\'s URL',
        '     points at it: `match` = an env-labeled map of the complete hostname(s) it is',
        '     served under (exact strings). E.g. match: {"pro":"api.example.com",',
        '     "qa":"qa-api.example.com"}. No `match` = no id, so nothing can point at it (⚠).',
        '  2. Read every env file and pull out every http(s):// URL.',
        '  3. For each URL, compare its host to every `match` string — exact match only, so',
        '     api.example.com never collides with rge-api.example.com.',
        '  4. A URL in P whose host equals one of T\'s match hosts → edge P → T.',
        '  5. URLs matching no service are dropped as 3rd-party.',
      ].join('\n')
    )
  );
  let warned = false;
  for (const [name] of services) {
    const { files, tokens, source } = meta[name];
    const seen = new Map(); // host\npath -> { host, path } (deduped across this service's envs)
    for (const f of files) {
      let text = '';
      try {
        text = readFileSync(f.path, 'utf8');
      } catch {
        /* skip */
      }
      for (const u of text.match(URL_RE) || []) {
        const p = urlHostPath(u);
        if (p) seen.set(p.host + '\n' + p.path, p);
      }
    }
    const edges = new Set();
    const refs = new Set(); // non-frontend -> frontend: shown but marked, not a real dep edge
    for (const { host, path } of seen.values()) {
      // Pick the service whose matching token is longest (most specific), so a gateway host
      // split by path resolves to the deeper path, not a shorter prefix.
      let best = null;
      let bestLen = 0;
      for (const [t] of services) {
        for (const tok of meta[t].tokens) {
          const len = tokenMatchLen(host, path, tok);
          if (len > bestLen) {
            bestLen = len;
            best = t;
          }
        }
      }
      if (best && best !== name) { edges.add(best); if (isReferenceEdge(cfg, name, best)) refs.add(best); }
    }

    const head = c.bold(paint.get(name) ? paint.get(name)(name) : name);
    if (source === 'none') {
      warned = true;
      console.log(`\n${head}  ${c.yellow('⚠ no `match` — no id, peers can\'t link to it')}`);
    } else {
      console.log(`\n${head}  ${c.dim('[' + tokens.join(', ') + ']')}`);
    }
    if (edges.size) {
      for (const t of [...edges].sort()) {
        const arrow = refs.has(t) ? c.dim('⇢') : c.green('→');
        const tag = refs.has(t) ? c.dim(' (ref — not a dep)') : '';
        console.log(`  ${arrow} ${paint.get(t) ? paint.get(t)(t) : t}${tag}`);
      }
    } else {
      console.log(`  ${c.dim('→ (no crew-service edges)')}`);
    }
  }
  if (warned)
    console.log(
      '\n' + c.yellow('⚠ ') + c.dim('some services have no `match` — add `match: {"pro":"host.example.com"}` (env-labeled exact hosts) so peers can link to them.')
    );
}

// crew config — THE config command: opens the two-pane visual editor (Settings + Services + Guards +
// Overrides — every key). `crew config path` prints the config file path, and a non-TTY `crew config`
// degrades to printing it too, so `cat "$(crew config path)"` and pipes keep working. No hand-editing verb.
export async function cmdConfig(flags, sub) {
  if (sub === 'path') { console.log(userConfigPath(flags)); return; }
  if (sub) fail(`config: unknown subcommand '${sub}'. Use: crew config  (opens the editor)  |  crew config path`);
  if (!canInteractive()) { console.log(userConfigPath(flags)); return; } // non-interactive: just print the path
  await configForm(flags, { section: 'services' });
}

// crew pull <url> — fetch a config.json from a URL and install it as the user config
// (backing up the current one). local.json (services dir, last selection) is untouched.
export async function cmdPull(flags, url) {
  if (!url || !/^https?:\/\//i.test(url))
    fail('pull: usage: crew pull <url-to-config.json>');
  const path = userConfigPath(flags);
  let text;
  try {
    text = await fetchUrl(url);
  } catch (e) {
    fail(`pull: could not fetch config: ${e.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    fail('pull: response is not valid JSON (check the URL / token)');
  }
  if (!cfg || typeof cfg !== 'object' || typeof cfg.services !== 'object')
    fail('pull: that JSON is not a crew config (missing "services")');

  mkdirSync(dirname(path), { recursive: true });
  let backed = false;
  if (pathExists(path)) {
    writeFileSync(path + '.bak', readFileSync(path));
    backed = true;
  }
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  const n = Object.keys(cfg.services || {}).length;
  console.log(`Loaded config → ${tildify(path)} ${c.dim(`(${n} service${n === 1 ? '' : 's'})`)}`);
  if (backed) console.log(c.dim(`  previous saved as ${tildify(path + '.bak')}`));
  console.log(c.dim('  set your services dir if needed: crew config (Settings)'));
}



// Derive a service's fields from the folder on disk (best-effort) — used by the config editor when a NEW
// service's `path` points at an existing folder, to prefill the empty fields. Reads package.json / lockfiles
// / manifests / .envs / dev scripts. Returns { type, runner, env, local, start }; `match` (deployed host)
// is intentionally not derived — the guess was too weak, so the user always fills it by hand.
export function detectService(abs) {
  const rd = (rel) => { try { return readFileSync(join(abs, rel), 'utf8'); } catch { return ''; } };
  const isFile = (rel) => { try { return statSync(join(abs, rel)).isFile(); } catch { return false; } };
  const ls = (rel) => { try { return readdirSync(join(abs, rel)); } catch { return []; } };
  let pkg = null; try { pkg = JSON.parse(rd('package.json') || 'null'); } catch { /* malformed */ }
  const deps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};
  const scripts = (pkg && pkg.scripts) || {};

  const FRONT = ['react', 'vue', 'next', 'nuxt', '@angular/core', 'vite', 'svelte', 'gatsby', 'solid-js', 'preact'];
  let type = '';
  if (FRONT.some((d) => d in deps) || isFile('index.html') || isFile('public/index.html')) type = 'frontend';
  else if (pkg || ['go.mod', 'manage.py', 'pyproject.toml', 'requirements.txt', 'Gemfile', 'pom.xml', 'Cargo.toml', 'composer.json'].some(isFile)) type = 'backend';

  let runner = '';
  if (isFile('yarn.lock')) runner = 'yarn {task}';
  else if (isFile('pnpm-lock.yaml')) runner = 'pnpm {task}';
  else if (pkg) runner = 'npm run {task}';
  else if (isFile('Makefile') || isFile('makefile')) runner = 'make {task}';

  const envNames = ls('.envs').filter((f) => f !== '.gitkeep' && isFile(join('.envs', f)));
  let env = '';
  const envText = envNames.map((f) => rd(join('.envs', f))).join('\n');
  if (envNames.length) {
    const cp = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return a.slice(0, i); };
    let pre = envNames.reduce(cp);
    let suf = [...envNames.map((s) => [...s].reverse().join('')).reduce(cp)].reverse().join('');
    pre = pre.replace(/[^/._-]*$/, ''); suf = suf.replace(/^[^/._-]*/, '');
    const labels = envNames.map((s) => s.slice(pre.length, s.length - suf.length || undefined));
    env = labels.some((l) => l) ? `.envs/${pre}{env}${suf}` : `.envs/${envNames[0]}`;
  }

  let port = (envText.match(/(?:^|\n)\s*(?:export\s+)?PORT\s*=\s*(\d{2,5})/) || [])[1] || '';
  if (!port) for (const s of Object.values(scripts)) { const m = String(s).match(/(?:--port|-p)[ =](\d{2,5})/); if (m) { port = m[1]; break; } }
  if (!port) port = ((rd('vite.config.ts') || rd('vite.config.js') || rd('next.config.js')).match(/port\s*[:=]\s*(\d{2,5})/) || [])[1] || '';
  if (!port) port = ('next' in deps || 'react-scripts' in deps) ? '3000' : ('vite' in deps ? '5173' : '');
  const local = port ? `http://localhost:${port}` : '';

  let start = '';
  const cand = Object.keys(scripts).find((k) => /^(dev|start|serve)[:.]/.test(k)) || ['dev', 'start', 'serve'].find((k) => k in scripts);
  if (cand) {
    let cmd = String(scripts[cand]).replace(/(?:\.\/)?\.envs\/\S+/g, '{envfile}');
    const sufTok = /[:.]/.test(cand) ? cand.split(/[:.]/).pop() : '';
    if (sufTok) cmd = cmd.replace(new RegExp('\\b' + sufTok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), '{env}');
    start = cmd;
  }

  // NB: `match` (deployed hosts) is deliberately NOT derived — guessing it from env-file hosts vs the
  // folder name was too unreliable. It's the one field the user always fills by hand.
  return { type, runner, env, local, start };
}

// Two-pane raw-mode config editor. Left column stacks every SECTION (Services, Guards) as a name list,
// each ending in a green "+ New" row; the right column is the highlighted item's form. The three actions
// fall out of position + key: CREATE = a +New row (blank form), UPDATE = edit fields then `s` save, DELETE
// = `d` + confirm. Field kinds: text (inline editor), name (item key, rename-aware), choice (⏎ cycles a
// fixed option list), multiselect (⏎ opens a makeFilterPanel overlay), readonly (display only). Zero-dep,
// same raw-mode primitives as the graph views (splitKeys, alt screen, absolute cursor, footerBar). Each
// section owns load/save/del so adding Overrides later is just another section descriptor.
// Entry points: `crew edit` (no name) -> Services; `crew guards edit` -> Guards.
async function configForm(flags, opts = {}) {
  const stdout = process.stdout, stdin = process.stdin;
  if (!stdout.isTTY || !stdin.isTTY) fail('this editor needs an interactive terminal');
  const { cfg, path } = loadUserConfig(flags);
  cfg.services = cfg.services || {};
  cfg.guards = cfg.guards || {};
  const persist = () => writeUserConfig(path, pruneConfig(cfg)); // every editor write also strips unknown keys
  const paint = serviceColors(cfg);

  const toRows = (obj) => Object.entries(obj || {}).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, String(x)]) : [[k, String(v)]]));
  const toObj = (rows, multi) => { const o = {}; for (const [k, v] of rows) { const kk = String(k).trim(); if (!kk) continue; if (multi) o[kk] = o[kk] == null ? String(v) : [].concat(o[kk], String(v)); else o[kk] = String(v); } return o; };
  // match is an env-labeled host map with FIXED keys: env labels derived from the service's env files
  // (the `env` template), unioned with any labels already stored so existing data stays editable.
  const matchLabels = (f) => { let envs = []; try { envs = serviceEnvFiles({ path: f.path, env: f.env }).map((x) => x.env); } catch { /* path unresolved */ } return [...new Set([...envs, ...Object.keys(f.match || {})])].sort(); };
  const matchValToStr = (v) => (Array.isArray(v) ? v.join(' ') : v == null ? '' : String(v)); // one env's host(s) -> a space-separated string for the value editor
  const matchCommit = (rows) => { const o = {}; for (const [k, v] of rows) { const toks = String(v).trim().split(/\s+/).filter(Boolean); if (!toks.length) continue; o[k] = toks.length === 1 ? toks[0] : toks; } return o; }; // blank = drop; several hosts = array
  // Environment overrides ↔ editor rows. Storage (config.json `overrides`) per service: bare `VAR:val` keys +
  // a reserved `whenLocal: {peer:{VAR:val}}` map. The editor flattens BOTH into one flat list of
  // rows `{var, value, peer}` (peer='' = unconditional/bare), and rebuilds the storage shape on save.
  const overridesToRows = (o) => {
    const rows = [];
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) if (k !== OVERRIDE_WHEN_LOCAL) rows.push({ var: k, value: String(o[k]), peer: '' });
      const wl = o[OVERRIDE_WHEN_LOCAL];
      if (wl && typeof wl === 'object') for (const peer of Object.keys(wl)) { const pv = wl[peer]; if (pv && typeof pv === 'object') for (const vk of Object.keys(pv)) rows.push({ var: vk, value: String(pv[vk]), peer }); }
    }
    return rows;
  };
  const rowsToOverrides = (rows) => {
    const entry = {};
    for (const row of rows || []) {
      const v = String(row.var || '').trim(); if (!v) continue;
      const val = String(row.value == null ? '' : row.value), peer = String(row.peer || '').trim();
      if (peer) ((entry[OVERRIDE_WHEN_LOCAL] = entry[OVERRIDE_WHEN_LOCAL] || {})[peer] = entry[OVERRIDE_WHEN_LOCAL][peer] || {})[v] = val;
      else entry[v] = val;
    }
    return entry;
  };
  const setOrDel = (o, key, v, keep) => { if (keep == null ? !!v : keep) o[key] = v; else delete o[key]; };
  const usersOf = (n) => Object.entries(cfg.services).filter(([, p]) => (p.guards || []).includes(n)).map(([pn]) => pn);
  const machine = loadMachine(flags);              // servicesDir + UI prefs still live in local.json
  // Apply a servicesDir edit to the WHOLE session immediately (working-copy model): update the in-memory
  // machine + the module-global SERVICES_DIR so every service's path check / folder picker / match-labels
  // reflects it right away. Disk (local.json) is still only written on save.
  const syncServicesDir = (v) => { const pd = String(v).trim(); if (pd) machine.servicesDir = pd; else delete machine.servicesDir; SERVICES_DIR = pd ? resolvePath(pd) : null; };
  // Env overrides are TWO layers, both editable as per-service blocks: shared lives in the committable
  // config.json (no secrets), local lives in machine-only local.json and WINS at run time (see mergeOverrides).
  cfg.overrides = isObj(cfg.overrides) ? cfg.overrides : {};
  machine.overrides = isObj(machine.overrides) ? machine.overrides : {};
  const overrides = cfg.overrides;          // shared layer (config.json) — persist()
  const localOverrides = machine.overrides; // local layer (local.json)   — writeMachine()

  const servicesSection = {
    key: 'services', title: 'SERVICES', noun: 'service', newLabel: '+ New service',
    names: () => Object.keys(cfg.services),
    fields: [
      { key: 'name', label: 'name', kind: 'name', req: true, desc: 'A short, unique name for this service.' },
      { key: 'path', label: 'path', kind: 'text', req: true, desc: "The service's folder. Type it, or press ⏎ to pick from your services dir." },
      { key: 'type', label: 'type', kind: 'choice', options: SERVICE_TYPES, desc: 'What this service is: a frontend app, a backend service, or other.' },
      { key: 'runner', label: 'runner', kind: 'text', desc: 'Optional. A command template with {task} (e.g. "npm run {task}"). You can usually skip this and just fill start below.' },
      // start: the core command, entered as a plain string (stored as tasks.start). The `tasks` map below
      // holds only the OTHER, optional tasks (e.g. debug) — start is edited here, not as a map row.
      { key: 'start', label: 'start', kind: 'text', desc: 'The command that starts this service (e.g. "npm run dev"). Write {envfile} where it should load the env file.' },
      { key: 'debug', label: 'debug', kind: 'text', desc: 'Optional. A command to start this service in debug mode (attachable). If set, the picker offers a "d" toggle to launch it instead of start.' },
      { key: 'env', label: 'env', kind: 'text', desc: 'Where this service\'s env files live, with {env} for the environment name (e.g. ".envs/{env}").' },
      { key: 'defaultBranch', label: 'branch', kind: 'text', desc: 'Optional. The branch you cut new work from (e.g. main). Just a note — crew runs no git.' },
      { key: 'tasks', label: 'tasks (other)', kind: 'map', kLabel: 'task', vLabel: 'command', desc: 'Optional extra commands besides start (e.g. a "debug" command). Not required.' },
      { key: 'guards', label: 'guards', kind: 'multiselect', options: () => Object.keys(cfg.guards), desc: 'Checks that must pass before this service starts. Tick the ones to require.' },
      { key: 'local', label: 'local', kind: 'text', desc: "This service's local URL, e.g. http://localhost:3000." },
      // match: env-labeled hosts, rendered INLINE (one line per env, like Environment Overrides). Keys are
      // DERIVED from the service's env files (the `env` template) — you can't add/remove rows, only fill each
      // env's host value (blank = no match). Space-separate to give one env several hosts. Union with any
      // labels already stored so existing data stays editable.
      { key: 'match', label: 'match', kind: 'match', desc: "This service's deployed host per environment (e.g. pre = api.pre.example.com). Fill in the host for each env." },
      // env overrides — TWO titled blocks (see save/del below): shared writes config.json (committable),
      // local writes local.json (machine-only, secrets, WINS at run time). Same inline row editor for both.
      { key: 'overrides', label: 'overrides', kind: 'overrides', groupTitle: 'Environment Overrides · shared (config)', desc: 'Extra environment variables to set when this service runs. Shared with your team — no secrets here.' },
      { key: 'localOverrides', label: 'local overrides', kind: 'overrides', groupTitle: 'Environment Overrides · local (wins · machine-only)', desc: 'Extra environment variables just for you, kept off git. Put secrets like a DB password here.' },
    ],
    load: (n) => {
      const p = cfg.services[n] || {};
      const { start = '', debug = '', ...otherTasks } = { ...(p.tasks || {}) }; // start + debug are edited in their own fields; the map shows the rest
      return { name: n, path: p.path || '', type: p.type || 'other', runner: p.runner || '', start, debug, env: p.env || '', local: p.local || '', match: (p.match && typeof p.match === 'object' && !Array.isArray(p.match)) ? { ...p.match } : {}, guards: [...(p.guards || [])], defaultBranch: p.defaultBranch || '', tasks: otherTasks, overrides: overridesToRows(overrides[n]), localOverrides: overridesToRows(localOverrides[n]), isNew: false, orig: n };
    },
    blank: () => ({ name: '', path: '', type: 'other', runner: '', start: '', debug: '', env: '', local: '', match: {}, guards: [], defaultBranch: '', tasks: {}, overrides: [], localOverrides: [], isNew: true, orig: null }),
    save: (f) => {
      const name = String(f.name).trim();
      if (!name) return 'name is required';
      if (!String(f.path).trim()) return 'path is required';
      const renaming = !f.isNew && name !== f.orig;
      if ((f.isNew || renaming) && cfg.services[name]) return `service '${name}' already exists`;
      const base = f.isNew ? {} : { ...(cfg.services[f.orig] || {}) }; // preserve any unmanaged/future keys
      if (renaming) delete cfg.services[f.orig];
      const proj = { ...base, path: String(f.path).trim(), type: f.type };
      setOrDel(proj, 'runner', String(f.runner).trim());
      setOrDel(proj, 'env', String(f.env).trim());
      setOrDel(proj, 'local', String(f.local).trim());
      setOrDel(proj, 'defaultBranch', String(f.defaultBranch).trim());
      setOrDel(proj, 'match', f.match, f.match && Object.keys(f.match).length > 0);
      // the dedicated `start` + `debug` fields fold back into tasks.start / tasks.debug; the map holds the rest
      const tasks = { ...(f.tasks || {}) };
      const startCmd = String(f.start || '').trim();
      if (startCmd) tasks.start = startCmd; else delete tasks.start;
      const debugCmd = String(f.debug || '').trim();
      if (debugCmd) tasks.debug = debugCmd; else delete tasks.debug;
      setOrDel(proj, 'tasks', tasks, Object.keys(tasks).length > 0);
      setOrDel(proj, 'guards', f.guards, Array.isArray(f.guards) && f.guards.length > 0);
      cfg.services[name] = proj;
      // env overrides: shared -> cfg.overrides (persist), local -> machine.overrides (writeMachine). Both move
      // with a rename; empty = no entry. local.json is NOT touched unless a local override actually changed.
      if (renaming) { delete overrides[f.orig]; delete localOverrides[f.orig]; }
      const shared = rowsToOverrides(f.overrides);
      if (Object.keys(shared).length) overrides[name] = shared; else delete overrides[name];
      const local = rowsToOverrides(f.localOverrides);
      const hadLocal = localOverrides[name] != null || renaming;
      if (Object.keys(local).length) localOverrides[name] = local; else delete localOverrides[name];
      persist();
      if (hadLocal || Object.keys(local).length) writeMachine(flags, machine);
      return null;
    },
    del: (n) => { delete cfg.services[n]; delete overrides[n]; const hadLocal = localOverrides[n] != null; delete localOverrides[n]; persist(); if (hadLocal) writeMachine(flags, machine); },
    info: (f) => { if (f.isNew || !String(f.path).trim()) return ''; let abs; try { abs = resolveServicePath(String(f.path).trim()); } catch { return `${DIM}path${UNDIM}  ${String(f.path).trim()}  ${DIM}(set a services dir in Settings)${UNDIM}`; } return pathExists(abs) ? `${DIM}path${UNDIM}  ${abs}` : `\x1b[31mpath not found:\x1b[39m ${abs}`; },
  };

  const guardsSection = {
    key: 'guards', title: 'GUARDS', noun: 'guard', newLabel: '+ New guard',
    names: () => Object.keys(cfg.guards),
    fields: [
      { key: 'name', label: 'name', kind: 'name', req: true, desc: 'A short name for this check.' },
      { key: 'comment', label: 'comment', kind: 'text', req: true, desc: 'One line saying what this check verifies.' },
      { key: 'command', label: 'command', kind: 'text', req: true, desc: 'A shell command to run. It passes if the command exits 0.' },
      { key: 'message', label: 'message', kind: 'text', desc: 'What to show if the check fails — tell the user how to fix it.' },
    ],
    load: (n) => { const g = cfg.guards[n] || {}; return { name: n, comment: g.comment || '', command: g.command || '', message: g.message || '', isNew: false, orig: n }; },
    blank: () => ({ name: '', comment: '', command: '', message: '', isNew: true, orig: null }),
    save: (f) => {
      const name = String(f.name).trim();
      if (!name) return 'name is required';
      if (!String(f.comment).trim()) return 'comment is required';
      if (!String(f.command).trim()) return 'command is required';
      const renaming = !f.isNew && name !== f.orig;
      if ((f.isNew || renaming) && cfg.guards[name]) return `guard '${name}' already exists`;
      if (renaming) { delete cfg.guards[f.orig]; for (const pr of Object.values(cfg.services)) if ((pr.guards || []).includes(f.orig)) { setServiceGuard(pr, f.orig, false); setServiceGuard(pr, name, true); } }
      cfg.guards[name] = String(f.message).trim() ? { comment: String(f.comment).trim(), command: String(f.command).trim(), message: String(f.message).trim() } : { comment: String(f.comment).trim(), command: String(f.command).trim() };
      persist(); return null;
    },
    del: (n) => { delete cfg.guards[n]; for (const pr of Object.values(cfg.services)) setServiceGuard(pr, n, false); persist(); },
    info: (f) => f.isNew ? '' : `${DIM}used by${UNDIM}  ${usersOf(f.orig).join(', ') || `${DIM}(no services)${UNDIM}`}`,
  };

  // Top-level (global) config + machine-local servicesDir. A FIXED section: one synthetic item, no +New
  // row and no create/delete — you only edit the values. workspaceSettings values are JSON-typed (so
  // `false`/`3` keep their type), stringified for the row editor and parsed back on save.
  const mapStringify = (o) => { const r = {}; if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) r[k] = typeof v === 'string' ? v : JSON.stringify(v); return r; };
  const jsonParseVals = (o) => { const r = {}; for (const [k, v] of Object.entries(o || {})) { let val = v; try { val = JSON.parse(v); } catch {} r[k] = val; } return r; };
  const loadSettings = () => ({
    workspaceName: cfg.workspaceName || '',
    workspaceSettings: mapStringify(cfg.workspaceSettings),
    servicesDir: machine.servicesDir || '',
    isNew: false, orig: 'config',
  });
  const settingsSection = {
    key: 'settings', title: 'SETTINGS', noun: 'settings', fixed: true,
    names: () => ['config'],
    fields: [
      { key: 'workspaceName', label: 'workspaceName', kind: 'text', desc: 'A name for the VS Code workspace crew opens.' },
      { key: 'workspaceSettings', label: 'wsSettings', kind: 'map', json: true, kLabel: 'setting', vLabel: 'value', desc: 'Optional VS Code settings for that workspace, e.g. jest.enable = false.' },
      { key: 'servicesDir', label: 'servicesDir', kind: 'text', desc: 'The folder your services live in. Service paths you enter as relative are looked up here.' },
    ],
    load: loadSettings,
    blank: loadSettings,
    save: (f) => {
      setOrDel(cfg, 'workspaceName', String(f.workspaceName).trim());
      setOrDel(cfg, 'workspaceSettings', jsonParseVals(f.workspaceSettings), f.workspaceSettings && Object.keys(f.workspaceSettings).length > 0);
      persist();
      syncServicesDir(f.servicesDir);   // in-memory + SERVICES_DIR (idempotent with the live edit)
      writeMachine(flags, machine);
      return null;
    },
    info: (f) => { const miss = missingServiceFolders(cfg, String(f.servicesDir).trim()); const total = Object.keys(cfg.services).length; return miss.length ? `\x1b[33m⚠ ${miss.length}/${total} service folder(s) not found under servicesDir\x1b[39m` : ''; },
  };

  const sections = [settingsSection, servicesSection, guardsSection];
  const optionsOf = (fld) => (typeof fld.options === 'function' ? fld.options() : fld.options || []);
  // FIXED sections contribute their single item but NO "+ New" row.
  const selectable = () => { const out = []; sections.forEach((s, si) => { s.names().forEach((n) => out.push({ si, name: n })); if (!s.fixed && !s.noNew) out.push({ si, name: null }); }); return out; };
  let sel = selectable();
  let li = 0, focus = 'left', fi = 0, editing = false, buf = '', caret = 0;
  let form = null, msg = '', panel = null, panelField = null, leftTop = 0, dirty = false;
  let mapEdit = null, editTarget = null, newKey = ''; // mapEdit = {field, rows:[[k,v]], ri}; editTarget routes an inline edit's commit (null=field, 'val'/'newkey'/'newval'=map cell, 'ovVar'/'ovVal'=override cell)
  let ovEdit = null; // Environment Overrides editor: {field, rows:[{var,value,peer}], ri, ci} — ci 0=VAR 1=value 2=when-local; full-pane row editor like mapEdit
  const OV_NONE = '— always (no condition) —'; // the "no peer" choice in the when-local picker
  // A MODAL captures every key until a choice runs: {title, lines[], choices:[{keys[], label, run()->doneBool}]}.
  // Used for the delete confirm and the unsaved-changes-on-exit prompt. `run` returns true if it resolved.
  let modal = null;

  const secOf = () => sections[sel[li].si];
  // In-memory edit drafts: a whole-session working copy so edits to ANY item survive navigating away and
  // back — nothing rolls back until you save (→ disk) or discard on exit. Keyed by section + item name
  // (a NEW item uses the section's sentinel slot). loadForm returns the SAME draft ref, so further edits
  // keep accumulating in it. `stashDraft` parks the current form before we move off it.
  const drafts = new Map();
  const draftKey = (cur) => `${cur.si}:${cur.name == null ? '\x00new' : cur.name}`;
  const stashDraft = () => { if (dirty) drafts.set(draftKey(sel[li]), form); };
  const loadForm = () => { const cur = sel[li], key = draftKey(cur); if (drafts.has(key)) { form = drafts.get(key); dirty = true; } else { form = cur.name == null ? sections[cur.si].blank() : sections[cur.si].load(cur.name); dirty = false; } };
  const reselect = (si, name) => { sel = selectable(); let i = sel.findIndex((n) => n.si === si && n.name === name); if (i < 0) i = sel.findIndex((n) => n.si === si); if (i < 0) i = 0; li = Math.max(0, Math.min(i, sel.length - 1)); loadForm(); };
  const startAt = (key) => { const i = sel.findIndex((n) => sections[n.si].key === key); li = i >= 0 ? i : 0; };
  startAt(opts.section || 'services');
  loadForm();

  const doSave = () => {
    const s = secOf(), si = sel[li].si;
    const err = s.save(form);
    if (err) { msg = `\x1b[31m${err}\x1b[39m`; return err; }
    const name = String(form.name).trim();
    drafts.delete(draftKey(sel[li])); // written to disk — no longer a pending draft
    reselect(si, name); dirty = false; msg = `\x1b[32msaved '${name}'\x1b[39m`;
    return null;
  };
  const doDelete = (name) => { const s = secOf(), si = sel[li].si; drafts.delete(draftKey(sel[li])); s.del(name); reselect(si, null); focus = 'left'; msg = `removed '${name}'`; };
  // Save/discard EVERY pending draft (used by the on-exit prompt). saveAll runs each section's validating
  // save; on the first error it jumps to the offending item and stops so the user can fix it.
  const saveAll = () => {
    stashDraft();
    for (const [key, f] of [...drafts]) {
      const si = Number(key.slice(0, key.indexOf(':')));
      const err = sections[si].save(f);
      if (err) { const nm = f.isNew ? null : (String(f.name).trim() || f.orig); drafts.delete(key); reselect(si, nm); if (nm == null) { form = f; dirty = true; } focus = 'right'; msg = `\x1b[31m${err}\x1b[39m`; return err; }
      drafts.delete(key);
    }
    return null;
  };
  const discardAll = () => { drafts.clear(); dirty = false; };
  // When a NEW service's `path` points at a real folder, prefill the still-empty fields from folder signals
  // (detectService). Non-destructive: only blanks are filled, so it never clobbers what you typed.
  const maybeDetect = () => {
    if (secOf().key !== 'services' || !form.isNew) return;
    const pth = String(form.path || '').trim(); if (!pth) return;
    let abs; try { abs = resolveServicePath(pth); } catch { return; }
    if (!pathExists(abs)) return;
    const d = detectService(abs), got = [];
    if (!form.name) { form.name = pth.split(/[\\/]/).filter(Boolean).pop() || ''; if (form.name) got.push('name'); }
    if ((!form.type || form.type === 'other') && d.type) { form.type = d.type; got.push('type'); }
    if (!form.runner && d.runner) { form.runner = d.runner; got.push('runner'); }
    if (!form.env && d.env) { form.env = d.env; got.push('env'); }
    if (!form.local && d.local) { form.local = d.local; got.push('local'); }
    if (d.start && !form.start) { form.start = d.start; got.push('start'); }
    if (got.length) { dirty = true; msg = `${DIM}auto-filled from folder: ${got.join(', ')}${UNDIM}`; }
  };
  // Folder picker for the service `path` field: the subfolders of servicesDir + a "type a path…" escape
  // (for folders elsewhere, or when no servicesDir is set). So you don't type the path from memory.
  const TYPE_PATH = '✎ type a path…';
  const serviceDirs = () => { const d = machine.servicesDir; if (!d) return []; try { return readdirSync(resolvePath(d), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort(); } catch { return []; } };
  const editPath = () => { editing = true; buf = String(form.path || ''); caret = buf.length; }; // fall back to typing
  const openFolderPick = () => {
    const dirs = serviceDirs();
    if (!dirs.length) return editPath(); // no servicesDir / no folders -> just type the path
    panelField = { key: 'path', pick: 'folder', label: 'pick a folder' };
    panel = makeFilterPanel([...dirs, TYPE_PATH], { paint, single: true, title: 'pick a folder' });
    panel.open(dirs.includes(form.path) ? form.path : null);
  };

  return new Promise((resolve) => {
    const w = (x) => stdout.write(x);
    const wasRaw = stdin.isRaw;
    const clipP = (s, n) => { const a = [...String(s)]; return a.length > n ? a.slice(0, Math.max(0, n - 1)).join('') + '…' : String(s); };
    const padP = (s, n) => { const d = [...String(s).replace(/\x1b\[[0-9;]*m/g, '')].length; return d >= n ? String(s) : String(s) + ' '.repeat(n - d); };
    const rev = (s) => `\x1b[7m${s}\x1b[27m`;
    const cleanup = () => { stdin.removeListener('data', onData); stdout.removeListener('resize', repaint); w('\x1b[?25h\x1b[?7h\x1b[?1049l'); if (stdin.setRawMode) stdin.setRawMode(wasRaw); stdin.pause(); };

    const displayRows = () => { const d = []; sections.forEach((s, si) => { if (si) d.push({ kind: 'space' }); d.push({ kind: 'header', si }); s.names().forEach((n) => d.push({ kind: 'item', si, name: n })); if (!s.fixed && !s.noNew) d.push({ kind: 'new', si }); }); return d; };

    const repaint = () => {
      const C = stdout.columns || 80, R = Math.max(10, stdout.rows || 24);
      const LW = Math.min(30, Math.max(16, (C * 0.32) | 0)), RW = Math.max(12, C - LW - 4);
      const body = R - 2; // title (1) + footer (1); body fills the rest, footer pinned to the last row
      const cur = sel[li], s = secOf();
      // ---- left column (all sections stacked; scrolls to keep the cursor visible) ----
      const d = displayRows();
      const isCur = (r) => (r.kind === 'item' && r.si === cur.si && r.name === cur.name) || (r.kind === 'new' && r.si === cur.si && cur.name == null);
      const ci = d.findIndex(isCur);
      if (ci < leftTop) leftTop = ci; else if (ci >= leftTop + body) leftTop = ci - body + 1;
      leftTop = Math.max(0, Math.min(leftTop, Math.max(0, d.length - body)));
      const L = [];
      for (let r = 0; r < body; r++) {
        const row = d[leftTop + r];
        if (!row || row.kind === 'space') { L.push(''); continue; }
        if (row.kind === 'header') { L.push(`${DIM}${sections[row.si].title}${UNDIM}  ${DIM}${sections[row.si].names().length}${UNDIM}`); continue; }
        const label = row.kind === 'new' ? sections[row.si].newLabel : (isCur(row) && form.name ? form.name : row.name); // current item shows its live (possibly-edited) name
        const on = isCur(row);
        let cell = padP((on ? '▸ ' : '  ') + clipP(label, LW - 2), LW);
        if (on && focus === 'left') cell = rev(cell); else if (row.kind === 'new') cell = `\x1b[32m${cell}\x1b[39m`;
        L.push(cell);
      }
      // A value being edited, windowed to `avail` cols so a long value scrolls horizontally to keep the caret in view.
      const editCell = (avail) => { const w2 = Math.max(4, avail); const start = caret >= w2 ? caret - w2 + 1 : 0; const seg = buf.slice(start, start + w2); const cp = caret - start; return seg.slice(0, cp) + '\x1b[7m' + (seg[cp] || ' ') + '\x1b[27m' + seg.slice(cp + 1); };
      // ---- right column ---- (a `map` field editor TAKES OVER the whole right pane — full width/height —
      // rather than a cramped popup, so long task commands / match hosts have room; left column stays for context)
      const Rn = [];
      if (mapEdit && !panel) {
        const F = mapEdit, fld = F.field;
        Rn.push(`\x1b[1m${fld.label}\x1b[22m ${DIM}· ${s.noun} ${form.name || form.orig}${UNDIM}`);
        Rn.push('');
        if (F.list) { // single-column list (one value per row; no field uses this kind right now)
          F.rows.forEach((v, i) => {
            const on = F.ri === i;
            const vc = (editing && editTarget === 'listval' && on) ? editCell(RW - 6) : clipP(String(v), RW - 6);
            const line = ` ${on && !editing ? '▸' : ' '} ${vc}`;
            Rn.push(on && !editing ? rev(padP(line, RW)) : line);
          });
          if (editing && editTarget === 'newval') Rn.push(`   ${editCell(RW - 6)}`);
          else { const addOn = F.ri === F.rows.length; Rn.push(addOn ? rev(padP(`  ▸ + add ${fld.kLabel || 'item'}`, RW)) : `    \x1b[32m+ add ${fld.kLabel || 'item'}\x1b[39m`); }
        } else { // key -> value map (match, tasks, guards' vars, whenLocal, wsSettings)
          const kW = Math.min(24, Math.max(3, (fld.kLabel || 'key').length, ...F.rows.map(([k]) => [...String(k)].length)));
          const valAvail = Math.max(8, RW - kW - 6);
          F.rows.forEach(([k, v], i) => {
            const on = F.ri === i;
            const kc = padP(clipP(String(k), kW), kW);
            const vc = (editing && editTarget === 'val' && on) ? editCell(valAvail) : clipP(String(v), valAvail);
            const line = ` ${on && !editing ? '▸' : ' '} ${kc}  ${vc}`;
            Rn.push(on && !editing ? rev(padP(line, RW)) : line);
          });
          if (editing && (editTarget === 'newkey' || editTarget === 'newval')) {
            const kc = editTarget === 'newkey' ? editCell(kW) : padP(clipP(newKey, kW), kW);
            const vc = editTarget === 'newval' ? editCell(valAvail) : '';
            Rn.push(`   ${kc}  ${vc}`);
          } else {
            const addOn = F.ri === F.rows.length;
            Rn.push(addOn ? rev(padP(`  ▸ + add ${fld.kLabel || 'row'}`, RW)) : `    \x1b[32m+ add ${fld.kLabel || 'row'}\x1b[39m`);
          }
        }
      } else if (panel) {
        Rn.push(`\x1b[1m${panelField.label}\x1b[22m ${DIM}· ${s.noun} ${form.name || form.orig}${UNDIM}`);
        Rn.push('');
        for (const ln of panel.bareRows(body - 2, RW)) Rn.push(ln);
      } else {
        Rn.push(form.isNew ? `\x1b[1mNew ${s.noun}\x1b[22m` : `\x1b[1m${s.noun[0].toUpperCase() + s.noun.slice(1)}\x1b[22m ${DIM}·${UNDIM} ${form.name || form.orig}`);
        Rn.push('');
        const labW = s.fields.reduce((m, f) => Math.max(m, f.label.length), 4); // align values to the widest label in this section
        const vW = Math.max(8, RW - labW - 6);
        s.fields.forEach((fld, i) => {
          const on = focus === 'right' && i === fi;
          // INLINE row lists (overrides + match) — one line per row, rendered in the form (NOT a full-pane
          // page) and edited in place: ⏎ enters row-edit; ↑↓ rows; ←→ cols (overrides); ⏎ edits a cell.
          if (fld.kind === 'overrides' || fld.kind === 'match') {
            const isMatch = fld.kind === 'match';
            const editingRows = !!ovEdit && ovEdit.field.key === fld.key;
            const rows = editingRows ? ovEdit.rows
              : isMatch ? matchLabels(form).map((env) => ({ env, host: matchValToStr((form.match || {})[env]) }))
                        : (form[fld.key] || []);
            Rn.push('');
            const title = isMatch ? `match  ${DIM}· env-labeled hosts (keys from env files)${UNDIM}` : fld.groupTitle;
            const titleFocused = on && !editingRows && !editing;
            Rn.push(titleFocused ? rev(`  ${title.replace(/\x1b\[[0-9;]*m/g, '')}  ⏎ edit `) : `  ${DIM}${title}${UNDIM}`);
            // Key column shows the FULL key (env vars are long) — sized to the actual pane width, capped only
            // enough to leave the value some room. Value clips (full value is visible when you ⏎ to edit it).
            const keyW = Math.min(Math.max(3, RW - 14), Math.max(3, ...rows.map((r) => [...String((isMatch ? r.env : r.var) || '(VAR)')].length)));
            if (!rows.length) Rn.push(isMatch ? `    ${DIM}(no env files found — set env / create them)${UNDIM}` : `    ${DIM}(none)${UNDIM}`);
            rows.forEach((row, ri) => {
              const rowOn = editingRows && ovEdit.ri === ri, ci = editingRows ? ovEdit.ci : -1;
              // While editing a cell, give it the WHOLE row (no cramped column) so a long VAR/value stays visible as you type.
              if (editing && rowOn && editTarget === 'ovVar') { Rn.push(`  ▸ ${DIM}VAR${UNDIM} ${editCell(Math.max(8, RW - 8))}`); return; }
              if (editing && rowOn && (editTarget === 'ovVal' || editTarget === 'meHost')) { Rn.push(`  ▸ ${DIM}${isMatch ? 'host' : 'value'}${UNDIM} ${editCell(Math.max(8, RW - 10))}`); return; }
              const k0 = isMatch ? (row.env || '') : (row.var || '(VAR)');
              const kP = padP(clipP(k0, keyW), keyW);
              // col 0 = key (VAR for overrides; env is FIXED for match — shown cyan, not focusable)
              const c0 = (!isMatch && rowOn && !editing && ci === 0) ? rev(` ${kP} `) : (isMatch ? ` \x1b[36m${kP}\x1b[39m ` : ` ${kP} `);
              // col 1 = value/host (clips — full value is visible when you ⏎ to edit it)
              const v1 = isMatch ? (row.host || '(host)') : (row.value || '(value)');
              const wpLen = isMatch ? 0 : (row.peer ? `when ${row.peer} local`.length : 6);
              const vDisp = clipP(v1, Math.max(4, RW - keyW - wpLen - 10));
              const c1 = (rowOn && !editing && ci === 1) ? rev(` ${vDisp} `) : ` ${vDisp} `;
              let line = `  ${rowOn && !editing ? '▸' : ' '}${c0}${DIM}=${UNDIM}${c1}`;
              if (!isMatch) { const wp = row.peer ? `when ${row.peer} local` : 'always'; line += (rowOn && !editing && ci === 2) ? rev(` ${wp} `) : (row.peer ? ` \x1b[36m${wp}\x1b[39m` : ` ${DIM}${wp}${UNDIM}`); }
              Rn.push(line);
            });
            if (editingRows && !isMatch) { const addOn = ovEdit.ri === rows.length; Rn.push(`  ${addOn && !editing ? rev(' ▸ + add override ') : ' \x1b[32m+ add override\x1b[39m'}`); }
            return;
          }
          if (fld.groupTitle) { Rn.push(''); Rn.push(`  ${DIM}${fld.groupTitle}${UNDIM}`); } // a titled block separator before this field
          const editText = editing && on && (fld.kind === 'text' || fld.kind === 'name');
          let val;
          if (editText) val = editCell(vW); // block caret, scrolls if long
          else if (fld.kind === 'multiselect' || fld.kind === 'list') { const a = form[fld.key] || []; val = a.length ? a.join(', ') : `${DIM}(none)${UNDIM}`; }
          else if (fld.kind === 'map') { const o = form[fld.key] || {}, ks = Object.keys(o); val = ks.length ? Object.entries(o).map(([k, v]) => `${k}=${v}`).join('  ') : `${DIM}(none)${UNDIM}`; }
          else val = String(form[fld.key]) ? String(form[fld.key]) : `${DIM}(${fld.req ? 'required' : 'optional'})${UNDIM}`;
          const lab = padP(fld.label, labW);
          Rn.push(`  ${on && !editing ? rev(' ' + lab + ' ') : DIM + ' ' + lab + ' ' + UNDIM} ${editText ? val : clipP(val, vW)}`);
        });
        const info = s.info ? s.info(form) : '';
        if (info) { Rn.push(''); Rn.push('  ' + info); }
        // Per-field help: the focused field's `desc`, word-wrapped, pinned under the form in dim. Always
        // visible so hovering a field explains it (no keypress needed). Hidden during a sub-editor takeover.
        const fdesc = s.fields[fi] && s.fields[fi].desc;
        if (fdesc) {
          const lines = []; let line = '';
          for (const w of String(fdesc).split(/\s+/)) { if (line && line.length + 1 + w.length > RW - 4) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w; }
          if (line) lines.push(line);
          Rn.push(''); for (const ln of lines) Rn.push(`  ${DIM}${ln}${UNDIM}`);
        }
      }
      // ---- compose ---- (home + per-row \x1b[K, NEVER a full-screen \x1b[2J: 2J pushes the erased
      // lines into scrollback on some terminals, making the editor "scrollable". The graph pager and
      // log viewer avoid it the same way — every row is rewritten each frame, so [K is enough.)
      const shade = modal ? dimText : (x) => x; // a modal dims the whole editor behind its (bright) box
      let out = '\x1b[H';
      out += '\x1b[K' + shade(' \x1b[1mcrew\x1b[22m' + DIM + '  ·  config editor' + UNDIM) + '\r\n';
      for (let r = 0; r < body; r++) out += '\x1b[K' + shade(' ' + padP(L[r] || '', LW) + ' ' + DIM + '│' + UNDIM + ' ' + (Rn[r] || '')) + '\r\n';
      // ---- footer ----
      let parts;
      if (modal) parts = modal.choices.map((c) => c.label);
      else if (panel) parts = (panelField.kind === 'choice' || panelField.single) ? ['↑↓ pick', '⏎ apply', 'esc cancel'] : ['space toggle', 'a all', '⏎ apply', 'esc cancel'];
      else if (editing) parts = ['type', '←→ move', '⌥← word', '⏎ commit', 'esc cancel'];
      else if (mapEdit) parts = ['↑↓ row', '⏎ edit', 'd remove', 'esc done'];
      else if (ovEdit) parts = ovEdit.field.kind === 'match' ? ['↑↓ row', '⏎ edit host', 'esc done'] : ['↑↓ row', '←→ col', '⏎ edit', 'd remove', 'esc done'];
      else if (focus === 'left') parts = ['↑↓ move', '⏎ open', 'n new', 'd delete', 'esc quit'];
      else { const fld = s.fields[fi]; const eh = (fld.key === 'path' && s.key === 'services') ? '⏎ pick folder' : fld.kind === 'choice' || fld.kind === 'multiselect' ? '⏎ pick' : fld.kind === 'list' || fld.kind === 'map' ? '⏎ rows' : fld.kind === 'readonly' ? '' : '⏎ edit'; parts = ['↑↓ field', eh, 's save', ...(form.isNew || s.fixed ? [] : ['d delete']), 'esc ← list'].filter(Boolean); }
      if (msg) parts = [msg, ...parts];
      out += '\x1b[K' + shade(footerBar(footerText(parts), C));
      // ---- modal overlay (roomy, perfectly-centered box; captures all keys until a choice runs) ----
      if (modal) {
        const dw = (x) => [...String(x).replace(/\x1b\[[0-9;]*m/g, '')].length;
        const hint = modal.choices.map((c) => c.label).join('     ');
        const rows2 = [...(modal.lines || []), '', hint];
        const iw = Math.min(C - 6, Math.max(48, dw(modal.title) + 6, ...rows2.map(dw)) + 6); // bigger: min ~54, roomy padding, capped
        const center = (ln) => { const l = Math.max(0, (iw - dw(ln)) >> 1); return ' '.repeat(l) + ln + ' '.repeat(Math.max(0, iw - l - dw(ln))); };
        const tt = ` ${modal.title} `, dl = Math.max(0, iw - dw(tt)), lft = dl >> 1;
        const blank = '│' + ' '.repeat(iw) + '│', vpad = 4; // generous top/bottom padding -> ~2x taller box
        const box = ['\x1b[1m┌' + '─'.repeat(lft) + tt + '─'.repeat(dl - lft) + '┐\x1b[22m', ...Array(vpad).fill(blank)];
        for (const ln of rows2) box.push('│' + center(ln) + '│');
        box.push(...Array(vpad).fill(blank), '└' + '─'.repeat(iw) + '┘');
        const w2 = iw + 2, h = box.length;
        const top = Math.max(1, Math.round((R - h) / 2)), col = Math.max(1, Math.round((C - w2) / 2) + 1);
        for (let i = 0; i < h; i++) out += `\x1b[${top + i};${col}H` + box[i];
        out += '\x1b[0m';
      }
      w(out);
    };

    const openPanel = (fld) => { const items = optionsOf(fld); if (!items.length) { msg = `no ${fld.label} defined yet`; return; } panelField = fld; const single = fld.kind === 'choice'; panel = makeFilterPanel(items, { paint, title: fld.label, single }); panel.open(single ? form[fld.key] : (Array.isArray(form[fld.key]) ? form[fld.key] : [])); };
    const openItem = () => { focus = 'right'; fi = 0; }; // form already synced to sel[li] by loadForm — don't reload here (a col1→col2→col1→col2 round-trip would discard unsaved edits, e.g. a rename)
    const quit = () => { cleanup(); resolve(); return true; };
    const openDelete = (name) => { const used = secOf().key === 'guards' ? usersOf(name) : []; modal = { title: 'Delete', lines: [`Delete '${name}'?`, ...(used.length ? [`${DIM}used by ${used.length} service(s)${UNDIM}`] : [])], choices: [{ keys: ['y', 'Y'], label: 'y delete', run: () => { doDelete(name); modal = null; return false; } }, { keys: ['\x1b', 'n', 'N'], label: 'esc cancel', run: () => { modal = null; return false; } }] }; };
    const openUnsaved = () => { const n = drafts.size; modal = { title: 'Unsaved changes', lines: [`${n} unsaved change${n === 1 ? '' : 's'} — save all before leaving?`], choices: [{ keys: ['s', 'S'], label: 's save all & exit', run: () => (saveAll() ? ((modal = null), false) : quit()) }, { keys: ['d', 'D'], label: 'd discard all & exit', run: () => { discardAll(); return quit(); } }, { keys: ['\x1b'], label: 'esc cancel', run: () => { modal = null; return false; } }] }; };

    const handleKey = (k) => {
      msg = '';
      if (modal) { const ch = modal.choices.find((c) => c.keys.includes(k)); if (ch && ch.run()) return true; repaint(); return false; } // modal captures all keys
      if (panel) {
        const r = panel.key(k);
        if (r === 'apply') {
          if (panelField.pick === 'folder') { const v = [...panel.selected][0]; panel = null; if (v === TYPE_PATH) editPath(); else if (v != null) { form.path = v; dirty = true; maybeDetect(); } } // folder picked -> set path + auto-detect
          else if (panelField.ov) { const v = [...panel.selected][0]; if (v != null) ovEdit.rows[ovEdit.ri].peer = (v === OV_NONE ? '' : v); panel = null; dirty = true; } // override when-local peer
          else { if (panelField.kind === 'choice') { const v = [...panel.selected][0]; if (v != null) form[panelField.key] = v; } else form[panelField.key] = [...panel.selected]; panel = null; dirty = true; }
        }
        else if (r === 'cancel') panel = null;
        repaint(); return false;
      }
      if (editing) {
        const wordL = (i) => { let j = i; while (j > 0 && buf[j - 1] === ' ') j--; while (j > 0 && buf[j - 1] !== ' ') j--; return j; };
        const wordR = (i) => { let j = i; while (j < buf.length && buf[j] !== ' ') j++; while (j < buf.length && buf[j] === ' ') j++; return j; };
        if (k === '\r' || k === '\n') { // route the commit: a map cell, a chained new key->value, or a plain field
          if (editTarget === 'val') { mapEdit.rows[mapEdit.ri][1] = buf; editing = false; editTarget = null; }
          else if (editTarget === 'listval') { mapEdit.rows[mapEdit.ri] = buf; editing = false; editTarget = null; } // list row = a single string
          else if (editTarget === 'newkey') { newKey = buf; buf = ''; caret = 0; editTarget = 'newval'; } // key entered -> now the value (stay editing)
          else if (editTarget === 'newval') { if (mapEdit.list) { if (buf.trim()) { mapEdit.rows.push(buf); mapEdit.ri = mapEdit.rows.length - 1; } } else if (newKey.trim()) { mapEdit.rows.push([newKey.trim(), buf]); mapEdit.ri = mapEdit.rows.length - 1; } editing = false; editTarget = null; }
          else if (editTarget === 'ovVar') { ovEdit.rows[ovEdit.ri].var = buf.trim(); editing = false; editTarget = null; dirty = true; } // override VAR cell
          else if (editTarget === 'ovVal') { ovEdit.rows[ovEdit.ri].value = buf; editing = false; editTarget = null; dirty = true; } // override value cell
          else if (editTarget === 'meHost') { ovEdit.rows[ovEdit.ri].host = buf; editing = false; editTarget = null; dirty = true; } // match host cell
          else { const fk = secOf().fields[fi].key; form[fk] = buf; editing = false; dirty = true; if (fk === 'path') maybeDetect(); else if (fk === 'servicesDir') syncServicesDir(buf); } // path -> auto-fill; servicesDir -> live-apply in-session (see syncServicesDir)
        }
        else if (k === '\x1b') { editing = false; editTarget = null; }                                       // bare esc cancels the edit
        else if (k === '\x1b[D') caret = Math.max(0, caret - 1);                                             // ← left
        else if (k === '\x1b[C') caret = Math.min(buf.length, caret + 1);                                    // → right
        else if (k === '\x1bb' || k === '\x1b[1;3D' || k === '\x1b[1;5D') caret = wordL(caret);              // Option/Ctrl + ← : word left
        else if (k === '\x1bf' || k === '\x1b[1;3C' || k === '\x1b[1;5C') caret = wordR(caret);              // Option/Ctrl + → : word right
        else if (k === '\x1b[H' || k === '\x1b[1~' || k === '\x01') caret = 0;                               // Home / Ctrl-A
        else if (k === '\x1b[F' || k === '\x1b[4~' || k === '\x05') caret = buf.length;                      // End / Ctrl-E
        else if (k === '\x7f' || k === '\b') { if (caret > 0) { buf = buf.slice(0, caret - 1) + buf.slice(caret); caret--; } } // backspace
        else if (k === '\x1b[3~') { if (caret < buf.length) buf = buf.slice(0, caret) + buf.slice(caret + 1); }                // delete forward
        else if (k === '\x17') { const j = wordL(caret); buf = buf.slice(0, j) + buf.slice(caret); caret = j; }                // Ctrl-W delete word left
        else if (k === '\x15') { buf = buf.slice(caret); caret = 0; }                                        // Ctrl-U kill to start
        else if (k === '\x0b') buf = buf.slice(0, caret);                                                    // Ctrl-K kill to end
        else if (k.length === 1 && k >= ' ') { buf = buf.slice(0, caret) + k + buf.slice(caret); caret++; }  // insert printable at caret
        else return false;
        repaint(); return false;
      }
      if (mapEdit) { // map-editor row navigation (cell edits are handled by the `editing` branch above)
        const F = mapEdit, n = F.rows.length;
        if (k === 'k' || k === '\x1b[A') F.ri = Math.max(0, F.ri - 1);
        else if (k === 'j' || k === '\x1b[B') F.ri = Math.min(n, F.ri + 1);                                  // n = the "+ add" row
        else if (k === '\r' || k === '\n') {
          if (F.ri === n) { editing = true; buf = ''; caret = 0; if (F.list) editTarget = 'newval'; else { editTarget = 'newkey'; newKey = ''; } } // + add
          else if (F.list) { editing = true; buf = String(F.rows[F.ri]); caret = buf.length; editTarget = 'listval'; }
          else { editing = true; buf = String(F.rows[F.ri][1]); caret = buf.length; editTarget = 'val'; }
        }
        else if (k === 'd') { if (F.ri < n) { F.rows.splice(F.ri, 1); F.ri = Math.min(F.ri, F.rows.length); } }
        else if (k === '\x1b' || k === '\x03') { form[F.field.key] = F.list ? [...F.rows] : toObj(F.rows, F.field.multiVal); mapEdit = null; dirty = true; } // esc commits rows back to the form field
        else return false;
        repaint(); return false;
      }
      if (ovEdit) { // inline row editor (overrides + match) — cell edits handled by the `editing` branch above
        const F = ovEdit, isMatch = F.field.kind === 'match', n = F.rows.length, maxRi = isMatch ? n - 1 : n; // match has no "+ add" row
        if (k === 'k' || k === '\x1b[A') F.ri = Math.max(0, F.ri - 1);
        else if (k === 'j' || k === '\x1b[B') F.ri = Math.min(Math.max(0, maxRi), F.ri + 1);
        else if (!isMatch && (k === 'h' || k === '\x1b[D')) { if (F.ri < n) F.ci = Math.max(0, F.ci - 1); } // match: env is fixed, host-only — no column nav
        else if (!isMatch && (k === 'l' || k === '\x1b[C')) { if (F.ri < n) F.ci = Math.min(2, F.ci + 1); }
        else if (k === '\r' || k === '\n') {
          if (isMatch) { if (F.ri < n) { editing = true; editTarget = 'meHost'; buf = String(F.rows[F.ri].host || ''); caret = buf.length; } } // match: ⏎ edits the host
          else if (F.ri === n) { F.rows.push({ var: '', value: '', peer: '' }); F.ri = F.rows.length - 1; F.ci = 0; editing = true; editTarget = 'ovVar'; buf = ''; caret = 0; } // + add -> type the VAR
          else if (F.ci === 0) { editing = true; editTarget = 'ovVar'; buf = String(F.rows[F.ri].var || ''); caret = buf.length; }
          else if (F.ci === 1) { editing = true; editTarget = 'ovVal'; buf = String(F.rows[F.ri].value || ''); caret = buf.length; }
          else { // when-local peer -> single-select picker (services minus self, plus "always")
            const self = form.orig || form.name, peers = Object.keys(cfg.services).filter((p) => p !== self);
            panelField = { ov: true, single: true, label: 'when local' };
            panel = makeFilterPanel([OV_NONE, ...peers], { paint, single: true, title: 'when local' });
            panel.open(F.rows[F.ri].peer || OV_NONE);
          }
        }
        else if (!isMatch && k === 'd') { if (F.ri < n) { F.rows.splice(F.ri, 1); F.ri = Math.min(F.ri, F.rows.length); F.ci = 0; } } // match: keys can't be removed
        else if (k === '\x1b' || k === '\x03') { // commit rows back to the form
          if (isMatch) form.match = matchCommit(F.rows.map((r) => [r.env, r.host]));
          else form[F.field.key] = F.rows.filter((r) => String(r.var || '').trim());
          ovEdit = null; dirty = true;
        }
        else return false;
        repaint(); return false;
      }
      if (k === '\x03') return quit();                                          // Ctrl-C force-quits (even with unsaved edits)
      if (k === '\x1b') { // esc is level-by-level: right pane -> back to the list; list -> quit (prompt if unsaved)
        if (focus === 'right') { focus = 'left'; repaint(); return false; } // form field -> the item list (edits stay in memory)
        stashDraft(); if (drafts.size) { openUnsaved(); repaint(); return false; } return quit();
      }
      if (focus === 'left') {
        if (k === 'k' || k === '\x1b[A') { stashDraft(); li = Math.max(0, li - 1); loadForm(); }
        else if (k === 'j' || k === '\x1b[B') { stashDraft(); li = Math.min(sel.length - 1, li + 1); loadForm(); }
        else if (k === '\r' || k === '\n' || k === 'l' || k === '\t') openItem();       // enter/l/tab open the item; ←/→ are reserved for caret + overrides-column nav (no pane jump)
        else if (k === 'n') { const si = sel[li].si; if (!sections[si].fixed) { stashDraft(); const at = sel.findIndex((x) => x.si === si && x.name == null); li = at >= 0 ? at : li; loadForm(); focus = 'right'; fi = 0; } } // fixed sections (Settings) have no create
        else if (k === 'd') { if (sel[li].name != null && !secOf().fixed) openDelete(sel[li].name); } // ...and no delete
        else return false;
        repaint(); return false;
      }
      // focus === 'right'
      const fields = secOf().fields, fld = fields[fi];
      if (k === 'k' || k === '\x1b[A') fi = Math.max(0, fi - 1);
      else if (k === 'j' || k === '\x1b[B') fi = Math.min(fields.length - 1, fi + 1);
      else if (k === '\r' || k === '\n') {
        if (fld.key === 'path' && secOf().key === 'services') openFolderPick(); // pick a folder (or type)
        else if (fld.kind === 'text' || fld.kind === 'name') { editing = true; buf = String(form[fld.key] || ''); caret = buf.length; }
        else if (fld.kind === 'choice' || fld.kind === 'multiselect') openPanel(fld);
        else if (fld.kind === 'map') { mapEdit = { field: fld, rows: toRows(form[fld.key]), ri: 0, list: false }; }
        else if (fld.kind === 'match') { ovEdit = { field: fld, rows: matchLabels(form).map((env) => ({ env, host: matchValToStr((form.match || {})[env]) })), ri: 0, ci: 1 }; } // inline env→host editor (fixed keys)
        else if (fld.kind === 'list') { mapEdit = { field: fld, rows: [...(Array.isArray(form[fld.key]) ? form[fld.key] : [])], ri: 0, list: true }; }
        else if (fld.kind === 'overrides') { ovEdit = { field: fld, rows: (form[fld.key] || []).map((r) => ({ ...r })), ri: 0, ci: 0 }; } // full-pane env-overrides editor
        else if (fld.kind === 'readonly' && fld.hint) msg = fld.hint;
      }
      else if (k === 's') doSave();
      else if (k === 'd') { if (!form.isNew && !secOf().fixed) openDelete(form.orig); }
      else if (k === 'h' || k === '\t') focus = 'left';       // h/tab (or esc) go back to the list; ←/→ stay reserved for caret + overrides columns
      else return false;
      repaint(); return false;
    };
    const onData = (chunk) => { for (const key of splitKeys(chunk.toString())) if (handleKey(key)) return; };

    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    w('\x1b[?1049h\x1b[?25l\x1b[?7l'); // alt screen, hide cursor, no wrap
    stdin.on('data', onData); stdout.on('resize', repaint);
    repaint();
  });
}

// Add/remove a guard name on a service, keeping `guards` absent when empty.
function setServiceGuard(service, name, on) {
  const set = new Set(service.guards || []);
  if (on) set.add(name);
  else set.delete(name);
  const list = [...set];
  if (list.length) service.guards = list;
  else delete service.guards;
}

// ---------------------------------------------------------------------------
// Env overrides — per-service env vars stored in config.json `overrides` (committable, no secrets).
// Applied to a service's wired env when crew starts it (see overrideVarsFor/applyEnvOverrides).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// crew check — hand-rolled config validator (zero-dep, strict). Errors block (exit 1);
// warnings are advisory. Validates the merged config + machine-local local.json.
// ---------------------------------------------------------------------------
export function cmdCheck(flags) {
  const { cfg, userPath, localPath } = loadMerged(flags);
  const errors = [];
  const warns = [];
  const E = (m) => errors.push(m);
  const W = (m) => warns.push(m);

  // Top level.
  for (const k of Object.keys(cfg)) if (!TOP_KEYS.has(k)) W(`top-level: unknown key '${k}'`);
  if (cfg.version != null && typeof cfg.version !== 'number') E(`version must be a number`);
  if (cfg.workspaceName != null && typeof cfg.workspaceName !== 'string') E(`workspaceName must be a string`);
  if (cfg.workspaceSettings != null && !isObj(cfg.workspaceSettings)) E(`workspaceSettings must be an object`);
  if (cfg.guards != null && !isObj(cfg.guards)) E(`guards must be an object`);
  const guards = isObj(cfg.guards) ? cfg.guards : {};

  // Services.
  if (!isObj(cfg.services) || !Object.keys(cfg.services).length) {
    E(`services: at least one service is required`);
  } else {
    for (const [name, p] of Object.entries(cfg.services)) {
      const at = `service '${name}'`;
      if (!isObj(p)) {
        E(`${at}: must be an object`);
        continue;
      }
      for (const k of Object.keys(p)) if (!SERVICE_KEYS.has(k)) W(`${at}: unknown key '${k}'`);
      if (typeof p.path !== 'string' || !p.path.trim()) E(`${at}: 'path' (string) is required`);
      else
        try {
          if (!pathExists(resolveServicePath(p.path))) W(`${at}: path does not exist on disk: ${p.path}`);
        } catch (e) {
          W(`${at}: path cannot be resolved (${e.message})`);
        }
      if (p.type != null && typeof p.type !== 'string') E(`${at}: 'type' must be a string`);
      else if (typeof p.type === 'string' && !SERVICE_TYPES.includes(p.type)) W(`${at}: unusual type '${p.type}' (known: ${SERVICE_TYPES.join(', ')})`);
      if (p.runner != null && typeof p.runner !== 'string') E(`${at}: 'runner' must be a string`);
      if (p.tasks != null) {
        if (!isObj(p.tasks)) E(`${at}: 'tasks' must be an object`);
        else for (const [t, cmd] of Object.entries(p.tasks)) if (typeof cmd !== 'string') E(`${at}: task '${t}' command must be a string`);
      }
      if (p.env != null && typeof p.env !== 'string') E(`${at}: 'env' must be a string`);
      if (p.defaultBranch != null && typeof p.defaultBranch !== 'string') E(`${at}: 'defaultBranch' must be a string`);
      if (p.local != null) {
        if (typeof p.local !== 'string') E(`${at}: 'local' must be a string`);
        else if (!originOf(p.local)) E(`${at}: 'local' must be an http(s) URL (got '${p.local}')`);
      }
      if (p.match != null) {
        if (!isObj(p.match) || Array.isArray(p.match)) E(`${at}: 'match' must be an object { env: host | [hosts] }`);
        else
          for (const [env, v] of Object.entries(p.match)) {
            const hosts = Array.isArray(v) ? v : [v];
            if (!hosts.length) W(`${at}: match['${env}'] is empty`);
            for (const h of hosts) {
              if (typeof h !== 'string') { E(`${at}: match['${env}'] must be a host string or array of host strings`); continue; }
              if (/[*?]/.test(h)) W(`${at}: match '${h}' looks like a glob — matching is exact host (optionally + path)`);
              else if (h.includes('://')) W(`${at}: match '${h}' must not include a scheme — use host or host/path`);
            }
          }
      }
      if (p.guards != null) {
        if (!isStrArr(p.guards)) E(`${at}: 'guards' must be an array of strings`);
        else for (const g of p.guards) if (!guards[g]) E(`${at}: references undefined guard '${g}'`);
      }
      const usesEnvfile = [p.runner, ...Object.values(isObj(p.tasks) ? p.tasks : {})].some((s) => typeof s === 'string' && s.includes('{envfile}'));
      if (usesEnvfile && !p.env) E(`${at}: uses {envfile} but has no 'env' field`);
      if (isObj(p.match) && !Array.isArray(p.match) && Object.keys(p.match).length && !p.local) W(`${at}: has 'match' (a wiring target) but no 'local' — peers can't wire to it locally`);
    }
  }

  // Guard registry.
  for (const [name, g] of Object.entries(guards)) {
    const at = `guard '${name}'`;
    if (!isObj(g)) {
      E(`${at}: must be an object`);
      continue;
    }
    for (const k of Object.keys(g)) if (!GUARD_KEYS.has(k)) W(`${at}: unknown key '${k}'`);
    if (typeof g.command !== 'string' || !g.command.trim()) E(`${at}: 'command' (string) is required`);
    if (typeof g.comment !== 'string' || !g.comment.trim()) W(`${at}: 'comment' is required — it explains what the check verifies`);
    if (g.message != null && typeof g.message !== 'string') E(`${at}: 'message' must be a string`);
  }
  const usedGuards = new Set(Object.values(cfg.services || {}).flatMap((p) => (isObj(p) && Array.isArray(p.guards) ? p.guards : [])));
  for (const name of Object.keys(guards)) if (!usedGuards.has(name)) W(`guard '${name}' is defined but used by no service`);

  // Env overrides — validate BOTH layers: config.json (committable; warn on secret-LOOKING keys) and the
  // local.json overlay (machine-local; secrets belong here, no warn). Same shape; whenLocal is reserved.
  const projNames = new Set(Object.keys(cfg.services || {}));
  const SECRETISH = /(pass|pwd|secret|token|credential|private[_-]?key|api[_-]?key)/i;
  const checkOverrides = (src, label, warnSecret) => {
    if (src == null) return;
    if (!isObj(src)) { E(`${label} must be an object`); return; }
    const checkVar = (where, k, v) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) W(`${where}: invalid env var name '${k}'`);
      if (v === null || typeof v === 'object') W(`${where}.${k} must be a string`);
      if (warnSecret && SECRETISH.test(k)) W(`${where}.${k} looks secret — put it in local.json overrides (machine-local, gitignored), not the committable config`);
    };
    for (const [proj, vars] of Object.entries(src)) {
      if (!projNames.has(proj)) W(`${label}: unknown service '${proj}'`);
      if (!isObj(vars)) { E(`${label}['${proj}'] must be an object of VAR:value`); continue; }
      for (const [k, v] of Object.entries(vars)) {
        if (k === OVERRIDE_WHEN_LOCAL) {
          if (!isObj(v)) { E(`${label}['${proj}'].whenLocal must be an object keyed by service`); continue; }
          for (const [peer, pv] of Object.entries(v)) {
            if (!projNames.has(peer)) W(`${label}['${proj}'].whenLocal: unknown service '${peer}'`);
            if (!isObj(pv)) { E(`${label}['${proj}'].whenLocal['${peer}'] must be an object of VAR:value`); continue; }
            for (const [vk, vv] of Object.entries(pv)) checkVar(`${label}['${proj}'].whenLocal['${peer}']`, vk, vv);
          }
          continue;
        }
        checkVar(`${label}['${proj}']`, k, v);
      }
    }
  };
  const machine = loadMachine(flags);
  checkOverrides(cfg.overrides, 'overrides', true);
  checkOverrides(machine.overrides, 'local.json overrides', false);
  if (Array.isArray(machine.lastSelection)) for (const n of machine.lastSelection) if (!projNames.has(n)) W(`local.json lastSelection: unknown service '${n}'`);
  if (Array.isArray(machine.lastDebug)) for (const n of machine.lastDebug) if (!projNames.has(n)) W(`local.json lastDebug: unknown service '${n}'`);

  // Report.
  console.log(c.bold(`Checking ${tildify(userPath)}`) + (localPath ? c.dim(`  (+ ${tildify(localPath)})`) : ''));
  for (const m of errors) console.log(`  ${c.red('✗')} ${m}`);
  for (const m of warns) console.log(`  ${c.yellow('!')} ${m}`);
  if (!errors.length && !warns.length) return void console.log(`  ${c.green('✓')} no problems found`);
  const parts = [];
  if (errors.length) parts.push(c.red(`${errors.length} error${errors.length > 1 ? 's' : ''}`));
  if (warns.length) parts.push(c.yellow(`${warns.length} warning${warns.length > 1 ? 's' : ''}`));
  console.log(`\n  ${parts.join(', ')}`);
  if (errors.length) process.exitCode = 1;
}

// crew upgrade — self-update to the latest published version. npm's own output is useless here
// ("changed 1 package…" whether or not anything changed), so we hide it and compare versions
// ourselves: skip if already latest, else install silently and report old -> new (or surface
// npm's error on failure).
// The version npm actually has installed globally — the source of truth, read
// straight from the global tree. Never trust npm install's exit code for this:
// it exits 0 even when it reinstalls the same version (see cmdUpgrade).
function installedGlobalVersion(pkg) {
  const r = spawnSync('npm', ['ls', '-g', pkg, '--depth=0', '--json'], { encoding: 'utf8' });
  if (!r.stdout) return null;
  try {
    return JSON.parse(r.stdout)?.dependencies?.[pkg]?.version ?? null;
  } catch {
    return null;
  }
}

export function cmdUpgrade() {
  const pkg = PKG.name;
  const current = PKG.version;
  const view = spawnSync('npm', ['view', pkg, 'version'], { encoding: 'utf8' });
  const latest = view.status === 0 ? view.stdout.trim() : null;
  if (latest && latest === current) {
    console.log(`${c.green('✓')} already up to date ${c.dim(`(v${current})`)}`);
    return;
  }
  // Install the exact resolved version, NOT the `@latest` tag. `npm view` does a
  // fresh registry query (so `latest` is current), but `npm install <pkg>@latest`
  // resolves the tag against npm's cached packument — which can still point at the
  // old version — and then silently reinstalls it while exiting 0. Pinning
  // @<latest> forces npm to fetch the version we actually resolved.
  const spec = latest ? `${pkg}@${latest}` : `${pkg}@latest`;
  process.stdout.write(c.dim(`upgrading ${pkg} ${latest ? `v${current} → v${latest}` : `(v${current})`}… `));
  const r = spawnSync('npm', ['install', '-g', spec], { encoding: 'utf8' });
  if (r.error) {
    process.stdout.write('\n');
    fail(r.error.code === 'ENOENT' ? `'npm' not found on PATH` : `upgrade failed: ${r.error.message}`);
  }
  if (r.status !== 0) {
    process.stdout.write('\n');
    if (r.stderr) process.stderr.write(r.stderr); // surface the real npm error only on failure
    fail('upgrade failed — see npm output above');
  }
  process.stdout.write(c.green('done\n'));
  // Verify against the actual global install — npm exiting 0 does not mean the
  // version changed. If it didn't, say so plainly instead of claiming success.
  const installed = installedGlobalVersion(pkg);
  if (installed && installed === current) {
    fail(`npm reported success but ${pkg} is still v${current}. Try: npm cache clean --force && npm install -g ${spec}`);
  }
  if (installed) {
    console.log(`${c.green('✓')} upgraded ${c.dim(`v${current} → v${installed}`)}`);
  } else if (latest) {
    console.log(`${c.green('✓')} upgraded ${c.dim(`v${current} → v${latest}`)}`);
  } else {
    console.log(`${c.green('✓')} upgraded ${c.dim(`(was v${current})`)}`);
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
export function help() {
  // Minimal color: bold section headers + cyan command names. Everything else is
  // default color. Padding is computed on the plain text, so alignment holds.
  const COL = 35;
  const cmd = (name, rest, desc) => {
    const sig = rest ? `${name} ${rest}` : name;
    const left = rest ? `${c.cyan(name)} ${rest}` : c.cyan(name);
    return `  ${left}${' '.repeat(Math.max(2, COL - sig.length))}${desc}`;
  };
  const ACTIONS = [
    ['help', '', 'Show this help'],
    ['list', '', 'List services'],
    ['start', 'env=<env>', 'Pick services, wire + start them for that env'],
    ['workspace', '', 'Pick services, open one VSCode window'],
    ['claude', '[session]', 'Pick services, launch Claude Code'],
    ['graph', '[list]', 'Show the dependency graph (list = text)'],
    ['resolve', '<env> [proj…]', "Show each service's resolved env (dry-run)"],
  ];
  const CONFIG = [
    ['config', '[path]', 'Visual config editor (path = print file path)'],
    ['check', '', 'Validate the config'],
    ['pull', '<url>', 'Load config.json from a URL'],
    ['upgrade', '', 'Self-update to the latest release'],
  ];
  const FLAGS = [
    ['--config <path>', 'Use a specific config file'],
    ['-v, --version', 'Print version'],
  ];
  const L = [];
  L.push(`${c.bold('crew')} ${PKG.version} — run the slice of your stack you care about, locally + wired`);
  L.push('');
  L.push(c.bold('USAGE'));
  L.push('  crew <command> [args] [flags]');
  L.push('');
  L.push(c.bold('ACTIONS'));
  for (const [n, r, d] of ACTIONS) L.push(cmd(n, r, d));
  L.push('');
  L.push(c.bold('CONFIG'));
  for (const [n, r, d] of CONFIG) L.push(cmd(n, r, d));
  L.push('');
  L.push(c.bold('FLAGS'));
  for (const [f, d] of FLAGS) L.push(`  ${c.cyan(f)}${' '.repeat(Math.max(2, 18 - f.length))}${d}`);
  console.log(L.join('\n'));
}

// ==================== main ====================
// crew — run the slice of your local stack you care about (a selected group of services, started
// together and wired to point at each other's local ports or the rest's deployed hosts), open them
// as one VSCode workspace, or hand the set to Claude Code. Driven by one persistent config.
//
// Zero runtime dependencies — Node built-ins only, including a built-in process-group
// runner for parallel tasks. POSIX (macOS + Linux). See README for the full model.


// ---------------------------------------------------------------------------
// Arg parsing + dispatch
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const flags = {
    version: false,
    config: null,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-v' || a === '--version') flags.version = true;
    else if (a === '--config') {
      flags.config = argv[++i];
      if (flags.config == null) fail('--config requires a path');
    } else if (a.startsWith('--config=')) flags.config = a.slice('--config='.length);
    else if (a.startsWith('-') && a !== '-') fail(`unknown flag: ${a}`);
    else pos.push(a);
  }
  return { flags, pos };
}

async function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));

  if (flags.version) {
    console.log(PKG.version);
    return;
  }
  const cmd = pos[0];
  if (!cmd) {
    help();
    return;
  }
  const rest = pos.slice(1);

  switch (cmd) {
    case 'help':
      help();
      return;
    case 'list':
      cmdList(flags);
      return;
    case 'start':
      await cmdStart(flags, rest);
      return;
    case 'install':
      fail("crew install was removed — `crew start` is the only run command; a service's other tasks aren't wired to a command yet");
      return;
    case 'workspace':
      await cmdWorkspace(flags, rest);
      return;
    case 'claude':
      await cmdClaude(flags, rest);
      return;
    case 'add':
      fail('crew add was removed — create services visually: crew config  (then the "+ New service" row)');
      return;
    case 'edit':
      fail('crew edit is now `crew config` — the two-pane visual editor');
      return;
    case 'remove':
      fail('crew remove was removed — delete visually: crew config  (highlight the service, press d)');
      return;
    case 'guards':
      fail('crew guards was removed — view/edit guards in: crew config');
      return;
    case 'overrides':
      fail('crew overrides was removed — view/edit overrides in: crew config');
      return;
    case 'dir':
      fail('crew dir was removed — set the services directory in Settings: crew config');
      return;
    case 'graph':
      await cmdGraph(flags, rest);
      return;
    case 'resolve':
      cmdResolve(flags, rest);
      return;
    case 'config':
      await cmdConfig(flags, rest[0]);
      return;
    case 'check':
      cmdCheck(flags);
      return;
    case 'pull':
      await cmdPull(flags, rest[0]);
      return;
    case 'upgrade':
      cmdUpgrade();
      return;
    default:
      console.error(c.red(`crew: unknown command '${cmd}'`) + '\n');
      help();
      process.exitCode = 1;
      return;
  }
}

main().catch((err) => {
  if (err instanceof CrewError) {
    console.error(c.red(`crew: ${err.message}`));
    process.exit(1);
  }
  console.error(c.red(`crew: unexpected error: ${err && err.message ? err.message : err}`));
  process.exit(1);
});
