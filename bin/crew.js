#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';

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
  gray: wrap(90),
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
function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
// An ordered palette where each color sits ~137.5 deg (golden angle) from the previous
// one, so consecutive indices are maximally distant in hue. Vivid S/L keep it readable
// on a dark background. Index N is stable and reproducible — not random.
function rgbForIndex(i) {
  const hue = (i * 137.508) % 360;
  return hslToRgb(hue, 0.72, 0.62);
}
export function colorForIndex(i) {
  const [r, g, b] = rgbForIndex(i);
  return fgRGB(r, g, b);
}
// Assign every known project a stable rank (sorted name order) -> golden-angle color.
// Same project set always yields the same color per name, and neighbours differ sharply.
// Built once per command so list/groups/run all agree.
export function projectColors(cfg) {
  const names = Object.keys(cfg.projects || {}).sort();
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
  // Unknown placeholders are left intact (e.g. crew fills {envfile} per-project later).
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
// Machine-local projects directory; relative project paths resolve against it. Set once
// per machine via `crew dir` (stored in the user-level config, never in a committed
// ./.crew.json), so shared configs can use short relative paths like "bee-beepro-backend".
let PROJECTS_DIR = null;
// Resolve a PROJECT path: `~`/absolute is used as-is (escape hatch for repos outside the
// projects dir); anything relative resolves against PROJECTS_DIR.
export function resolveProjectPath(p) {
  const e = expandHome(String(p));
  if (isAbsolute(e)) return e;
  if (!PROJECTS_DIR)
    fail(
      `project path '${p}' is relative but no projects directory is set.\n` +
        `  Set it once: crew dir <path>   (e.g. crew dir ~/Projects)`
    );
  return resolve(PROJECTS_DIR, e);
}

// ---------------------------------------------------------------------------
// Config — user-level at ~/.config/crew/config.json, project-local ./.crew.json
// merges on top. v1 configs migrate to v2 in memory and are written back.
// ---------------------------------------------------------------------------
export const DEFAULT_LONG_RUNNING = ['start', 'dev', 'watch'];

export function defaultConfig() {
  return {
    version: 2,
    workspaceName: 'crew',
    longRunning: [...DEFAULT_LONG_RUNNING],
    projects: {},
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
// Machine-local settings (currently just projectsDir) live beside the config as
// `local.json` — never committed. This keeps config.json fully shareable; teammates set
// their own projectsDir with `crew dir`. Add `local.json` to .gitignore when committing.
export function machineConfigPath(flags) {
  return join(crewHomeFor(userConfigPath(flags)), 'local.json');
}
export function loadMachine(flags) {
  const p = machineConfigPath(flags);
  if (!pathExists(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
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
  if (typeof cfg.version !== 'number' || cfg.version < 2) {
    // v1 -> v2: a project's single `start` block becomes tasks.start.
    for (const p of Object.values(cfg.projects || {})) {
      if (p && p.start && typeof p.start === 'object') {
        p.tasks = p.tasks || {};
        if (p.start.command && p.tasks.start == null) p.tasks.start = p.start.command;
        delete p.start; // cwd/defaults/allowed dropped: v2 fills placeholders from args only
      }
    }
    cfg.version = 2;
    changed = true;
  }
  if (!Array.isArray(cfg.longRunning)) {
    cfg.longRunning = [...DEFAULT_LONG_RUNNING];
    changed = true;
  }
  if (!cfg.projects) {
    cfg.projects = {};
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
  // Rename the short-lived `checks` feature to `guards` (top-level registry + per-project).
  if (cfg.checks && typeof cfg.checks === 'object') {
    cfg.guards = { ...cfg.checks, ...(cfg.guards || {}) };
    delete cfg.checks;
    changed = true;
  }
  for (const p of Object.values(cfg.projects || {})) {
    if (p && Array.isArray(p.checks) && !p.guards) {
      p.guards = p.checks;
      changed = true;
    }
  }
  // Self-heal: drop fields removed in later versions so a config edited by an older crew
  // gets cleaned up (and written back) the first time a newer crew loads it.
  const DEPRECATED_PROJECT_FIELDS = ['relatedDirs', 'cwd', 'start', 'checks'];
  for (const p of Object.values(cfg.projects || {})) {
    for (const dead of DEPRECATED_PROJECT_FIELDS) {
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
  // projectsDir is machine-local: it belongs in local.json, not the committable config.
  // Migrate any legacy value out of config.json into local.json so config.json stays
  // shareable.
  const machine = loadMachine(flags);
  let projectsDir = machine.projectsDir;
  if (cfg.projectsDir) {
    if (!projectsDir) {
      projectsDir = cfg.projectsDir;
      try {
        writeMachine(flags, { ...machine, projectsDir });
      } catch {
        /* read-only fs */
      }
    }
    delete cfg.projectsDir;
    changed = true;
  }
  if (changed) {
    try {
      writeUserConfig(path, cfg);
    } catch {
      /* read-only fs — proceed with the in-memory migration */
    }
  }
  PROJECTS_DIR = projectsDir ? resolvePath(projectsDir) : null;
  return { path, cfg, existed: true };
}

export function writeUserConfig(path, cfg) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
}

// Merge project-local ./.crew.json on top of the user config (read-only overlay).
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
      fail(`project-local config is not valid JSON: ${localPath}`);
    }
    if (local.workspaceName) merged.workspaceName = local.workspaceName;
    if (Array.isArray(local.longRunning)) merged.longRunning = local.longRunning;
    Object.assign(merged.projects, local.projects || {});
    merged.guards = { ...(merged.guards || {}), ...(local.guards || {}) };
    localUsed = localPath;
  }
  return { cfg: merged, userPath: path, localPath: localUsed };
}

// ---------------------------------------------------------------------------
// Selection helpers — resolve names to members, remember the last picked set.
// ---------------------------------------------------------------------------
export function membersFor(cfg, names) {
  const known = Object.keys(cfg.projects || {});
  const missing = names.filter((n) => !cfg.projects[n]);
  if (missing.length)
    fail(
      `unknown project(s): ${missing.join(', ')}.\n` +
        `  projects: ${known.join(', ') || '(none) — run: crew add'}`
    );
  return names.map((n) => ({ name: n, project: cfg.projects[n] }));
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

// Log-viewer filter memory: we persist the HIDDEN names (global, machine-local), not the shown
// ones — so a project/guard absent from a later run is simply ignored and anything NEW defaults
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

export const PROJECT_TYPES = ['frontend', 'backend', 'fullstack', 'other'];

// ---------------------------------------------------------------------------
// Config-validation key sets (used by `crew check`).
// ---------------------------------------------------------------------------
export const TOP_KEYS = new Set(['version', 'workspaceName', 'longRunning', 'workspaceSettings', 'internalDomains', 'projects', 'guards']);
export const PROJECT_KEYS = new Set(['path', 'type', 'runner', 'env', 'local', 'match', 'envMap', 'tasks', 'guards', 'defaultBranch']);
export const GUARD_KEYS = new Set(['comment', 'command', 'message']);
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

// ==================== wiring ====================
// Directed dependency edges among the given [name, project] entries: name -> Set(peer).
// Same rule as `crew graph` (exact hostname match).
export function dependencyEdges(cfg, entries) {
  const meta = {};
  for (const [name, project] of entries) {
    let dir;
    try {
      dir = resolveProjectPath(project.path);
    } catch {
      dir = null;
    }
    meta[name] = { files: dir ? envFilesFor(dir) : [], ...projectIdentity(project) };
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
      if (best && best !== name) edges.get(name).add(best);
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
  const valid = names.filter((n) => cfg.projects[n]);
  if (valid.length < 2) return verbose ? c.dim('  select 2+ projects to check local wiring') : '';
  const comps = componentsFrom(edges, valid);
  if (comps.length <= 1)
    return verbose ? '  ' + c.green('✓') + c.dim(' connected') : '';
  const paint = projectColors(cfg);
  const islands = comps
    .sort((a, b) => b.length - a.length)
    .map((comp) => comp.map((n) => paint.get(n)(n)).join(c.dim('·')))
    .join(c.dim('  |  '));
  return '  ' + c.yellow('⚠ not connected:') + ' ' + islands;
}

// Verify every member's path exists. Names the offending project.
export function validateMemberPaths(members) {
  for (const m of members) {
    const p = resolveProjectPath(m.project.path);
    if (!pathExists(p)) fail(`project '${m.name}': path not found: ${p}`);
  }
}

// Build a deduped absolute-path list of member project paths, first-seen order.
export function dirList(members) {
  const seen = new Set();
  const out = [];
  for (const m of members) {
    const abs = resolveProjectPath(m.project.path);
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

export function projectDir(project) {
  return resolveProjectPath(project.path);
}

// ---------------------------------------------------------------------------
// Task resolution — tasks[task] -> runner{task} -> skip. Strict placeholders.
// ---------------------------------------------------------------------------
export function resolveRun(cfg, task, members, args) {
  const runnable = [];
  const skipped = [];
  for (const m of members) {
    let template;
    if (m.project.tasks && m.project.tasks[task] != null) template = m.project.tasks[task];
    else if (m.project.runner) template = m.project.runner;
    else {
      skipped.push(m.name);
      continue;
    }
    runnable.push({ name: m.name, project: m.project, template });
  }
  if (runnable.length === 0)
    fail(`no project in target can run task '${task}' (all run-less for this task)`);

  // Reserved placeholders crew fills itself (not from user args): {task} = the task name;
  // {envfile} = the per-project wired env file crew materializes at start (see cmdRun).
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

  // Unknown key=value (matches no placeholder in the target): warn and skip, don't abort
  // — lets `crew start backend env=local` run even though backend has no {env}.
  const unknown = Object.keys(keyVals).filter((k) => !union.has(k));
  if (unknown.length)
    warn(
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

  // Per-project value set: {env} may be remapped by the project's `envMap` (e.g. a
  // dependency consumed at a fixed env — RGE at pre/qa talks to SDK@qa). Everything else
  // is shared. Strict-check and substitution then run against the per-project values.
  const unresolved = new Set();
  for (const r of runnable) {
    const env = mappedEnv(r.project, values.env);
    r._values = env === undefined ? { ...values } : { ...values, env };
    for (const p of placeholdersIn(r.template))
      if (!RESERVED.has(p) && !(p in r._values)) unresolved.add(p);
    if (r.project.env)
      for (const p of placeholdersIn(r.project.env))
        if (!RESERVED.has(p) && !(p in r._values)) unresolved.add(p);
  }
  if (unresolved.size)
    fail(
      `unresolved placeholder(s): ${[...unresolved].join(', ')}. ` +
        `Provide as a positional or key=value.`
    );

  for (const r of runnable) {
    r.resolved = substitute(r.template, r._values); // {envfile} left intact for cmdRun
    // Resolve the base env-file path (if declared) with the same values — raw (no shell
    // quoting): it's a filesystem path crew reads, not a shell token.
    r.envFile = r.project.env
      ? r.project.env.replace(PLACEHOLDER_RE, (m, k) => (k in r._values ? r._values[k] : m))
      : null;
  }
  return { runnable, skipped };
}

// Remap the selection env `g` for a project via its optional `envMap` (a lookup from the
// selection env to the env this project should actually run at; `default` is the fallback).
// No envMap, or no matching entry/default -> `g` unchanged. Keeps crew agnostic: it's a
// plain per-project table, no knowledge of which services map where.
export function mappedEnv(project, g) {
  const m = project && project.envMap;
  if (m && typeof m === 'object') {
    if (g != null && g in m) return m[g];
    if ('default' in m) return m.default;
  }
  return g;
}

// Scan <dir>/.envs, parse each file's name as <env>[-<slug>] (slug optional; some projects
// name files plainly, e.g. `pre`, `qa`). Returns [{env, slug, path}].
export function envFilesFor(dir) {
  const envsDir = join(dir, '.envs');
  let names = [];
  try {
    names = readdirSync(envsDir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
  return names.map((name) => {
    const base = name.replace(/\.env$/, '');
    const dash = base.indexOf('-');
    const env = dash > 0 ? base.slice(0, dash) : base;
    const slug = dash > 0 ? base.slice(dash + 1) : '';
    return { env, slug, path: join(envsDir, name) };
  });
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
// A match token is a COMPLETE hostname (perfect string match) — no globs, no paths. It
// matches a URL when the URL's host equals it (case-insensitive). Exact strings mean no
// cross-service collisions: `api.getbee.io` matches only that host, never `rge-api.getbee.io`.
// List every host a service is reached by, including env variants (qa-…, pre-…). Returns the
// token length on match (0 otherwise) — the length keeps the "most specific wins" caller API,
// though exact matching makes overlaps impossible in practice.
export function tokenMatchLen(host, path, tok) {
  tok = String(tok).toLowerCase();
  return tok && tok === host ? tok.length : 0;
}

// The scheme://host[:port] prefix of a URL (drops path/query/fragment). '' if not a URL.
export function originOf(url) {
  const m = String(url).match(/^https?:\/\/[^/?#\s]+/i);
  return m ? m[0] : '';
}
// Rewrite env-file text for local wiring: every URL whose host/path matches a co-running
// peer's tokens has its origin swapped to that peer's local origin (path/query preserved).
// Most-specific token wins (gateway paths). Peers absent from `peers` stay remote. `peers`
// = [{ tokens, origin }]. Format-preserving — only URL origins change.
export function wireText(text, peers) {
  return text.replace(URL_RE, (url) => {
    const p = urlHostPath(url);
    if (!p) return url;
    let best = null;
    let bestLen = 0;
    for (const peer of peers)
      for (const tok of peer.tokens) {
        const len = tokenMatchLen(p.host, p.path, tok);
        if (len > bestLen) {
          bestLen = len;
          best = peer;
        }
      }
    if (!best) return url;
    const o = originOf(url);
    return o ? best.origin + url.slice(o.length) : url;
  });
}

// Local-wiring env overrides (machine-local, from local.json `overrides`). When crew starts a
// project locally it materializes a wired env for it; `overrides["<project>"]` upserts extra
// `KEY=value` lines into that env. Two forms:
//   - bare `VAR: val`  — applied whenever the project runs (e.g. a Temporal queue so your local
//     worker consumes `foo-local` not shared `foo`);
//   - `whenLocal: { "<peer>": { VAR: val } }` — applied ONLY when that peer is also being started
//     (e.g. point a URL at a local dependency's exact host+path, but only while it's up).
// `whenLocal` beats bare (applied last). `running` = names of all projects being started.
// Secrets/personal values live in local.json (untracked), never in the shared config. Overrides
// beat the base env file and the URL swap.
export const OVERRIDE_WHEN_LOCAL = 'whenLocal';
export function overrideVarsFor(overrides, name, running) {
  const o = overrides && overrides[name];
  if (!o || typeof o !== 'object') return {};
  const vars = {};
  for (const [k, v] of Object.entries(o)) if (k !== OVERRIDE_WHEN_LOCAL) vars[k] = v;
  const wl = o[OVERRIDE_WHEN_LOCAL];
  if (wl && typeof wl === 'object') for (const peer of running || []) if (wl[peer] && typeof wl[peer] === 'object') Object.assign(vars, wl[peer]);
  return vars;
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
  let out = text;
  for (const [k, v] of Object.entries(vars || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      warn(`override: skipping invalid env var name '${k}'`);
      continue;
    }
    if (v === null || typeof v === 'object') {
      warn(`override: '${k}' must be a string value — got ${Array.isArray(v) ? 'array' : typeof v}`);
      continue;
    }
    const line = `${k}=${envOverrideValue(v)}`;
    const re = new RegExp(`^([ \\t]*(?:export[ \\t]+)?)${k}=.*$`, 'm');
    if (re.test(out)) out = out.replace(re, (_m, pre) => pre + line);
    else out += (out === '' || out.endsWith('\n') ? '' : '\n') + line + '\n';
    applied.push(k);
  }
  return { text: out, applied };
}

// crew graph identity: a project's id comes ONLY from config `match` (complete hostnames,
// exact string match). No `match` = no id, so nothing can point at it.
export function projectIdentity(project) {
  const tokens = Array.isArray(project.match) ? project.match.filter(Boolean) : [];
  return { tokens, source: tokens.length ? 'match' : 'none' };
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

    let prevLines = 0; // lines drawn last render (items + footer), for cursor rewind
    const render = (first) => {
      if (!first) {
        out.write(`\x1b[${prevLines}A`); // back to the top of the block
        out.write('\x1b[0J'); // erase it (items + any stale footer)
      }
      let lines = 0;
      items.forEach((it, i) => {
        const cursor = i === idx;
        const ptr = cursor ? c.cyan('❯ ') : '  ';
        const box = multi ? (checked.has(it) ? c.green('◉ ') : '◯ ') : '';
        out.write(`${ptr}${box}${label(it, cursor)}\n`);
        lines++;
      });
      if (footer) {
        const f = footer(multi ? order : items[idx]);
        if (f) for (const fl of f.split('\n')) (out.write(fl + '\n'), lines++);
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
      } else if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup();
        resolve(null);
      }
    };
    stdin.on('keypress', onKey);
  });
}

// Unified prompter. On a TTY: text fields are inline-EDITABLE (the current value is
// prefilled at the cursor — edit it, or clear it to unset), and enumerable choices use
// the arrow menu. Over a pipe (scripts/tests): fall back to typed lines where a blank
// keeps the prefilled default. `close()` only matters for the piped path.
export function makePrompter() {
  if (canInteractive()) {
    const ask = (labelText, prefill = '') =>
      new Promise((resolve) => {
        const rl = createInterface({ input, output });
        const p = rl.question(`${labelText}: `);
        if (prefill) rl.write(prefill);
        p.then((a) => {
          rl.close();
          resolve(a.trim());
        });
      });
    const select = async (labelText, options, current) => {
      const r = await menu({
        title: labelText,
        items: options,
        label: (o, cur) => (cur ? c.bold(o) : o),
        start: Math.max(0, options.indexOf(current)),
      });
      return r == null ? (current ?? options[0]) : r;
    };
    const multiselect = async (labelText, options, preselected = []) => {
      const r = await menu({
        title: labelText,
        items: options,
        label: (o, cur) => (cur ? c.bold(o) : o),
        multi: true,
        preselected,
      });
      return r == null ? preselected : r;
    };
    return { ask, select, multiselect, close: () => {} };
  }

  // Piped / non-interactive: one readline, line-queue (question() is unreliable here).
  const rl = createInterface({ input, output });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => (waiters.length ? waiters.shift()(line) : queue.push(line)));
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  const readLine = () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : closed
        ? Promise.resolve(null)
        : new Promise((res) => waiters.push(res));
  const ask = async (labelText, prefill = '') => {
    output.write(`${labelText}${prefill ? ` [${prefill}]` : ''}: `);
    const line = await readLine();
    if (line == null) return prefill;
    const a = line.trim();
    return a === '' ? prefill : a;
  };
  const select = async (labelText, options, current) => {
    output.write(`${labelText} (${options.join('/')})${current ? ` [${current}]` : ''}: `);
    const line = await readLine();
    const v = (line || '').trim();
    return v || current || options[0];
  };
  const multiselect = async (labelText, options, preselected = []) => {
    output.write(`${labelText} (space/comma separated)${preselected.length ? ` [${preselected.join(' ')}]` : ''}: `);
    const line = await readLine();
    const v = (line || '').trim();
    return v ? v.split(/[\s,]+/).filter(Boolean) : preselected;
  };
  return { ask, select, multiselect, close: () => rl.close() };
}

export async function confirm(question) {
  const { ask, close } = makePrompter();
  try {
    const a = await ask(`${question} (y/N)`, '');
    return /^y/i.test(a);
  } finally {
    close();
  }
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

export function runFanout(commands, { killOthers, announceExits, interactive = false, guardSeed = [], hidden = [], saveHidden = () => {}, logWrap = true, saveWrap = () => {} }) {
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

    let menuOpen = false; // reentrancy guard for the key handler
    let detachKeys = () => {};
    // Interactive log viewer (created below when streamed to a TTY): keeps a tagged line
    // history and repaints a filtered view, so hiding every project clears the screen. It owns
    // an alternate screen while running. null = plain prefixed streaming (piped / CI).
    let viewer = null;
    const LOG_HISTORY = Number(process.env.CREW_LOG_HISTORY) || 5000;

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
      // Final sweep: SIGKILL each project's process group to reap stragglers that
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
        // press q/Esc to leave. Otherwise (piped, or a user-requested stop) settle immediately.
        if (interactive && !stopRequested) {
          allStopped = true;
          viewerRepaint();
        } else settle();
      }
    };

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
      child.stdout.on('data', (b) => emit(child, b.toString('utf8')));
      child.stderr.on('data', (b) => emit(child, b.toString('utf8')));
      child.on('error', (err) => {
        note(child, c.red(`failed to start: ${err.message}`));
        finish(child, 1);
      });
      child.on('close', (code, signal) => finish(child, code ?? signal));
    }

    // Interactive log viewer (streamed mode on a TTY): a full-screen pager on the alternate
    // screen showing the SELECTED projects' history, scrollable (keyboard + mouse wheel) with a
    // wrap/cut toggle and a pinned footer. Mouse is captured (SGR) so the wheel scrolls OUR
    // viewport, not the shell — so during the run you only ever see logs. On exit we leave the
    // alternate screen and dump the full history to the terminal, so the logs persist in
    // scrollback. Keys route through requestStop() since raw mode swallows SIGINT. No-op when
    // piped/CI (viewer stays null; output streams with prefixes).
    if (interactive && live.size) {
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      if (stdin.setRawMode) stdin.setRawMode(true);
      stdin.resume();
      // Guards appear as pseudo-projects (`[vpn]`/`[aws]`) — filterable rows seeded at the top of
      // the history. Their names join the project names in the filter list + hidden memory.
      const guardProcs = new Map(guardSeed.map((g) => [g.name, { _name: g.name, _color: (s) => c.gray(s) }]));
      const names = [...commands.map((cmd) => cmd.name), ...guardSeed.map((g) => g.name)];
      const history = []; // { proc, text } complete lines (capped at LOG_HISTORY)
      const pending = new Map(); // proc -> partial line not yet terminated
      const shown = new Set(names.filter((n) => !hidden.includes(n))); // persisted hidden applied
      for (const g of guardSeed) history.push({ proc: guardProcs.get(g.name), text: `${c.green('✓')} ${g.comment || 'passed'}` });
      let wrap = logWrap; // wrap long lines vs cut them to one row (persisted preference)
      let scroll = 0; // screen-rows scrolled up from the live bottom (0 = follow tail)
      let active = true; // false while the filter picker owns the screen
      let dirty = false;
      let searching = false; // true while typing a search query
      let query = ''; // active substring filter over rows ('' = off)

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
      // A history row is visible when its project is shown AND (no search, or the LOG TEXT
      // matches — search is content-only; project names are filtered via `f`, not `/`).
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
          if (!matches(h.proc, h.text)) continue;
          const line = prefixFor(h.proc) + h.text;
          if (wrap) for (const rr of splitRows(line, w)) out.push(rr);
          else out.push(cutRow(line, w));
        }
        return out;
      };
      const footerText = () => {
        if (searching) return c.dim('search: ') + query + c.cyan('▌') + c.dim('   (Enter apply · Esc clear)');
        if (allStopped) return c.red('■ all processes exited') + c.dim(' — scroll to review · [/] search · [q/esc] exit');
        const pos = scroll > 0 ? c.yellow(`  ↑${scroll}`) : '';
        // Count goes RED when anything is hidden, so a suppressed project/guard is always obvious.
        const nShown = `${shown.size}/${names.length}`;
        const count = shown.size < names.length ? c.red(nShown) : c.dim(nShown);
        const q = query ? c.cyan(`  /${query}`) : '';
        return c.dim('crew: [f] filter (') + count + c.dim(`)  [/] search  [w] ${wrap ? 'cut' : 'wrap'}  [q/esc] stop`) + q + pos;
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
      const scrollBy = (d) => {
        const H = Math.max(1, rows() - 1);
        const maxScroll = Math.max(0, screenRows().length - H);
        scroll = Math.min(maxScroll, Math.max(0, scroll + d));
        paint();
      };

      viewer = {
        feed(proc, text) {
          const parts = ((pending.get(proc) || '') + text).split('\n');
          pending.set(proc, parts.pop()); // trailing element is the incomplete remainder
          let added = 0;
          for (const line of parts) {
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
        if (menuOpen || !live.size) return;
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
        // Quit on q, Ctrl-C, or a bare ESC. (Arrow/PgUp keys are longer sequences like `\x1b[A`,
        // so `s === '\x1b'` matches only a lone Escape.) In search mode ESC clears instead (above).
        if (s === '\x03' || s === 'q' || s === '\x1b') return requestStop();
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

    if (live.size === 0) settle();
  });
}

// ---------------------------------------------------------------------------
// Guards — named shell probes a project can require (VPN up, AWS logged in, …). crew is
// agnostic: a guard passes iff its command exits 0. Deduped by name across the target, so
// a guard shared by several projects runs once. Any failure prints its message and aborts
// before anything starts.
// ---------------------------------------------------------------------------
// Runs the target's guards (deduped). Any failure prints + aborts. On success returns
// [{ name, comment }] so the caller can seed them into the log viewer. `quiet` suppresses the
// success print (the viewer will show the guards instead); failures always print.
export async function runGuards(cfg, members, { quiet = false } = {}) {
  const registry = cfg.guards || {};
  const names = [];
  const seen = new Set();
  for (const m of members)
    for (const gn of m.project.guards || [])
      if (!seen.has(gn)) {
        seen.add(gn);
        names.push(gn);
      }
  if (!names.length) return [];

  const undef = names.filter((n) => !registry[n] || !registry[n].command);
  if (undef.length)
    fail(`undefined guard(s): ${undef.join(', ')}. Define them with: crew guards add`);

  const results = await Promise.all(
    names.map(
      (n) =>
        new Promise((res) => {
          const child = spawn('/bin/sh', ['-c', registry[n].command], { stdio: 'ignore' });
          child.on('error', () => res({ n, ok: false }));
          child.on('close', (code) => res({ n, ok: code === 0 }));
        })
    )
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(c.dim('guards:'));
    for (const r of results) {
      const note = registry[r.n].comment ? '  ' + faint(registry[r.n].comment) : '';
      if (r.ok) console.log(`  ${c.green('✓')} ${r.n}${note}`);
      else {
        console.log(`  ${c.red('✗')} ${r.n}${note}`);
        console.log(`      ${c.red(registry[r.n].message || 'guard failed')}`);
      }
    }
    fail(`${failed.length > 1 ? 'guards' : 'guard'} failed — nothing started.`);
  }
  if (!quiet) {
    console.log(c.dim('guards:'));
    for (const r of results) console.log(`  ${c.green('✓')} ${r.n}${registry[r.n].comment ? '  ' + faint(registry[r.n].comment) : ''}`);
  }
  return results.map((r) => ({ name: r.n, comment: registry[r.n].comment || '' }));
}

// Local service wiring: for each runnable whose command uses {envfile}, load its base env
// (project.env), rewrite any URL pointing at a CO-RUNNING peer to that peer's `local`
// origin, and materialize a FRESH temp file per run (stateless — regenerated every start,
// deleted on teardown). {envfile} in the command is replaced with the temp path. Peers not
// in the running set (or without a `local`) stay remote.
export function wireRun(userPath, runnable, members, { overrides = {} }) {
  const peers = members
    .filter((m) => m.project.local)
    .map((m) => ({ name: m.name, tokens: projectIdentity(m.project).tokens, origin: originOf(m.project.local) || m.project.local }));
  const tmpDir = join(crewHomeFor(userPath), 'tmp');
  const tempPaths = [];
  // Trigger set for `whenLocal` overrides: every project being started (self included).
  const running = runnable.map((r) => r.name);
  for (const r of runnable) {
    if (!r.resolved.includes('{envfile}')) continue;
    if (!r.envFile) fail(`project '${r.name}' uses {envfile} but has no "env" field in config`);
    const basePath = resolve(projectDir(r.project), r.envFile);
    if (!pathExists(basePath)) fail(`project '${r.name}': env file not found: ${basePath}`);
    const myPeers = peers.filter((p) => p.name !== r.name);
    const overrideVars = overrideVarsFor(overrides, r.name, running);
    let baseText = '';
    try {
      baseText = readFileSync(basePath, 'utf8');
    } catch (e) {
      fail(`project '${r.name}': cannot read env file ${basePath}: ${e.message}`);
    }
    mkdirSync(tmpDir, { recursive: true });
    const out = join(tmpDir, `${sanitize(r.name)}.env`);
    writeFileSync(out, applyEnvOverrides(wireText(baseText, myPeers), overrideVars).text);
    tempPaths.push(out);
    r.resolved = r.resolved.replace(/\{envfile\}/g, shellQuote(out));
  }
  return { cleanup: () => tempPaths.forEach((p) => { try { unlinkSync(p); } catch {} }) };
}

// ==================== selection ====================
// ---------------------------------------------------------------------------
// Selection — a set of projects chosen per-run, picked interactively (preselected with the
// last selection). No groups; the remembered selection replaces them.
// ---------------------------------------------------------------------------
// Open the multiselect picker (preselected with the remembered selection) and return the
// chosen members, or null if cancelled / nothing chosen. Selection is ALWAYS interactive —
// projects are never named on the CLI. Persists the chosen set globally. opts.connectivity
// adds the live wiring-connectivity footer (for co-running sets).
export async function selectMembers(flags, cfg, opts = {}) {
  const known = Object.keys(cfg.projects || {});
  if (!known.length) fail('no projects configured yet — run: crew add');
  if (!canInteractive()) fail('crew needs an interactive terminal to pick projects');
  const paint = projectColors(cfg);
  // Precompute the graph once so the live footer is a pure in-memory lookup per keypress.
  const edges = opts.connectivity ? dependencyEdges(cfg, Object.entries(cfg.projects)) : null;
  const picked = await menu({
    title: 'Select projects',
    items: known,
    multi: true,
    preselected: loadLastSelection(flags).filter((n) => cfg.projects[n]),
    label: (o, cur) => (cur ? c.bold(paint.get(o)(o)) : paint.get(o)(o)),
    footer: edges ? (sel) => connectivityStatus(cfg, edges, sel, true) : null,
    erase: true, // don't leave the picker + its connectivity footer in scrollback
  });
  if (!picked || !picked.length) {
    console.log(c.dim('nothing selected'));
    return null;
  }
  saveLastSelection(flags, picked);
  return membersFor(cfg, picked);
}

// ==================== commands ====================
// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
export async function cmdRun(flags, task, rest) {
  const { cfg, userPath } = loadMerged(flags);
  // Only key=value placeholder args are consumed; projects are chosen in the picker.
  const args = rest.filter((a) => a.includes('='));
  const bare = rest.filter((a) => !a.includes('='));
  if (bare.length) warn(`ignoring '${bare.join(' ')}' — projects are chosen in the picker`);
  const isLong = (cfg.longRunning || []).includes(task);
  // For a co-running local set the picker shows a live wiring-connectivity footer.
  const members = await selectMembers(flags, cfg, { connectivity: isLong });
  if (!members) return;
  validateMemberPaths(members);

  const { runnable, skipped } = resolveRun(cfg, task, members, args);
  for (const s of skipped) console.log(`skipping ${s} (no task '${task}')`);

  // Materialize wired env files (fills {envfile}); fresh per run, cleaned up after.
  // Env overrides come from local.json (machine-local, untracked) so secrets never hit the config.
  const overrides = loadMachine(flags).overrides || {};
  const { cleanup } = wireRun(userPath, runnable, members, { overrides });

  const cmds = runnable.map((r) => `cd ${shellQuote(projectDir(r.project))} && ${r.resolved}`);

  const interactive = isLong && process.stdin.isTTY && process.stdout.isTTY;
  // Guards gate the run. On the interactive path stay quiet (the viewer shows them as rows,
  // and its alternate screen would wipe a printed block anyway); elsewhere print the ✓ block.
  const guardSeed = await runGuards(cfg, runnable, { quiet: interactive });

  const paint = projectColors(cfg); // same per-project colors as `crew list`
  const commands = runnable.map((r, i) => ({
    command: cmds[i],
    name: r.name,
    color: paint.get(r.name) || ((s) => s),
  }));

  if (isLong) {
    // LONG-RUNNING: stream; the first exit (any) tears the whole group down; Ctrl-C too.
    // On a TTY, enable the interactive scrollable log viewer (no-op when piped/CI). Guards are
    // seeded as [name] rows; the hidden-log filter is remembered globally in local.json.
    const results = await runFanout(commands, {
      killOthers: true,
      announceExits: true,
      interactive,
      guardSeed,
      hidden: loadHiddenLog(flags),
      saveHidden: (h) => saveHiddenLog(flags, h),
      logWrap: loadLogWrap(flags),
      saveWrap: (w) => saveLogWrap(flags, w),
    });
    cleanup(); // remove the wired temp env files
    process.exit(exitCodeFromEvents(results));
  } else {
    // RUN-TO-COMPLETION: wait for all (no kill-others), then a pass/fail summary.
    const results = await runFanout(commands, { killOthers: false, announceExits: false });
    cleanup();
    console.log(`\ncrew: task '${task}' results`);
    const byName = new Map(results.map((e) => [e.name, e.exitCode]));
    let anyFailed = false;
    for (const r of runnable) {
      const code = byName.has(r.name) ? byName.get(r.name) : '?';
      const passed = code === 0;
      if (!passed) anyFailed = true;
      console.log(`  ${passed ? c.green('✓') : c.red('✗')} ${r.name} (exit ${code})`);
    }
    process.exit(anyFailed ? 1 : 0);
  }
}

// A stable id for a selection: sorted member names joined — same set => same id regardless
// of pick order, so workspace files / claude sessions stay tied to the set, not the order.
function selectionLabel(members) {
  return sanitize(members.map((m) => m.name).sort().join('+')) || 'selection';
}

export async function cmdWorkspace(flags, rest) {
  const { cfg, userPath } = loadMerged(flags);
  if (rest.length) warn(`ignoring '${rest.join(' ')}' — projects are chosen in the picker`);
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
  const { cfg, userPath } = loadMerged(flags);
  // Optional first bare arg = a session name for the chat history (always kept under crew's
  // sessions dir). Omitted => a stable name auto-derived from the selected projects.
  const session = rest.filter((a) => !a.includes('='))[0];
  const members = await selectMembers(flags, cfg);
  if (!members) return;
  validateMemberPaths(members);
  const dirs = dirList(members);

  // Claude Code keys its history off the cwd path (~/.claude/projects/<cwd-slug>/), so a
  // fixed, crew-owned cwd keeps history tied to the session name — not any single project's
  // dir. All projects stay reachable via the --add-dir list below.
  const cwd = join(crewHomeFor(userPath), 'sessions', session ? sanitize(session) : selectionLabel(members));
  mkdirSync(cwd, { recursive: true });

  const cliArgs = [];
  for (const d of dirs) cliArgs.push('--add-dir', d);
  launch('claude', cliArgs, { cwd });
}

export function cmdList(flags) {
  const { cfg, localPath } = loadMerged(flags);
  const projects = Object.entries(cfg.projects || {});
  const longRunning = new Set(cfg.longRunning || []);
  const paint = projectColors(cfg);
  if (projects.length === 0) {
    console.log(c.dim('No projects configured yet.'));
    console.log(`Run ${c.cyan('crew add')} to add one.`);
    return;
  }

  // --- Projects -------------------------------------------------------------
  console.log(c.bold(c.underline('Projects')));
  if (projects.length === 0) console.log(c.dim('  (none)'));
  const nameW = Math.max(0, ...projects.map(([n]) => n.length));
  const typeW = Math.max(0, ...projects.map(([, p]) => (p.type || 'other').length));
  for (const [name, p] of projects) {
    // Tolerant of an unset projects dir: show the raw relative path instead of crashing.
    let abs = null;
    try {
      abs = resolveProjectPath(p.path);
    } catch {
      abs = null;
    }
    const ok = abs ? pathExists(abs) : false;
    const dot = ok ? c.green('●') : c.red('●');
    const type = p.type || 'other';
    const nameCell = c.bold(paint.get(name)(name.padEnd(nameW)));
    const typeCell = c.dim(type.padEnd(typeW));
    const shown = abs ? tildify(abs) : `${p.path}  ${c.dim('(set projects dir: crew dir)')}`;
    const pathCell = ok ? c.dim(shown) : c.red(shown + (abs ? '  ✗ missing' : ''));
    console.log(`  ${dot} ${nameCell}  ${typeCell}  ${pathCell}`);

    const taskEntries = Object.entries(p.tasks || {});
    const labels = [p.runner ? 'runner' : null, ...taskEntries.map(([t]) => t)].filter(Boolean);
    const labelW = Math.max(6, ...labels.map((s) => s.length));
    if (p.runner) console.log(`      ${c.dim('runner'.padEnd(labelW + 2))}${p.runner}`);
    for (const [t, cmd] of taskEntries) {
      const kind = longRunning.has(t) ? c.yellow('service') : c.green('task');
      console.log(`      ${c.dim(t.padEnd(labelW + 2))}${cmd}  ${c.dim('[')}${kind}${c.dim(']')}`);
    }
    if (!p.runner && taskEntries.length === 0) console.log(`      ${c.dim('(run-less)')}`);
    if (p.guards && p.guards.length)
      console.log(`      ${c.dim('guards'.padEnd(labelW + 2))}${p.guards.join(', ')}`);
    if (p.defaultBranch) console.log(`      ${c.dim('branch'.padEnd(labelW + 2))}${p.defaultBranch}`);
  }

  // --- Footer ---------------------------------------------------------------
  const last = loadLastSelection(flags).filter((n) => cfg.projects[n]);
  if (last.length)
    console.log('\n' + c.dim('last selection  ') + last.map((n) => paint.get(n)(n)).join(c.dim(', ')));
  const lr = (cfg.longRunning || []).map((t) => c.yellow(t)).join(c.dim(', ')) || c.dim('(none)');
  console.log((last.length ? '' : '\n') + c.dim('long-running  ') + lr);
  console.log(
    c.dim('config        ') +
      c.dim(tildify(userConfigPath(flags))) +
      (localPath ? c.dim(`  (+ ${tildify(localPath)})`) : '')
  );
}

// crew dir [path] — show or set the machine-local projects directory. Stored in
// local.json (beside the config, never committed); relative project paths resolve against
// it, so config.json can use short relative paths and be committed & shared.
export function cmdDir(flags, arg) {
  loadUserConfig(flags); // migrate any legacy projectsDir out of config.json into local.json
  const machinePath = machineConfigPath(flags);
  const machine = loadMachine(flags);
  if (arg == null) {
    if (machine.projectsDir) {
      console.log(`${c.bold('projects dir')}  ${tildify(resolvePath(machine.projectsDir))}`);
      console.log(c.dim(`stored in ${tildify(machinePath)} (machine-local, not committed)`));
    } else {
      console.log(c.dim('No projects directory set.'));
      console.log(`Set it: ${c.cyan('crew dir <path>')}  (e.g. crew dir ~/Projects)`);
    }
    return;
  }
  const abs = resolvePath(arg);
  let st = null;
  try {
    st = statSync(abs);
  } catch {
    /* missing */
  }
  if (!st || !st.isDirectory()) fail(`not a directory: ${abs}`);
  machine.projectsDir = arg; // keep the user's form (e.g. ~/Projects)
  writeMachine(flags, machine);
  loadUserConfig(flags); // strips any legacy projectsDir out of the committable config
  console.log(`Set projects dir → ${tildify(abs)}`);
  console.log(c.dim(`stored in ${tildify(machinePath)} — machine-local, not committed`));
}

// crew graph [target] — read-only dependency graph derived from env files (no wiring).
// Each project's id comes ONLY from config `match` (complete hostnames, exact string match);
// edge P→T when a URL in P's envs has a host equal to one of T's match hosts (tokenMatchLen).
// Optional config `internalDomains: [..]` only affects the cosmetic "other hosts" list.
// localhost URLs match no id, so they drop out.
export function cmdGraph(flags) {
  const { cfg } = loadMerged(flags);
  const paint = projectColors(cfg);
  const projects = Object.entries(cfg.projects || {});
  const domains = Array.isArray(cfg.internalDomains) ? cfg.internalDomains : [];

  const meta = {};
  for (const [name, project] of projects) {
    let dir;
    try {
      dir = resolveProjectPath(project.path);
    } catch {
      dir = null;
    }
    meta[name] = { files: dir ? envFilesFor(dir) : [], ...projectIdentity(project) };
  }
  const inDomain = (host) => domains.some((d) => host === d || host.endsWith('.' + d) || host.endsWith(d));

  console.log(c.bold('Dependency graph') + c.dim('  — edges auto-discovered from .envs, no wiring'));
  console.log(
    c.dim(
      [
        'How it works:',
        '  1. Give each project an id so crew can recognize it when another project\'s URL',
        '     points at it: `match` = the complete hostname(s) it is served under (exact',
        '     strings — list every env variant). E.g. match: ["api.example.com",',
        '     "qa-api.example.com"]. No `match` = no id, so nothing can point at it (⚠).',
        '  2. Read every env file and pull out every http(s):// URL.',
        '  3. For each URL, compare its host to every `match` string — exact match only, so',
        '     api.example.com never collides with rge-api.example.com.',
        '  4. A URL in P whose host equals one of T\'s match hosts → edge P → T.',
        '  5. URLs matching no project are dropped as 3rd-party (or listed as "other internal"',
        '     when you set `internalDomains`).',
      ].join('\n')
    )
  );
  let warned = false;
  for (const [name] of projects) {
    const { files, tokens, source } = meta[name];
    const seen = new Map(); // host\npath -> { host, path } (deduped across this project's envs)
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
    const other = new Set();
    for (const { host, path } of seen.values()) {
      // Pick the project whose matching token is longest (most specific), so a gateway host
      // split by path resolves to the deeper path, not a shorter prefix.
      let best = null;
      let bestLen = 0;
      for (const [t] of projects) {
        for (const tok of meta[t].tokens) {
          const len = tokenMatchLen(host, path, tok);
          if (len > bestLen) {
            bestLen = len;
            best = t;
          }
        }
      }
      if (best && best !== name) edges.add(best);
      else if (!best && domains.length && inDomain(host)) other.add(host); // only when configured
    }

    const head = c.bold(paint.get(name) ? paint.get(name)(name) : name);
    if (source === 'none') {
      warned = true;
      console.log(`\n${head}  ${c.yellow('⚠ no `match` — no id, peers can\'t link to it')}`);
    } else {
      console.log(`\n${head}  ${c.dim('[' + tokens.join(', ') + ']')}`);
    }
    if (edges.size) {
      for (const t of [...edges].sort())
        console.log(`  ${c.green('→')} ${paint.get(t) ? paint.get(t)(t) : t}`);
    } else {
      console.log(`  ${c.dim('→ (no crew-project edges)')}`);
    }
    if (other.size) console.log(`  ${c.dim('· other internal: ' + [...other].sort().join(', '))}`);
  }
  if (warned)
    console.log(
      '\n' + c.yellow('⚠ ') + c.dim('some projects have no `match` — add `match: ["host.example.com"]` (exact hosts) so peers can link to them.')
    );
}

export function cmdConfig(flags, sub) {
  const path = userConfigPath(flags);
  if (sub === 'path') {
    console.log(path);
    return;
  }
  if (sub === 'edit') {
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    if (!pathExists(path)) writeUserConfig(path, defaultConfig());
    const r = spawnSync(editor, [path], { stdio: 'inherit' });
    if (r.error) fail(`failed to open editor '${editor}': ${r.error.message}`);
    return;
  }
  if (sub) fail(`config: unknown subcommand '${sub}'. Use: config | config path | config edit`);
  const { cfg, localPath } = loadMerged(flags);
  console.log(`# resolved config path: ${path}`);
  if (localPath) console.log(`# merged with project-local: ${localPath}`);
  console.log(JSON.stringify(cfg, null, 2));
}

// crew pull <url> — fetch a config.json from a URL and install it as the user config
// (backing up the current one). local.json (projects dir, last selection) is untouched.
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
  if (!cfg || typeof cfg !== 'object' || typeof cfg.projects !== 'object')
    fail('pull: that JSON is not a crew config (missing "projects")');

  mkdirSync(dirname(path), { recursive: true });
  let backed = false;
  if (pathExists(path)) {
    writeFileSync(path + '.bak', readFileSync(path));
    backed = true;
  }
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  const n = Object.keys(cfg.projects || {}).length;
  console.log(`Loaded config → ${tildify(path)} ${c.dim(`(${n} project${n === 1 ? '' : 's'})`)}`);
  if (backed) console.log(c.dim(`  previous saved as ${tildify(path + '.bak')}`));
  console.log(c.dim('  set your projects dir if needed: crew dir <path>'));
}

// Best-effort default branch (where new work is cut from): origin/HEAD if the repo knows it,
// else the current branch. '' when git/repo unavailable. Used only to prefill the wizard.
function detectDefaultBranch(dir) {
  try {
    const opts = { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    let r = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], opts);
    let b = r.status === 0 ? r.stdout.trim() : '';
    if (b.startsWith('origin/')) b = b.slice('origin/'.length);
    if (!b) {
      r = spawnSync('git', ['branch', '--show-current'], opts);
      b = r.status === 0 ? r.stdout.trim() : '';
    }
    return b;
  } catch {
    return '';
  }
}

// Prompt for every project field, defaulting to `existing` (empty object when adding).
// Text fields are inline-editable (prefilled with the current value — Enter keeps it, clear
// to unset); type is a picked list. Any field the wizard doesn't manage is preserved.
// `guardNames` are the guard names defined in the config (offered as a multi-select).
async function collectProject(p, existing, guardNames = []) {
  const path0 = await p.ask('Path', existing.path || '');
  if (!path0) fail('a path is required');
  const abs = resolveProjectPath(path0);
  if (!pathExists(abs)) {
    const keep = await p.ask(`Path does not exist (${abs}). Save anyway? (y/N)`, '');
    if (!/^y/i.test(keep)) fail('aborted (path does not exist)');
  }
  const type = await p.select('Type', PROJECT_TYPES, existing.type || 'other');
  const runner = await p.ask('Runner template, e.g. "npm run {task}" (empty = run-less)', existing.runner || '');

  const tasks = { ...(existing.tasks || {}) };
  const known = Object.keys(tasks);
  if (known.length) console.log(c.dim(`current tasks: ${known.join(', ')}`));
  console.log(c.dim('Task overrides — enter a task name to add/edit (empty to finish; clear its command to remove):'));
  for (;;) {
    const t = (await p.ask('  Task name', '')).trim();
    if (!t) break;
    const cmd = await p.ask(`  Command for '${t}'`, tasks[t] || '');
    if (cmd) tasks[t] = cmd;
    else delete tasks[t];
  }

  // Service-wiring fields (all optional; Enter to keep, clear to unset).
  const env = (await p.ask('Env file for {envfile} wiring, e.g. .envs/{env} (empty = none)', existing.env || '')).trim();
  const local = (await p.ask('Local URL, e.g. http://localhost:3000 (empty = none)', existing.local || '')).trim();
  const matchStr = (await p.ask('Match host globs (space-separated), e.g. *api.example.com (empty = none)', (existing.match || []).join(' '))).trim();
  const match = matchStr ? matchStr.split(/\s+/) : [];

  const detectedBranch = existing.defaultBranch || detectDefaultBranch(abs);
  const defaultBranch = (await p.ask('Default branch — where new work starts (empty = none)', detectedBranch)).trim();

  let guards = existing.guards || [];
  if (guardNames.length) guards = await p.multiselect('Guards', guardNames, guards);

  // Spread `existing` first so unmanaged/future fields survive; then set/unset the managed ones.
  const project = { ...existing, path: path0, type };
  const setOrDel = (k, v, keep) => (keep ? (project[k] = v) : delete project[k]);
  setOrDel('runner', runner, !!runner);
  setOrDel('env', env, !!env);
  setOrDel('local', local, !!local);
  setOrDel('match', match, match.length > 0);
  setOrDel('defaultBranch', defaultBranch, !!defaultBranch);
  setOrDel('tasks', tasks, Object.keys(tasks).length > 0);
  setOrDel('guards', guards, guards && guards.length > 0);
  return project;
}

// crew add — create a NEW project via wizard (errors if it exists).
export async function cmdAdd(flags) {
  const { cfg, path } = loadUserConfig(flags);
  const p = makePrompter();
  try {
    const name = (await p.ask('Project name', '')).trim();
    if (!name) fail('add: a project name is required');
    if (cfg.projects[name]) fail(`'${name}' already exists. Use: crew edit ${name}`);
    cfg.projects[name] = await collectProject(p, {}, Object.keys(cfg.guards || {}));
    writeUserConfig(path, cfg);
    console.log(`\nSaved project '${name}' to ${path}`);
  } finally {
    p.close();
  }
}

// crew edit [name] — modify an EXISTING project via wizard (errors if absent).
export async function cmdEdit(flags, name) {
  const { cfg, path } = loadUserConfig(flags);
  const projects = Object.keys(cfg.projects || {});
  if (!projects.length) fail('edit: nothing to edit yet. Run: crew add');

  const p = makePrompter();
  try {
    // No name given: pick from a list — arrow keys when interactive, else typed.
    if (!name) {
      if (canInteractive()) {
        const picked = await menu({
          title: 'Edit which project?',
          items: projects,
          label: (n, cur) => (cur ? c.bold(n) : n),
        });
        if (!picked) {
          console.log('edit: cancelled');
          return;
        }
        name = picked;
      } else {
        console.log('Projects: ' + projects.join(', '));
        name = (await p.ask('Name to edit', '')).trim();
      }
    }
    if (!name) fail('edit: a name is required');
    if (!cfg.projects[name]) fail(`no such project '${name}'. Run: crew add`);

    cfg.projects[name] = await collectProject(p, cfg.projects[name], Object.keys(cfg.guards || {}));
    writeUserConfig(path, cfg);
    console.log(`\nUpdated project '${name}' in ${path}`);
  } finally {
    p.close();
  }
}

export async function cmdRemove(flags, name) {
  if (!name) fail('remove: missing name. Usage: crew remove <name>');
  const { cfg, path } = loadUserConfig(flags);
  if (!cfg.projects[name])
    fail(`no such project '${name}'.\n  projects: ${Object.keys(cfg.projects).join(', ') || '(none)'}`);

  if (!(await confirm(`Delete project '${name}'?`))) return;
  delete cfg.projects[name];
  writeUserConfig(path, cfg);
  console.log(`Removed project '${name}'`);
}

// crew guards [target]           -> list all guards (or a target's), with usage
// crew guards add|remove|link|unlink -> wizard-driven management (selects, no hand-editing)
const GUARD_ACTIONS = ['add', 'remove', 'link', 'unlink'];
export async function cmdGuards(flags, sub, rest) {
  if (sub && GUARD_ACTIONS.includes(sub)) {
    const { cfg, path } = loadUserConfig(flags);
    const p = makePrompter();
    try {
      if (sub === 'add') return await guardAdd(flags, cfg, path, p);
      const names = Object.keys(cfg.guards || {});
      if (!names.length) fail('no guards defined yet. Add one: crew guards add');
      if (sub === 'remove') return await guardRemove(flags, cfg, path, p);
      return await guardLink(cfg, path, p, sub === 'link'); // link (toggle) / unlink
    } finally {
      p.close();
    }
  }
  guardList(loadMerged(flags).cfg, sub); // sub (optional) = a target to scope the list to
}

function printGuard(reg, n) {
  const g = reg[n] || {};
  console.log(`  ${c.cyan(n)}`);
  if (g.comment) console.log(`      ${c.dim('comment')}  ${faint(g.comment)}`);
  console.log(`      ${c.dim('command')}  ${g.command || c.dim('(none)')}`);
  if (g.message) console.log(`      ${c.dim('message')}  ${g.message}`);
}
function guardList(cfg, projectName) {
  const reg = cfg.guards || {};
  if (projectName) {
    const members = membersFor(cfg, [projectName]);
    const used = [...new Set(members.flatMap((m) => m.project.guards || []))];
    console.log(c.bold(c.underline(`Guards for project '${projectName}'`)));
    if (!used.length) return void console.log(c.dim('  (none)'));
    for (const n of used) printGuard(reg, n);
    return;
  }
  console.log(c.bold(c.underline('Guards')));
  const names = Object.keys(reg);
  if (!names.length) return void console.log(c.dim('  (none) — add one: crew guards add'));
  const users = {};
  for (const [pn, pr] of Object.entries(cfg.projects || {}))
    for (const g of pr.guards || []) (users[g] = users[g] || []).push(pn);
  for (const n of names) {
    printGuard(reg, n);
    console.log(`      ${c.dim('used by')}  ${(users[n] || []).join(', ') || c.dim('(no projects)')}`);
  }
}

async function guardAdd(flags, cfg, path, p) {
  const name = (await p.ask('Guard name', '')).trim();
  if (!name) fail('guards: a name is required');
  if (cfg.guards && cfg.guards[name]) fail(`guard '${name}' already exists`);
  const comment = (await p.ask('What does this check verify? (shown dim at run start)', '')).trim();
  if (!comment) fail('guards: a comment is required — it explains what the check verifies');
  const command = (await p.ask('Check command (exit 0 = pass)', '')).trim();
  if (!command) fail('guards: a command is required');
  const message = (await p.ask('Failure message', '')).trim();
  cfg.guards = cfg.guards || {};
  cfg.guards[name] = message ? { comment, command, message } : { comment, command };
  // Optionally attach to projects right away.
  const projNames = Object.keys(cfg.projects || {});
  if (projNames.length) {
    const sel = await p.multiselect('Attach to projects', projNames, []);
    for (const pn of sel) setProjectGuard(cfg.projects[pn], name, true);
  }
  writeUserConfig(path, cfg);
  console.log(`\nSaved guard '${name}'`);
}

async function guardRemove(flags, cfg, path, p) {
  const names = Object.keys(cfg.guards);
  const name = await p.select('Remove which guard?', names, names[0]);
  const yes = await p.ask(`Delete guard '${name}'? (y/N)`, '');
  if (!/^y/i.test(yes)) return void console.log('cancelled');
  delete cfg.guards[name];
  for (const pr of Object.values(cfg.projects || {})) setProjectGuard(pr, name, false);
  writeUserConfig(path, cfg);
  console.log(`Removed guard '${name}'`);
}

async function guardLink(cfg, path, p, attach) {
  const names = Object.keys(cfg.guards);
  const gname = await p.select(attach ? 'Link which guard?' : 'Unlink which guard?', names, names[0]);
  const projNames = Object.keys(cfg.projects || {});
  if (!projNames.length) fail('no projects to link.');
  const current = projNames.filter((pn) => (cfg.projects[pn].guards || []).includes(gname));
  if (attach) {
    // Toggle-multiselect over ALL projects (preselected = current) => sets membership.
    const sel = await p.multiselect(`Projects using '${gname}'`, projNames, current);
    for (const pn of projNames) setProjectGuard(cfg.projects[pn], gname, sel.includes(pn));
  } else {
    if (!current.length) return void console.log(`'${gname}' is not linked to any project.`);
    const sel = await p.multiselect(`Remove '${gname}' from`, current, []);
    for (const pn of sel) setProjectGuard(cfg.projects[pn], gname, false);
  }
  writeUserConfig(path, cfg);
  console.log(`Updated '${gname}' links`);
}

// Add/remove a guard name on a project, keeping `guards` absent when empty.
function setProjectGuard(project, name, on) {
  const set = new Set(project.guards || []);
  if (on) set.add(name);
  else set.delete(name);
  const list = [...set];
  if (list.length) project.guards = list;
  else delete project.guards;
}

// ---------------------------------------------------------------------------
// Env overrides — machine-local per-project env vars, stored in local.json (never committed).
// Applied to a project's wired env when crew starts it (see overrideVarsFor/applyEnvOverrides).
// ---------------------------------------------------------------------------
const OVERRIDE_ACTIONS = ['set', 'add', 'remove', 'rm', 'unset'];
export async function cmdOverrides(flags, sub, rest) {
  if (sub && OVERRIDE_ACTIONS.includes(sub)) {
    const { cfg } = loadMerged(flags);
    const p = makePrompter();
    try {
      if (sub === 'set' || sub === 'add') return await overrideSet(flags, cfg, p);
      return await overrideRemove(flags, p);
    } finally {
      p.close();
    }
  }
  overrideList(flags, loadMerged(flags).cfg);
}

function overrideList(flags, cfg) {
  const ovr = loadMachine(flags).overrides || {};
  console.log(c.bold(c.underline('Env overrides')) + c.dim('  (machine-local — local.json)'));
  const projects = Object.keys(ovr);
  if (!projects.length) return void console.log(c.dim('  (none) — add one: crew overrides set'));
  for (const proj of projects) {
    const known = cfg.projects && cfg.projects[proj];
    console.log(`  ${c.cyan(proj)}${known ? '' : c.yellow('  (unknown project)')}`);
    const o = ovr[proj] && typeof ovr[proj] === 'object' ? ovr[proj] : {};
    const bare = Object.keys(o).filter((k) => k !== OVERRIDE_WHEN_LOCAL);
    const wl = o[OVERRIDE_WHEN_LOCAL] && typeof o[OVERRIDE_WHEN_LOCAL] === 'object' ? o[OVERRIDE_WHEN_LOCAL] : null;
    if (!bare.length && !wl) console.log(`      ${c.dim('(empty)')}`);
    for (const k of bare) console.log(`      ${k}=${o[k]}`);
    if (wl)
      for (const peer of Object.keys(wl)) {
        console.log(`      ${faint(`when ${peer} is local:`)}`);
        const pv = wl[peer] && typeof wl[peer] === 'object' ? wl[peer] : {};
        for (const k of Object.keys(pv)) console.log(`        ${k}=${pv[k]}`);
      }
  }
  console.log(faint('  bare vars apply whenever the project starts; whenLocal vars only when that peer co-runs'));
}

async function overrideSet(flags, cfg, p) {
  const projNames = Object.keys(cfg.projects || {});
  if (!projNames.length) fail('no projects defined — add one: crew add');
  const proj = await p.select('Override which project?', projNames, projNames[0]);
  const key = (await p.ask('Env var name', '')).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`invalid env var name '${key}'`);
  const peer = (await p.ask('Only when which project runs locally? (empty = always)', '')).trim();
  if (peer && !cfg.projects[peer]) fail(`unknown project '${peer}'`);
  const machine = loadMachine(flags);
  machine.overrides = machine.overrides || {};
  const o = machine.overrides[proj] && typeof machine.overrides[proj] === 'object' ? machine.overrides[proj] : {};
  let existing;
  if (peer) {
    o[OVERRIDE_WHEN_LOCAL] = o[OVERRIDE_WHEN_LOCAL] && typeof o[OVERRIDE_WHEN_LOCAL] === 'object' ? o[OVERRIDE_WHEN_LOCAL] : {};
    o[OVERRIDE_WHEN_LOCAL][peer] = o[OVERRIDE_WHEN_LOCAL][peer] && typeof o[OVERRIDE_WHEN_LOCAL][peer] === 'object' ? o[OVERRIDE_WHEN_LOCAL][peer] : {};
    existing = o[OVERRIDE_WHEN_LOCAL][peer][key] || '';
  } else existing = o[key] || '';
  const value = await p.ask(`Value for ${key}`, String(existing));
  if (peer) o[OVERRIDE_WHEN_LOCAL][peer][key] = value;
  else o[key] = value;
  machine.overrides[proj] = o;
  writeMachine(flags, machine);
  console.log(`\nSet ${c.cyan(proj)}  ${peer ? faint(`(when ${peer} local) `) : ''}${key}=${value}`);
}

async function overrideRemove(flags, p) {
  const machine = loadMachine(flags);
  const ovr = machine.overrides || {};
  const projects = Object.keys(ovr);
  if (!projects.length) fail('no overrides defined yet. Add one: crew overrides set');
  const proj = await p.select('Remove from which project?', projects, projects[0]);
  const o = ovr[proj] && typeof ovr[proj] === 'object' ? ovr[proj] : {};
  const entries = [];
  for (const k of Object.keys(o)) if (k !== OVERRIDE_WHEN_LOCAL) entries.push({ label: k, kind: 'bare', k });
  const wl = o[OVERRIDE_WHEN_LOCAL] && typeof o[OVERRIDE_WHEN_LOCAL] === 'object' ? o[OVERRIDE_WHEN_LOCAL] : null;
  if (wl) for (const peer of Object.keys(wl)) for (const k of Object.keys(wl[peer] || {})) entries.push({ label: `whenLocal.${peer}.${k}`, kind: 'wl', peer, k });
  const ALL = '(all — remove the whole project entry)';
  const labels = entries.map((e) => e.label);
  const choice = labels.length ? await p.select(`Remove which override from ${proj}?`, [...labels, ALL], labels[0]) : ALL;
  if (choice === ALL) delete ovr[proj];
  else {
    const e = entries.find((x) => x.label === choice);
    if (e.kind === 'bare') delete o[e.k];
    else {
      delete wl[e.peer][e.k];
      if (!Object.keys(wl[e.peer]).length) delete wl[e.peer];
      if (!Object.keys(wl).length) delete o[OVERRIDE_WHEN_LOCAL];
    }
    if (!Object.keys(o).length) delete ovr[proj];
  }
  machine.overrides = ovr;
  writeMachine(flags, machine);
  console.log(`\nRemoved ${choice === ALL ? `all overrides for ${proj}` : `${choice} from ${proj}`}`);
}

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
  if (cfg.longRunning != null && !isStrArr(cfg.longRunning)) E(`longRunning must be an array of strings`);
  if (cfg.workspaceSettings != null && !isObj(cfg.workspaceSettings)) E(`workspaceSettings must be an object`);
  if (cfg.internalDomains != null && !isStrArr(cfg.internalDomains)) E(`internalDomains must be an array of strings`);
  if (cfg.guards != null && !isObj(cfg.guards)) E(`guards must be an object`);
  const guards = isObj(cfg.guards) ? cfg.guards : {};

  // Projects.
  if (!isObj(cfg.projects) || !Object.keys(cfg.projects).length) {
    E(`projects: at least one project is required`);
  } else {
    for (const [name, p] of Object.entries(cfg.projects)) {
      const at = `project '${name}'`;
      if (!isObj(p)) {
        E(`${at}: must be an object`);
        continue;
      }
      for (const k of Object.keys(p)) if (!PROJECT_KEYS.has(k)) W(`${at}: unknown key '${k}'`);
      if (typeof p.path !== 'string' || !p.path.trim()) E(`${at}: 'path' (string) is required`);
      else
        try {
          if (!pathExists(resolveProjectPath(p.path))) W(`${at}: path does not exist on disk: ${p.path}`);
        } catch (e) {
          W(`${at}: path cannot be resolved (${e.message})`);
        }
      if (p.type != null && typeof p.type !== 'string') E(`${at}: 'type' must be a string`);
      else if (typeof p.type === 'string' && !PROJECT_TYPES.includes(p.type)) W(`${at}: unusual type '${p.type}' (known: ${PROJECT_TYPES.join(', ')})`);
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
        if (!isStrArr(p.match)) E(`${at}: 'match' must be an array of strings`);
        else
          for (const h of p.match) {
            if (/[*?]/.test(h)) W(`${at}: match '${h}' looks like a glob — matching is exact-host only`);
            else if (h.includes('/')) W(`${at}: match '${h}' should be a bare hostname (no scheme/path)`);
          }
      }
      if (p.envMap != null) {
        if (!isObj(p.envMap)) E(`${at}: 'envMap' must be an object`);
        else for (const [k, v] of Object.entries(p.envMap)) if (typeof v !== 'string') E(`${at}: envMap['${k}'] must be a string`);
      }
      if (p.guards != null) {
        if (!isStrArr(p.guards)) E(`${at}: 'guards' must be an array of strings`);
        else for (const g of p.guards) if (!guards[g]) E(`${at}: references undefined guard '${g}'`);
      }
      const usesEnvfile = [p.runner, ...Object.values(isObj(p.tasks) ? p.tasks : {})].some((s) => typeof s === 'string' && s.includes('{envfile}'));
      if (usesEnvfile && !p.env) E(`${at}: uses {envfile} but has no 'env' field`);
      if (isStrArr(p.match) && p.match.length && !p.local) W(`${at}: has 'match' (a wiring target) but no 'local' — peers can't wire to it locally`);
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
  const usedGuards = new Set(Object.values(cfg.projects || {}).flatMap((p) => (isObj(p) && Array.isArray(p.guards) ? p.guards : [])));
  for (const name of Object.keys(guards)) if (!usedGuards.has(name)) W(`guard '${name}' is defined but used by no project`);

  // Machine-local local.json (overrides + remembered selection).
  const machine = loadMachine(flags);
  const projNames = new Set(Object.keys(cfg.projects || {}));
  if (machine.overrides != null) {
    if (!isObj(machine.overrides)) E(`local.json: overrides must be an object`);
    else
      for (const [proj, vars] of Object.entries(machine.overrides)) {
        if (!projNames.has(proj)) W(`local.json overrides: unknown project '${proj}'`);
        if (!isObj(vars)) {
          E(`local.json overrides['${proj}'] must be an object of VAR:value`);
          continue;
        }
        const checkVar = (where, k, v) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) W(`local.json ${where}: invalid env var name '${k}'`);
          if (v === null || typeof v === 'object') W(`local.json ${where}.${k} must be a string`);
        };
        for (const [k, v] of Object.entries(vars)) {
          if (k === OVERRIDE_WHEN_LOCAL) {
            if (!isObj(v)) {
              E(`local.json overrides['${proj}'].whenLocal must be an object keyed by project`);
              continue;
            }
            for (const [peer, pv] of Object.entries(v)) {
              if (!projNames.has(peer)) W(`local.json overrides['${proj}'].whenLocal: unknown project '${peer}'`);
              if (!isObj(pv)) {
                E(`local.json overrides['${proj}'].whenLocal['${peer}'] must be an object of VAR:value`);
                continue;
              }
              for (const [vk, vv] of Object.entries(pv)) checkVar(`overrides['${proj}'].whenLocal['${peer}']`, vk, vv);
            }
            continue;
          }
          checkVar(`overrides['${proj}']`, k, v);
        }
      }
  }
  if (Array.isArray(machine.lastSelection)) for (const n of machine.lastSelection) if (!projNames.has(n)) W(`local.json lastSelection: unknown project '${n}'`);

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
    ['help', '', 'Show this help (also: no args)'],
    ['list', '', 'List projects (alias: ls)'],
    ['install', '', 'Pick projects, run their install task'],
    ['start', '[args]', 'Pick projects, run their start task (local wiring)'],
    ['workspace', '', 'Pick projects, open as one VSCode window (alias: code)'],
    ['claude', '[session]', 'Pick projects, launch Claude Code (names the chat history, else auto)'],
    ['graph', '', 'Show the dependency graph derived from .envs'],
  ];
  const CONFIG = [
    ['add', '', 'Wizard: create a new project'],
    ['edit', '[name]', 'Wizard: modify an existing project'],
    ['remove', '<name>', 'Delete a project (alias rm)'],
    ['guards', '[project]', 'List/manage guards (add/remove/link/unlink)'],
    ['overrides', '[set|remove]', 'List/set/remove per-project env overrides (local.json)'],
    ['dir', '[path]', 'Show/set the projects directory'],
    ['config', '[path|edit]', 'Print config / its path / open in $EDITOR'],
    ['check', '', 'Validate the config; report errors + warnings (alias: validate)'],
    ['pull', '<url>', 'Load config.json from a URL (backs up current)'],
  ];
  const FLAGS = [
    ['--config <path>', 'Use a specific config file'],
    ['-v, --version', 'Print version'],
  ];
  const L = [];
  L.push(`${c.bold('crew')} ${PKG.version} — fan a task across a group of local projects`);
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
// crew — fan a named task out across a group of local projects, open them as one
// VSCode workspace, or hand the set to Claude Code. Driven by one persistent config.
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
    case 'ls':
      cmdList(flags);
      return;
    case 'start':
      await cmdRun(flags, 'start', rest);
      return;
    case 'install':
      await cmdRun(flags, 'install', rest);
      return;
    case 'workspace':
    case 'code':
      await cmdWorkspace(flags, rest);
      return;
    case 'claude':
      await cmdClaude(flags, rest);
      return;
    case 'add':
      await cmdAdd(flags);
      return;
    case 'edit':
      await cmdEdit(flags, rest[0]);
      return;
    case 'remove':
    case 'rm':
      await cmdRemove(flags, rest[0]);
      return;
    case 'guards':
      await cmdGuards(flags, rest[0], rest.slice(1));
      return;
    case 'overrides':
    case 'override':
      await cmdOverrides(flags, rest[0], rest.slice(1));
      return;
    case 'dir':
      cmdDir(flags, rest[0]);
      return;
    case 'graph':
      cmdGraph(flags);
      return;
    case 'config':
      cmdConfig(flags, rest[0]);
      return;
    case 'check':
    case 'validate':
    case 'doctor':
      cmdCheck(flags);
      return;
    case 'pull':
      await cmdPull(flags, rest[0]);
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
