#!/usr/bin/env node
// crew — fan a named task out across a group of local projects, open them as one
// VSCode workspace, or hand the set to Claude Code. Driven by one persistent config.
//
// Zero runtime dependencies — Node built-ins only, including a built-in process-group
// runner for parallel tasks. POSIX (macOS + Linux). See README for the full model.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------------------
// Colors — ANSI only (no dependency). Disabled when not a TTY, NO_COLOR is set,
// or TERM=dumb, so piped/redirected output stays clean.
// ---------------------------------------------------------------------------
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const wrap = (n) => (s) => (COLOR ? `\x1b[${n}m${s}\x1b[0m` : `${s}`);
const c = {
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
function fgRGB(r, g, b) {
  if (!COLOR) return (s) => `${s}`;
  const code = TRUECOLOR ? `38;2;${r};${g};${b}` : `38;5;${rgbTo256(r, g, b)}`;
  return (s) => `\x1b[${code}m${s}\x1b[0m`;
}
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
function colorForIndex(i) {
  const [r, g, b] = rgbForIndex(i);
  return fgRGB(r, g, b);
}
// Assign every known project a stable rank (sorted name order) -> golden-angle color.
// Same project set always yields the same color per name, and neighbours differ sharply.
// Built once per command so list/groups/run all agree.
function projectColors(cfg) {
  const names = Object.keys(cfg.projects || {}).sort();
  const map = new Map();
  names.forEach((n, i) => map.set(n, colorForIndex(i)));
  return map;
}
function tildify(p) {
  const h = homedir();
  return p === h || p.startsWith(h + '/') ? '~' + p.slice(h.length) : p;
}

// ---------------------------------------------------------------------------
// Errors — expected failures print a clean one-line message, never a stack.
// ---------------------------------------------------------------------------
class CrewError extends Error {}
function fail(msg) {
  throw new CrewError(msg);
}
function warn(msg) {
  console.error(c.yellow(`crew: ${msg}`));
}

// ---------------------------------------------------------------------------
// Path helpers — ~ expansion + relative-to-cwd resolution everywhere.
// ---------------------------------------------------------------------------
function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}
function resolvePath(p) {
  const e = expandHome(String(p));
  return isAbsolute(e) ? e : resolve(process.cwd(), e);
}
// Machine-local projects directory; relative project paths resolve against it. Set once
// per machine via `crew dir` (stored in the user-level config, never in a committed
// ./.crew.json), so shared configs can use short relative paths like "bee-beepro-backend".
let PROJECTS_DIR = null;
// Resolve a PROJECT path: `~`/absolute is used as-is (escape hatch for repos outside the
// projects dir); anything relative resolves against PROJECTS_DIR.
function resolveProjectPath(p) {
  const e = expandHome(String(p));
  if (isAbsolute(e)) return e;
  if (!PROJECTS_DIR)
    fail(
      `project path '${p}' is relative but no projects directory is set.\n` +
        `  Set it once: crew dir <path>   (e.g. crew dir ~/Projects)`
    );
  return resolve(PROJECTS_DIR, e);
}
function pathExists(p) {
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
function shellQuote(v) {
  const s = String(v);
  if (s === '') return "''";
  if (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

// ---------------------------------------------------------------------------
// Placeholders — {name} tokens inside a resolved command string.
// ---------------------------------------------------------------------------
const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;
function placeholdersIn(str) {
  const set = new Set();
  let m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(str))) set.add(m[1]);
  return [...set];
}
function substitute(str, values) {
  return str.replace(PLACEHOLDER_RE, (_, k) => shellQuote(values[k]));
}

// ---------------------------------------------------------------------------
// Config — user-level at ~/.config/crew/config.json, project-local ./.crew.json
// merges on top. v1 configs migrate to v2 in memory and are written back.
// ---------------------------------------------------------------------------
const DEFAULT_LONG_RUNNING = ['start', 'dev', 'watch'];

function defaultConfig() {
  return {
    version: 2,
    workspaceName: 'crew',
    longRunning: [...DEFAULT_LONG_RUNNING],
    projects: {},
  };
}

function userConfigPath(flags) {
  if (flags.config) return resolvePath(flags.config);
  return join(homedir(), '.config', 'crew', 'config.json');
}
function crewHomeFor(configPath) {
  // The dir that holds the config also holds generated workspaces.
  return dirname(configPath);
}
// Machine-local settings (currently just projectsDir) live beside the config as
// `local.json` — never committed. This keeps config.json fully shareable; teammates set
// their own projectsDir with `crew dir`. Add `local.json` to .gitignore when committing.
function machineConfigPath(flags) {
  return join(crewHomeFor(userConfigPath(flags)), 'local.json');
}
function loadMachine(flags) {
  const p = machineConfigPath(flags);
  if (!pathExists(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}
function writeMachine(flags, obj) {
  const p = machineConfigPath(flags);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

// Migrate a config object in place to v2. Returns true if anything changed.
function migrate(cfg) {
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
function loadUserConfig(flags) {
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

function writeUserConfig(path, cfg) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
}

// Merge project-local ./.crew.json on top of the user config (read-only overlay).
function loadMerged(flags) {
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
// Selection — a set of projects chosen per-run: either named explicitly on the CLI, or
// picked interactively (preselected with the last selection). No groups; the remembered
// selection replaces them. `label` names the set for display.
// ---------------------------------------------------------------------------
function membersFor(cfg, names) {
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
function loadLastSelection(flags) {
  const s = loadMachine(flags).lastSelection;
  return Array.isArray(s) ? s : [];
}
function saveLastSelection(flags, names) {
  try {
    writeMachine(flags, { ...loadMachine(flags), lastSelection: names });
  } catch {
    /* read-only fs — selection just won't persist */
  }
}

// Resolve the project set for a command: use explicit CLI names, else open the multiselect
// picker (preselected with the remembered selection). Persists the chosen set globally.
// opts.connectivity shows a live wiring-connectivity footer in the picker (for co-running
// sets). Returns members [] or null if the picker was cancelled / nothing chosen.
async function selectMembers(flags, cfg, names, opts = {}) {
  const known = Object.keys(cfg.projects || {});
  if (!known.length) fail('no projects configured yet — run: crew add');
  if (names.length) {
    const members = membersFor(cfg, names);
    saveLastSelection(flags, names);
    return members;
  }
  if (!canInteractive())
    fail('no projects given and not an interactive terminal — pass names, e.g. crew start rge-be rge-fe');
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
  });
  if (!picked || !picked.length) {
    console.log(c.dim('nothing selected'));
    return null;
  }
  saveLastSelection(flags, picked);
  return membersFor(cfg, picked);
}

// Directed dependency edges among the given [name, project] entries: name -> Set(peer).
// Same rule as `crew graph` (whole-host glob, most-specific token wins).
function dependencyEdges(cfg, entries) {
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
function componentsFrom(edges, names) {
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
function connectivityStatus(cfg, edges, names, verbose = false) {
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
function validateMemberPaths(members) {
  for (const m of members) {
    const p = resolveProjectPath(m.project.path);
    if (!pathExists(p)) fail(`project '${m.name}': path not found: ${p}`);
  }
}

// Build a deduped absolute-path list of member project paths, first-seen order.
function dirList(members) {
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

function projectDir(project) {
  return resolveProjectPath(project.path);
}

// ---------------------------------------------------------------------------
// Task resolution — tasks[task] -> runner{task} -> skip. Strict placeholders.
// ---------------------------------------------------------------------------
function resolveRun(cfg, task, members, args) {
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

  // Union of placeholders across all runnable commands, excluding auto-filled {task}.
  const union = new Set();
  for (const r of runnable)
    for (const p of placeholdersIn(r.template)) if (p !== 'task') union.add(p);

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

  // Strict: every placeholder in every runnable command must be satisfied.
  const unresolved = new Set();
  for (const r of runnable)
    for (const p of placeholdersIn(r.template))
      if (p !== 'task' && !(p in values)) unresolved.add(p);
  if (unresolved.size)
    fail(
      `unresolved placeholder(s): ${[...unresolved].join(', ')}. ` +
        `Provide as a positional or key=value.`
    );

  for (const r of runnable) r.resolved = substitute(r.template, values);
  return { runnable, skipped };
}

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

// exitCode is a number (normal exit) or a signal-name string (killed). Aggregate:
// first non-zero numeric wins; else 130 if anything was signalled; else 0/1.
function exitCodeFromEvents(events) {
  if (!Array.isArray(events)) return 1;
  let killedBySignal = false;
  for (const e of events) {
    const code = e && e.exitCode;
    if (typeof code === 'number' && code !== 0) return code;
    if (typeof code === 'string') killedBySignal = true; // signal name, e.g. 'SIGTERM'
  }
  return killedBySignal ? 130 : 1;
}

function runFanout(commands, { killOthers, announceExits }) {
  return new Promise((resolve) => {
    const results = [];
    const live = new Set();
    const spawned = [];
    const timers = [];
    let aborting = false;
    let firstSigintAt = 0;

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
    const emit = (proc, text) => {
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

    const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = SIGNALS.map((sig) => {
      const h = () => {
        if (sig !== 'SIGINT') return tearDown('SIGTERM');
        const now = Date.now();
        if (!firstSigintAt) {
          firstSigintAt = now;
          return tearDown('SIGINT'); // graceful: SIGTERM group -> grace -> SIGKILL
        }
        if (now - firstSigintAt >= SIGINT_FORCE_AFTER_MS) return forceKill();
        // Still inside the graceful window — ignore the extra Ctrl-C, just nudge.
        const left = Math.ceil((SIGINT_FORCE_AFTER_MS - (now - firstSigintAt)) / 1000);
        if (lastWrite.char !== '\n') rawWrite('\n');
        rawWrite(c.dim(`crew: shutting down… press Ctrl-C again in ${left}s to force-kill\n`));
        lastWrite.char = '\n';
      };
      process.on(sig, h);
      return [sig, h];
    });
    const onStdoutErr = () => tearDown('SIGTERM');
    process.stdout.on('error', onStdoutErr);

    const settle = () => {
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
      if (announceExits) note(proc, c.dim(`exited (${exitCode})`));
      if (killOthers && !aborting && live.size) tearDown('SIGTERM');
      if (live.size === 0) settle();
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

    if (live.size === 0) settle();
  });
}

// ---------------------------------------------------------------------------
// Guards — named shell probes a project can require (VPN up, AWS logged in, …). crew is
// agnostic: a guard passes iff its command exits 0. Deduped by name across the target, so
// a guard shared by several projects runs once. Any failure prints its message and aborts
// before anything starts. Bypass with --skip-guards.
// ---------------------------------------------------------------------------
async function runGuards(cfg, members) {
  const registry = cfg.guards || {};
  const names = [];
  const seen = new Set();
  for (const m of members)
    for (const gn of m.project.guards || [])
      if (!seen.has(gn)) {
        seen.add(gn);
        names.push(gn);
      }
  if (!names.length) return;

  const undef = names.filter((n) => !registry[n] || !registry[n].command);
  if (undef.length)
    fail(`undefined guard(s): ${undef.join(', ')}. Define them with: crew guards add`);

  console.log(c.dim(`guards: ${names.join(', ')}`));
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
  let failed = false;
  for (const r of results) {
    if (r.ok) {
      console.log(`  ${c.green('✓')} ${r.n}`);
    } else {
      failed = true;
      console.log(`  ${c.red('✗')} ${r.n}: ${c.red(registry[r.n].message || 'guard failed')}`);
    }
  }
  if (failed) fail(`${results.filter((r) => !r.ok).length > 1 ? 'guards' : 'guard'} failed — nothing started.`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function cmdRun(flags, task, rest) {
  if (!task) fail('run: missing task name. Usage: crew run <task> [project...] [args]');
  const { cfg } = loadMerged(flags);
  // rest = bare project names + key=value placeholder args. No names -> picker.
  const names = rest.filter((a) => !a.includes('='));
  const args = rest.filter((a) => a.includes('='));
  const isLong = (cfg.longRunning || []).includes(task);
  const mode = isLong ? 'long-running' : 'run-to-completion';
  // For a co-running local set the picker shows a live wiring-connectivity footer.
  const members = await selectMembers(flags, cfg, names, { connectivity: isLong });
  if (!members) return;
  validateMemberPaths(members);

  // Restate the connectivity result once (the picker footer is erased on close; and the
  // explicit-names path has no picker), so a disconnected run is visible in scrollback.
  if (isLong) {
    const edges = dependencyEdges(cfg, Object.entries(cfg.projects));
    const w = connectivityStatus(cfg, edges, members.map((m) => m.name));
    if (w) console.log(w);
  }

  const { runnable, skipped } = resolveRun(cfg, task, members, args);
  for (const s of skipped) console.log(`skipping ${s} (no task '${task}')`);

  const label = members.map((m) => m.name).join(', ');
  const cmds = runnable.map((r) => `cd ${shellQuote(projectDir(r.project))} && ${r.resolved}`);

  if (flags.dryRun) {
    console.log(`# task '${task}' on: ${label} — mode: ${mode}`);
    const guardNames = [...new Set(runnable.flatMap((r) => r.project.guards || []))];
    if (guardNames.length) console.log(`# guards: ${guardNames.join(', ')}`);
    for (const r of runnable)
      console.log(`  ${r.name}: cd ${shellQuote(projectDir(r.project))} && ${r.resolved}`);
    return;
  }

  if (!flags.skipGuards) await runGuards(cfg, runnable);

  const paint = projectColors(cfg); // same per-project colors as `crew list`
  const commands = runnable.map((r, i) => ({
    command: cmds[i],
    name: r.name,
    color: paint.get(r.name) || ((s) => s),
  }));

  if (isLong) {
    // LONG-RUNNING: stream; the first exit (any) tears the whole group down; Ctrl-C too.
    const results = await runFanout(commands, { killOthers: true, announceExits: true });
    process.exit(exitCodeFromEvents(results));
  } else {
    // RUN-TO-COMPLETION: wait for all (no kill-others), then a pass/fail summary.
    const results = await runFanout(commands, { killOthers: false, announceExits: false });
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

async function cmdWorkspace(flags, rest) {
  const { cfg, userPath } = loadMerged(flags);
  const members = await selectMembers(flags, cfg, rest.filter((a) => !a.includes('=')));
  if (!members) return;
  validateMemberPaths(members);
  const dirs = dirList(members);

  if (flags.fileless) {
    if (flags.dryRun) {
      console.log(`code -n ${shellQuote(dirs[0])}`);
      if (dirs.length > 1) console.log(`code --add ${dirs.slice(1).map(shellQuote).join(' ')}`);
      return;
    }
    launch('code', ['-n', dirs[0]]);
    if (dirs.length > 1) launch('code', ['--add', ...dirs.slice(1)]);
    return;
  }

  const wsDir = join(crewHomeFor(userPath), 'workspaces');
  const wsFile = join(wsDir, `${selectionLabel(members)}.code-workspace`);
  const wsJson = { folders: dirs.map((p) => ({ path: p })), settings: {} };

  if (flags.dryRun) {
    console.log(`# workspace file: ${wsFile}`);
    console.log(JSON.stringify(wsJson, null, 2));
    return;
  }

  mkdirSync(wsDir, { recursive: true });
  writeFileSync(wsFile, JSON.stringify(wsJson, null, 2) + '\n');
  launch('code', [wsFile]);
}

async function cmdClaude(flags, rest) {
  const { cfg, userPath } = loadMerged(flags);
  const members = await selectMembers(flags, cfg, rest.filter((a) => !a.includes('=')));
  if (!members) return;
  validateMemberPaths(members);
  const dirs = dirList(members);

  // Stable, crew-owned cwd per selection. Claude Code keys its history off the cwd path
  // (~/.claude/projects/<cwd-slug>/), so a fixed dir keeps history tied to the SET of
  // projects (sorted, order-independent) — not the first member — and keeps it out of any
  // single project's folder. All projects stay reachable via the --add-dir list below.
  const cwd = join(crewHomeFor(userPath), 'sessions', selectionLabel(members));
  mkdirSync(cwd, { recursive: true });

  const cliArgs = [];
  for (const d of dirs) cliArgs.push('--add-dir', d);

  if (flags.dryRun) {
    console.log(`# cwd (stable, crew-managed): ${cwd}`);
    console.log(`claude ${cliArgs.map(shellQuote).join(' ')}`);
    return;
  }
  launch('claude', cliArgs, { cwd });
}

function cmdList(flags) {
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
function cmdDir(flags, arg) {
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

// Scan <dir>/.envs, parse each file's name as <env>[-<slug>] (slug optional; some projects
// name files plainly, e.g. `pre`, `qa`). Returns [{env, slug, path}].
function envFilesFor(dir) {
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
const URL_RE = /\bhttps?:\/\/[^\s"'`)}<]+/g;
// Split a URL into host + path (lowercased, scheme/port/query/trailing-slash dropped).
function urlHostPath(url) {
  const m = url.match(/^https?:\/\/([^/?#]+)([^?#\s]*)/i);
  if (!m) return null;
  const host = m[1].replace(/:\d+$/, '').toLowerCase();
  const path = (m[2] || '').replace(/\/+$/, '').toLowerCase();
  return { host, path };
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const glob = (s) => s.split('*').map(escapeRe).join('.*'); // `*` = any run of chars
// A match token is a WHOLE-host glob, optionally with a `/path` prefix. Split at the first
// `/`: the host part must match the ENTIRE URL host (anchored both ends) — write `*` exactly
// where the URL varies, e.g. `*svc.foo.io` (env prefix) or `svc-api*.foo.io` (env infix).
// Because it must reach the end of the host, `*bee-sdk-mcp.getbee.io` matches
// `qa-bee-sdk-mcp.getbee.io` but NOT `vpc-…-bee-sdk-mcp-….amazonaws.com`. The path part (if
// any) is matched as a prefix, so a shared gateway host is split by path. Returns the matched
// token's length (0 = no match) so the caller keeps the most specific token when several hit.
function tokenMatchLen(host, path, tok) {
  tok = String(tok).toLowerCase();
  if (!tok) return 0;
  const slash = tok.indexOf('/');
  const hostPat = slash === -1 ? tok : tok.slice(0, slash);
  const pathPat = slash === -1 ? '' : tok.slice(slash);
  if (!new RegExp('^' + glob(hostPat) + '$').test(host)) return 0;
  if (pathPat && !new RegExp('^' + glob(pathPat)).test(path)) return 0;
  return tok.length;
}

// crew graph [target] — read-only dependency graph derived from env files (no wiring).
// Each project's id comes ONLY from config `match` (whole-host glob patterns); edge P→T
// when a URL in P's envs matches one of T's patterns (see tokenMatchLen; most-specific
// token wins). Optional config `internalDomains: [..]` only affects the cosmetic "other
// hosts" list. localhost URLs match no id, so they drop out.
//
// No auto-guessing (folder/filename heuristics were dropped): a project with no `match` has
// no id, so nothing can point at it — it's flagged ⚠ until you add one.
function projectIdentity(project) {
  const tokens = Array.isArray(project.match) ? project.match.filter(Boolean) : [];
  return { tokens, source: tokens.length ? 'match' : 'none' };
}
function cmdGraph(flags, names) {
  const { cfg } = loadMerged(flags);
  const paint = projectColors(cfg);
  const projects =
    names && names.length
      ? membersFor(cfg, names).map((m) => [m.name, m.project])
      : Object.entries(cfg.projects || {});
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
        '     points at it: a `match` glob for its WHOLE hostname, with `*` written exactly',
        '     where the URL varies. E.g. qa-billing.example.com → match: ["*billing.example.com"].',
        '     No `match` = no id, so nothing can point at it (⚠).',
        '  2. Read every env file and pull out every http(s):// URL.',
        '  3. For each URL, test every `match` glob against its host. The glob must match the',
        '     WHOLE host, so `*billing.example.com` matches qa-billing.example.com but never',
        '     vpc-…-billing-….amazonaws.com. Add a `/path` to a token to split a gateway host.',
        '  4. The project with the longest (most specific) matching token gets the edge P → T.',
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
      '\n' + c.yellow('⚠ ') + c.dim('some projects have no `match` — add `match: ["*host.example.com"]` so peers can link to them.')
    );
}

function cmdConfig(flags, sub) {
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

const PROJECT_TYPES = ['frontend', 'backend', 'fullstack', 'other'];

// Prompt for every project field, defaulting to `existing` (empty object when adding).
// Text fields are inline-editable; type is a picked list; a blank runner/command unsets.
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

  let guards = existing.guards || [];
  if (guardNames.length) guards = await p.multiselect('Guards', guardNames, guards);

  const project = { path: path0, type };
  if (runner) project.runner = runner;
  if (Object.keys(tasks).length) project.tasks = tasks;
  if (guards && guards.length) project.guards = guards;
  return project;
}

// crew add — create a NEW project via wizard (errors if it exists).
async function cmdAdd(flags) {
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
async function cmdEdit(flags, name) {
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

async function cmdRemove(flags, name) {
  if (!name) fail('remove: missing name. Usage: crew remove <name>');
  const { cfg, path } = loadUserConfig(flags);
  if (!cfg.projects[name])
    fail(`no such project '${name}'.\n  projects: ${Object.keys(cfg.projects).join(', ') || '(none)'}`);

  if (!(await confirm(flags, `Delete project '${name}'?`))) return;
  delete cfg.projects[name];
  writeUserConfig(path, cfg);
  console.log(`Removed project '${name}'`);
}

// crew guards [target]           -> list all guards (or a target's), with usage
// crew guards add|remove|link|unlink -> wizard-driven management (selects, no hand-editing)
const GUARD_ACTIONS = ['add', 'remove', 'link', 'unlink'];
async function cmdGuards(flags, sub, rest) {
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
  const command = (await p.ask('Check command (exit 0 = pass)', '')).trim();
  if (!command) fail('guards: a command is required');
  const message = (await p.ask('Failure message', '')).trim();
  cfg.guards = cfg.guards || {};
  cfg.guards[name] = message ? { command, message } : { command };
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
  if (!flags.yes) {
    const yes = await p.ask(`Delete guard '${name}'? (y/N)`, '');
    if (!/^y/i.test(yes)) return void console.log('cancelled');
  }
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
// Small utilities
// ---------------------------------------------------------------------------
function sanitize(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, '_');
}

function launch(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { stdio: 'inherit', ...opts });
  if (r.error) {
    if (r.error.code === 'ENOENT')
      fail(`'${bin}' not found on PATH. Install it and try again.`);
    fail(`failed to launch '${bin}': ${r.error.message}`);
  }
  process.exit(r.status ?? 0);
}

function canInteractive() {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

// Arrow-key menu (needs an interactive TTY). Single-select returns the chosen item;
// multi-select returns the checked items in toggle order. Esc/q/Ctrl-C -> null.
// Up/Down (or k/j) move; Space toggles (multi); Enter confirms.
// `footer(selection)` (optional) returns a live status block redrawn on every keypress —
// `selection` is the checked items (multi) or the highlighted item. May be multi-line.
function menu({ title, items, label, multi = false, start = 0, preselected = [], footer = null }) {
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
function makePrompter() {
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

async function confirm(flags, question) {
  if (flags.yes) return true;
  const { ask, close } = makePrompter();
  try {
    const a = await ask(`${question} (y/N)`, '');
    return /^y/i.test(a);
  } finally {
    close();
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function help() {
  // Minimal color: bold section headers + cyan command names. Everything else is
  // default color. Padding is computed on the plain text, so alignment holds.
  const COL = 35;
  const cmd = (name, rest, desc) => {
    const sig = rest ? `${name} ${rest}` : name;
    const left = rest ? `${c.cyan(name)} ${rest}` : c.cyan(name);
    return `  ${left}${' '.repeat(Math.max(2, COL - sig.length))}${desc}`;
  };
  const ACTIONS = [
    ['help', '', 'Show this help (no args / -h / --help)'],
    ['list', '', 'List projects (alias: ls)'],
    ['install', '[project...]', 'Run the install task (= crew run install)'],
    ['start', '[project...] [args]', 'Run the start task (= crew run start)'],
    ['workspace', '[project...]', 'Open as one VSCode window (alias: code)'],
    ['claude', '[project...]', 'Launch Claude Code once (deduped dirs)'],
    ['run', '<task> [project...] [args]', 'Fan any task across the selected projects'],
    ['graph', '[project...]', 'Show the dependency graph derived from .envs'],
  ];
  const CONFIG = [
    ['add', '', 'Wizard: create a new project'],
    ['edit', '[name]', 'Wizard: modify an existing project'],
    ['remove', '<name>', 'Delete a project (-y, alias rm)'],
    ['guards', '[project]', 'List/manage guards (add/remove/link/unlink)'],
    ['dir', '[path]', 'Show/set the projects directory'],
    ['config', '[path|edit]', 'Print config / its path / open in $EDITOR'],
  ];
  const FLAGS = [
    ['--dry-run', 'Show what would run without executing'],
    ['--skip-guards', "Skip a target's guards"],
    ['--fileless', 'workspace: open windows instead of a workspace file'],
    ['--config <path>', 'Use a specific config file'],
    ['-y, --yes', 'Skip confirmation prompts'],
    ['-h, --help', 'This help'],
    ['-v, --version', 'Print version'],
  ];
  const EXAMPLES = [
    'crew add',
    'crew start                 # pick projects (preselected = last run)',
    'crew start rge-be rge-fe   # explicit set, no picker',
    'crew run build api',
    'crew start rge-be env=qa',
    'crew workspace',
    'crew claude',
  ];

  const L = [];
  L.push(`${c.bold('crew')} ${PKG.version} — fan a task across a group of local projects`);
  L.push('');
  L.push(c.bold('USAGE'));
  L.push('  crew <command> [project...] [args] [flags]');
  L.push('');
  L.push(c.bold('ACTIONS'));
  for (const [n, r, d] of ACTIONS) L.push(cmd(n, r, d));
  L.push('');
  L.push(c.bold('CONFIG'));
  for (const [n, r, d] of CONFIG) L.push(cmd(n, r, d));
  L.push('');
  L.push(c.bold('SELECTION'));
  L.push('  Name one or more projects, or omit them to pick interactively (multiselect,');
  L.push('  preselected with your last selection). The chosen set is remembered globally');
  L.push('  and reused across start/workspace/claude/run. For a co-running set, start warns');
  L.push('  if the selection isn\'t connected in the dependency graph.');
  L.push('');
  L.push(c.bold('TASKS'));
  L.push('  A task resolves per project: tasks[<task>] -> runner with {task} -> skip.');
  L.push('  Long-running tasks (config.longRunning, default: start/dev/watch) stream and');
  L.push('  tear down together on Ctrl-C. Others run to completion, then report pass/fail.');
  L.push('  Placeholders {name} are filled by key=value args (strict); bare tokens are');
  L.push('  project names, not values.');
  L.push('');
  L.push(c.bold('FLAGS'));
  for (const [f, d] of FLAGS) L.push(`  ${c.cyan(f)}${' '.repeat(Math.max(2, 18 - f.length))}${d}`);
  L.push('');
  L.push(c.bold('EXAMPLES'));
  for (const e of EXAMPLES) L.push('  ' + e);
  console.log(L.join('\n'));
}

// ---------------------------------------------------------------------------
// Arg parsing + dispatch
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const flags = {
    dryRun: false,
    fileless: false,
    yes: false,
    skipGuards: false,
    help: false,
    version: false,
    config: null,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--skip-guards') flags.skipGuards = true;
    else if (a === '--fileless') flags.fileless = true;
    else if (a === '-y' || a === '--yes') flags.yes = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else if (a === '-v' || a === '--version') flags.version = true;
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
  if (!cmd || flags.help) {
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
    case 'run':
      await cmdRun(flags, rest[0], rest.slice(1));
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
    case 'dir':
      cmdDir(flags, rest[0]);
      return;
    case 'graph':
      cmdGraph(flags, rest);
      return;
    case 'config':
      cmdConfig(flags, rest[0]);
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
