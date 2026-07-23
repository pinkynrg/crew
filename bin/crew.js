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
    groups: {},
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
  if (!cfg.groups) {
    cfg.groups = {};
    changed = true;
  }
  if (!cfg.workspaceName) {
    cfg.workspaceName = 'crew';
    changed = true;
  }
  // Self-heal: drop fields removed in later versions so a config edited by an older crew
  // gets cleaned up (and written back) the first time a newer crew loads it.
  const DEPRECATED_PROJECT_FIELDS = ['relatedDirs', 'cwd', 'start'];
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
  if (migrate(cfg)) {
    try {
      writeUserConfig(path, cfg);
    } catch {
      /* read-only fs — proceed with the in-memory migration */
    }
  }
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
    Object.assign(merged.groups, local.groups || {});
    localUsed = localPath;
  }
  return { cfg: merged, userPath: path, localPath: localUsed };
}

// ---------------------------------------------------------------------------
// Target resolution — group FIRST, then single project (bare project = group of one).
// ---------------------------------------------------------------------------
function resolveTarget(cfg, name) {
  if (cfg.groups && cfg.groups[name]) {
    const members = cfg.groups[name];
    const missing = members.filter((p) => !cfg.projects[p]);
    if (missing.length)
      fail(`group '${name}' references unknown project(s): ${missing.join(', ')}`);
    return {
      kind: 'group',
      name,
      members: members.map((p) => ({ name: p, project: cfg.projects[p] })),
    };
  }
  if (cfg.projects && cfg.projects[name]) {
    return { kind: 'project', name, members: [{ name, project: cfg.projects[name] }] };
  }
  const groups = Object.keys(cfg.groups || {});
  const projects = Object.keys(cfg.projects || {});
  fail(
    `unknown target '${name}'.\n` +
      `  groups:   ${groups.join(', ') || '(none)'}\n` +
      `  projects: ${projects.join(', ') || '(none)'}` +
      (groups.length || projects.length ? '' : '\n  Nothing configured yet — run: crew add')
  );
}

// Verify every member's path exists. Names the offending project.
function validateMemberPaths(members) {
  for (const m of members) {
    const p = resolvePath(m.project.path);
    if (!pathExists(p)) fail(`project '${m.name}': path not found: ${p}`);
  }
}

// Build a deduped absolute-path list of member project paths, first-seen order.
function dirList(members) {
  const seen = new Set();
  const out = [];
  for (const m of members) {
    const abs = resolvePath(m.project.path);
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

function projectDir(project) {
  return resolvePath(project.path);
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
// -> SIGKILL escalation and double-Ctrl-C force-kill. crew never forwards stdin, so
// detaching the children (which removes them from the TTY foreground group) is safe;
// we forward SIGINT/SIGTERM/SIGHUP to each group ourselves.
// ---------------------------------------------------------------------------
const KILL_GRACE_MS = Number(process.env.CREW_KILL_GRACE_MS) || 5000;

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
    const timers = [];
    let aborting = false;
    let sigints = 0;

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
      let s = '';
      for (const ch of text) {
        if (lastWrite.char === '\n') s += proc._prefix;
        s += ch;
        lastWrite.char = ch;
      }
      lastWrite.proc = proc;
      rawWrite(s);
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
        if (sig === 'SIGINT' && ++sigints >= 2) return forceKill();
        tearDown(sig === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
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
// Commands
// ---------------------------------------------------------------------------
async function cmdRun(flags, task, targetName, args) {
  if (!task) fail('run: missing task name. Usage: crew run <task> <target> [args]');
  if (!targetName) fail(`run: missing target. Usage: crew run ${task} <target> [args]`);
  const { cfg } = loadMerged(flags);
  const target = resolveTarget(cfg, targetName);
  validateMemberPaths(target.members);

  const { runnable, skipped } = resolveRun(cfg, task, target.members, args);
  for (const s of skipped) console.log(`skipping ${s} (no task '${task}')`);

  const isLong = (cfg.longRunning || []).includes(task);
  const mode = isLong ? 'long-running' : 'run-to-completion';

  const cmds = runnable.map((r) => `cd ${shellQuote(projectDir(r.project))} && ${r.resolved}`);

  if (flags.dryRun) {
    console.log(`# task '${task}' on ${target.kind} '${target.name}' — mode: ${mode}`);
    for (const r of runnable)
      console.log(`  ${r.name}: cd ${shellQuote(projectDir(r.project))} && ${r.resolved}`);
    return;
  }

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

async function cmdWorkspace(flags, targetName) {
  if (!targetName) fail('workspace: missing target. Usage: crew workspace <target> [--fileless]');
  const { cfg, userPath } = loadMerged(flags);
  const target = resolveTarget(cfg, targetName);
  validateMemberPaths(target.members);
  const dirs = dirList(target.members);

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
  const wsFile = join(wsDir, `${sanitize(target.name)}.code-workspace`);
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

async function cmdClaude(flags, targetName) {
  if (!targetName) fail('claude: missing target. Usage: crew claude <target>');
  const { cfg, userPath } = loadMerged(flags);
  const target = resolveTarget(cfg, targetName);
  validateMemberPaths(target.members);
  const dirs = dirList(target.members);

  // Stable, crew-owned cwd per target. Claude Code keys its history off the cwd path
  // (~/.claude/projects/<cwd-slug>/), so a fixed dir keeps history tied to the TARGET
  // NAME — not the first member — surviving any reordering of the group's projects,
  // and keeps it out of any single project's folder. All projects stay reachable via
  // the --add-dir list below.
  const cwd = join(crewHomeFor(userPath), 'sessions', sanitize(target.name));
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
  const groups = Object.entries(cfg.groups || {});
  const longRunning = new Set(cfg.longRunning || []);
  const paint = projectColors(cfg);
  if (projects.length === 0 && groups.length === 0) {
    console.log(c.dim('No projects or groups configured yet.'));
    console.log(`Run ${c.cyan('crew add')} to add one.`);
    return;
  }

  // --- Projects -------------------------------------------------------------
  console.log(c.bold(c.underline('Projects')));
  if (projects.length === 0) console.log(c.dim('  (none)'));
  const nameW = Math.max(0, ...projects.map(([n]) => n.length));
  const typeW = Math.max(0, ...projects.map(([, p]) => (p.type || 'other').length));
  for (const [name, p] of projects) {
    const abs = resolvePath(p.path);
    const ok = pathExists(abs);
    const dot = ok ? c.green('●') : c.red('●');
    const type = p.type || 'other';
    const nameCell = c.bold(paint.get(name)(name.padEnd(nameW)));
    const typeCell = c.dim(type.padEnd(typeW));
    const pathCell = ok ? c.dim(tildify(abs)) : c.red(tildify(abs) + '  ✗ missing');
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
  }

  // --- Groups (members painted with each project's own stable color) --------
  console.log('\n' + c.bold(c.underline('Groups')));
  if (groups.length === 0) console.log(c.dim('  (none)'));
  const known = new Set(Object.keys(cfg.projects || {}));
  const gW = Math.max(0, ...groups.map(([n]) => n.length));
  for (const [name, members] of groups) {
    const mem = members
      .map((m) => (known.has(m) ? paint.get(m)(m) : c.red(m + '?')))
      .join(c.dim(', '));
    console.log(`  ${c.bold(name.padEnd(gW))}  ${c.dim('→')}  ${mem}`);
  }

  // --- Footer ---------------------------------------------------------------
  const lr = (cfg.longRunning || []).map((t) => c.yellow(t)).join(c.dim(', ')) || c.dim('(none)');
  console.log('\n' + c.dim('long-running  ') + lr);
  console.log(
    c.dim('config        ') +
      c.dim(tildify(userConfigPath(flags))) +
      (localPath ? c.dim(`  (+ ${tildify(localPath)})`) : '')
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
async function collectProject(p, existing) {
  const path0 = await p.ask('Path', existing.path || '');
  if (!path0) fail('a path is required');
  const abs = resolvePath(path0);
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

  const project = { path: path0, type };
  if (runner) project.runner = runner;
  if (Object.keys(tasks).length) project.tasks = tasks;
  return project;
}

// Pick an ordered member list from existing projects (multi-select on a TTY).
async function collectMembers(p, cfg, existing) {
  const known = Object.keys(cfg.projects || {});
  if (!known.length) fail('no projects exist yet — add a project first');
  const members = await p.multiselect('Members', known, existing || []);
  const missing = members.filter((m) => !cfg.projects[m]);
  if (missing.length) fail(`unknown project(s): ${missing.join(', ')}. Known: ${known.join(', ')}`);
  return members;
}

// crew add — create a NEW project or group entirely via wizard (errors if it exists).
async function cmdAdd(flags) {
  const { cfg, path } = loadUserConfig(flags);
  const p = makePrompter();
  try {
    const kind = await p.select('Add a project or a group?', ['project', 'group'], 'project');
    const name = (await p.ask(`${kind === 'group' ? 'Group' : 'Project'} name`, '')).trim();
    if (!name) fail(`add: a ${kind} name is required`);
    if (cfg.projects[name] || cfg.groups[name])
      fail(`'${name}' already exists. Use: crew edit ${name}`);

    if (kind === 'group') {
      const members = await collectMembers(p, cfg, []);
      if (!members.length) fail('add: a group needs at least one member');
      cfg.groups[name] = members;
      writeUserConfig(path, cfg);
      console.log(`\nSaved group '${name}' -> ${members.join(', ')}`);
    } else {
      cfg.projects[name] = await collectProject(p, {});
      writeUserConfig(path, cfg);
      console.log(`\nSaved project '${name}' to ${path}`);
    }
  } finally {
    p.close();
  }
}

// crew edit [name] — modify an EXISTING project or group via wizard (errors if absent).
async function cmdEdit(flags, name) {
  const { cfg, path } = loadUserConfig(flags);
  const projects = Object.keys(cfg.projects || {});
  const groups = Object.keys(cfg.groups || {});
  if (!projects.length && !groups.length) fail('edit: nothing to edit yet. Run: crew add');

  const p = makePrompter();
  try {
    // No name given: pick from a list — arrow keys when interactive, else typed.
    if (!name) {
      const items = [
        ...projects.map((n) => ({ name: n, kind: 'project' })),
        ...groups.map((n) => ({ name: n, kind: 'group' })),
      ];
      if (canInteractive()) {
        const picked = await menu({
          title: 'Edit which?',
          items,
          label: (it, cur) => `${cur ? c.bold(it.name) : it.name} ${c.dim('— ' + it.kind)}`,
        });
        if (!picked) {
          console.log('edit: cancelled');
          return;
        }
        name = picked.name;
      } else {
        console.log('Projects: ' + (projects.join(', ') || '(none)'));
        console.log('Groups:   ' + (groups.join(', ') || '(none)'));
        name = (await p.ask('Name to edit', '')).trim();
      }
    }
    if (!name) fail('edit: a name is required');

    const isGroup = !!cfg.groups[name];
    const isProject = !!cfg.projects[name];
    if (!isGroup && !isProject) fail(`no such project or group '${name}'. Run: crew add`);

    if (isGroup) {
      const members = await collectMembers(p, cfg, cfg.groups[name]);
      if (!members.length) fail('edit: a group needs at least one member');
      cfg.groups[name] = members;
      writeUserConfig(path, cfg);
      console.log(`\nUpdated group '${name}' -> ${members.join(', ')}`);
    } else {
      cfg.projects[name] = await collectProject(p, cfg.projects[name]);
      writeUserConfig(path, cfg);
      console.log(`\nUpdated project '${name}' in ${path}`);
    }
  } finally {
    p.close();
  }
}

// Names are unique across projects and groups, so one command removes either.
async function cmdRemove(flags, name) {
  if (!name) fail('remove: missing name. Usage: crew remove <name>');
  const { cfg, path } = loadUserConfig(flags);
  const isGroup = !!cfg.groups[name];
  const isProject = !!cfg.projects[name];
  if (isGroup && isProject)
    fail(`'${name}' exists as both a group and a project (legacy config); edit ${path} by hand.`);
  if (!isGroup && !isProject)
    fail(
      `no such project or group '${name}'.\n` +
        `  projects: ${Object.keys(cfg.projects).join(', ') || '(none)'}\n` +
        `  groups:   ${Object.keys(cfg.groups).join(', ') || '(none)'}`
    );

  const kind = isGroup ? 'group' : 'project';
  if (!(await confirm(flags, `Delete ${kind} '${name}'?`))) return;

  let referencing = [];
  if (isGroup) {
    delete cfg.groups[name];
  } else {
    delete cfg.projects[name];
    referencing = Object.entries(cfg.groups)
      .filter(([, m]) => m.includes(name))
      .map(([g]) => g);
  }
  writeUserConfig(path, cfg);
  console.log(`Removed ${kind} '${name}'`);
  if (referencing.length)
    console.log(`NOTE: still referenced by group(s): ${referencing.join(', ')}`);
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
function menu({ title, items, label, multi = false, start = 0, preselected = [] }) {
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

    const render = (first) => {
      if (!first) out.write(`\x1b[${items.length}A`);
      items.forEach((it, i) => {
        const cursor = i === idx;
        const ptr = cursor ? c.cyan('❯ ') : '  ';
        const box = multi ? (checked.has(it) ? c.green('◉ ') : '◯ ') : '';
        out.write(`\x1b[2K${ptr}${box}${label(it, cursor)}\n`);
      });
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
    ['list', '', 'List projects and groups (alias: ls)'],
    ['install', '<project|group>', 'Run the install task (= crew run install)'],
    ['start', '<project|group> [args]', 'Run the start task (= crew run start)'],
    ['workspace', '<project|group>', 'Open as one VSCode window (alias: code)'],
    ['claude', '<project|group>', 'Launch Claude Code once (deduped dirs)'],
    ['run', '<task> <project|group> [args]', 'Fan any task across a project/group'],
  ];
  const CONFIG = [
    ['add', '', 'Wizard: create a new project or group'],
    ['edit', '[name]', 'Wizard: modify an existing project or group'],
    ['remove', '<name>', 'Delete a project or group (-y, alias rm)'],
    ['config', '[path|edit]', 'Print config / its path / open in $EDITOR'],
  ];
  const FLAGS = [
    ['--dry-run', 'Show what would run without executing'],
    ['--fileless', 'workspace: open windows instead of a workspace file'],
    ['--config <path>', 'Use a specific config file'],
    ['-y, --yes', 'Skip confirmation prompts'],
    ['-h, --help', 'This help'],
    ['-v, --version', 'Print version'],
  ];
  const EXAMPLES = [
    'crew add',
    'crew edit full',
    'crew run install full',
    'crew run build api',
    'crew start checkout env=qa',
    'crew workspace full',
    'crew claude full',
  ];

  const L = [];
  L.push(`${c.bold('crew')} ${PKG.version} — fan a task across a group of local projects`);
  L.push('');
  L.push(c.bold('USAGE'));
  L.push('  crew <command> [project|group] [args] [flags]');
  L.push('');
  L.push(c.bold('ACTIONS'));
  for (const [n, r, d] of ACTIONS) L.push(cmd(n, r, d));
  L.push('');
  L.push(c.bold('CONFIG'));
  for (const [n, r, d] of CONFIG) L.push(cmd(n, r, d));
  L.push('');
  L.push(c.bold('PROJECT | GROUP'));
  L.push('  A single project name OR a group name (a bare project = a group of one).');
  L.push('  Resolved group-first, then project. Names are unique across the two.');
  L.push('');
  L.push(c.bold('TASKS'));
  L.push('  A task resolves per project: tasks[<task>] -> runner with {task} -> skip.');
  L.push('  Long-running tasks (config.longRunning, default: start/dev/watch) stream and');
  L.push('  tear down together on Ctrl-C. Others run to completion, then report pass/fail.');
  L.push('  Placeholders {name} are filled by args: bare positional or key=value (strict).');
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
    help: false,
    version: false,
    config: null,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
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
      await cmdRun(flags, rest[0], rest[1], rest.slice(2));
      return;
    case 'start':
      await cmdRun(flags, 'start', rest[0], rest.slice(1));
      return;
    case 'install':
      await cmdRun(flags, 'install', rest[0], rest.slice(1));
      return;
    case 'workspace':
    case 'code':
      await cmdWorkspace(flags, rest[0]);
      return;
    case 'claude':
      await cmdClaude(flags, rest[0]);
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
