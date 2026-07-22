#!/usr/bin/env node
// crew — fan a named task out across a group of local projects, open them as one
// VSCode workspace, or hand the set to Claude Code. Driven by one persistent config.
//
// Only third-party dependency: `concurrently` (the parallel-run engine). Everything
// else is Node built-ins. See README for the full model.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
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
function hexForIndex(i) {
  const [r, g, b] = rgbForIndex(i);
  const h = (v) => v.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
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
// Same rank -> the color as a #rrggbb string, for concurrently's prefixColor.
function projectHexes(cfg) {
  const names = Object.keys(cfg.projects || {}).sort();
  const map = new Map();
  names.forEach((n, i) => map.set(n, hexForIndex(i)));
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
    // v1 -> v2: a project's single `start` block becomes tasks.start (+ cwd).
    for (const p of Object.values(cfg.projects || {})) {
      if (p && p.start && typeof p.start === 'object') {
        p.tasks = p.tasks || {};
        if (p.start.command && p.tasks.start == null) p.tasks.start = p.start.command;
        if (p.start.cwd && p.cwd == null) p.cwd = p.start.cwd;
        delete p.start; // defaults/allowed dropped: v2 fills placeholders from args only
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

// Verify every member's path and relatedDirs exist. Names the offending project.
function validateMemberPaths(members) {
  for (const m of members) {
    const p = resolvePath(m.project.path);
    if (!pathExists(p)) fail(`project '${m.name}': path not found: ${p}`);
    for (const d of m.project.relatedDirs || []) {
      const rd = resolvePath(d);
      if (!pathExists(rd)) fail(`project '${m.name}': relatedDir not found: ${rd}`);
    }
  }
}

// Build a deduped absolute-path list (project path + relatedDirs), first-seen order.
function dirList(members) {
  const seen = new Set();
  const out = [];
  for (const m of members) {
    for (const raw of [m.project.path, ...(m.project.relatedDirs || [])]) {
      const abs = resolvePath(raw);
      if (!seen.has(abs)) {
        seen.add(abs);
        out.push(abs);
      }
    }
  }
  return out;
}

function projectCwd(project) {
  return resolvePath(project.cwd || project.path);
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

  const unknown = Object.keys(keyVals).filter((k) => !union.has(k));
  if (unknown.length)
    fail(
      `unknown argument key(s): ${unknown.join(', ')}. ` +
        `Task '${task}' placeholders: ${[...union].join(', ') || '(none)'}`
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
// concurrently — resolved locally (dependency of this package), never via npx.
// ---------------------------------------------------------------------------
async function loadConcurrently() {
  try {
    const mod = await import('concurrently');
    return mod.default || mod;
  } catch {
    fail("'concurrently' is not installed. Reinstall crew (npm i -g crew) or run via npx.");
  }
}

function exitCodeFromEvents(events) {
  if (!Array.isArray(events)) return 1;
  let killedBySignal = false;
  for (const e of events) {
    const code = e && e.exitCode;
    if (typeof code === 'number' && code !== 0) return code;
    if (typeof code === 'string') killedBySignal = true; // e.g. 'SIGINT'
  }
  return killedBySignal ? 130 : 1;
}

function ccCommandPreview(names, cmds, killOthers) {
  const parts = ['concurrently'];
  if (killOthers) parts.push('--kill-others');
  parts.push('--names', names.join(','));
  for (const c of cmds) parts.push(JSON.stringify(c));
  return parts.join(' ');
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

  const cmds = runnable.map((r) => `cd ${shellQuote(projectCwd(r.project))} && ${r.resolved}`);
  const names = runnable.map((r) => r.name);

  if (flags.dryRun) {
    console.log(`# task '${task}' on ${target.kind} '${target.name}' — mode: ${mode}`);
    for (const r of runnable)
      console.log(`  ${r.name}: cd ${shellQuote(projectCwd(r.project))} && ${r.resolved}`);
    console.log('\n' + ccCommandPreview(names, cmds, isLong));
    return;
  }

  const concurrently = await loadConcurrently();
  const hexes = projectHexes(cfg); // same per-project colors as `crew list`
  const commands = runnable.map((r, i) => ({
    command: cmds[i],
    name: r.name,
    prefixColor: hexes.get(r.name),
  }));

  if (isLong) {
    // LONG-RUNNING: stream, --kill-others, Ctrl-C tears the whole group down.
    const { result } = concurrently(commands, {
      prefix: 'name',
      killOthersOn: ['failure', 'success'],
    });
    try {
      await result;
      process.exit(0);
    } catch (events) {
      process.exit(exitCodeFromEvents(events));
    }
  } else {
    // RUN-TO-COMPLETION: wait for all, no --kill-others, then a pass/fail summary.
    const { result } = concurrently(commands, { prefix: 'name' });
    let events;
    let ok = true;
    try {
      events = await result;
    } catch (e) {
      events = Array.isArray(e) ? e : null;
      ok = false;
    }
    console.log(`\ncrew: task '${task}' results`);
    const byName = new Map();
    for (const e of events || []) byName.set(e.command?.name ?? e.index, e.exitCode);
    let anyFailed = false;
    for (const r of runnable) {
      const code = byName.has(r.name) ? byName.get(r.name) : ok ? 0 : '?';
      const passed = code === 0;
      if (!passed) anyFailed = true;
      console.log(`  ${passed ? '✓' : '✗'} ${r.name} (exit ${code})`);
    }
    process.exit(anyFailed || !ok ? 1 : 0);
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
  const { cfg } = loadMerged(flags);
  const target = resolveTarget(cfg, targetName);
  validateMemberPaths(target.members);
  const dirs = dirList(target.members);
  const cwd = projectCwd(target.members[0].project);

  const cliArgs = [];
  for (const d of dirs) cliArgs.push('--add-dir', d);

  if (flags.dryRun) {
    console.log(`# cwd: ${cwd}`);
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

function normalizeKind(s) {
  const v = String(s).trim().toLowerCase();
  if (v.startsWith('g')) return 'group';
  if (v.startsWith('p')) return 'project';
  fail(`answer 'project' or 'group' (got '${s}')`);
}

// Prompt for every project field, defaulting to `existing` (empty object when adding).
async function collectProject(ask, existing) {
  const path0 = await ask('Path', existing.path || '');
  if (!path0) fail('a path is required');
  const abs = resolvePath(path0);
  if (!pathExists(abs)) {
    const keep = await ask(`Path does not exist (${abs}). Save anyway? (y/N)`, 'N');
    if (!/^y/i.test(keep)) fail('aborted (path does not exist)');
  }
  const type = await ask('Type (frontend/backend/fullstack/other)', existing.type || 'other');
  const relatedRaw = await ask(
    'Related dirs (comma-separated, blank for none)',
    (existing.relatedDirs || []).join(', ')
  );
  const relatedDirs = relatedRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const cwd = await ask('Working dir for tasks (blank = path)', existing.cwd || '');
  const runner = await ask(
    'Default runner template (e.g. "npm run {task}" or "make {task}", blank = run-less)',
    existing.runner || ''
  );
  const tasks = { ...(existing.tasks || {}) };
  console.log('Explicit task overrides (blank task name to finish; "-" to drop one):');
  for (;;) {
    const t = (await ask('  Task name', '')).trim();
    if (!t) break;
    const cmd = await ask(`  Command for '${t}'`, tasks[t] || '');
    if (cmd === '-') delete tasks[t];
    else if (cmd) tasks[t] = cmd;
  }
  const project = { path: path0, type, relatedDirs };
  if (cwd) project.cwd = cwd;
  if (runner) project.runner = runner;
  if (Object.keys(tasks).length) project.tasks = tasks;
  return project;
}

// Prompt for an ordered member list, validated against existing projects.
async function collectMembers(ask, cfg, existing) {
  const known = Object.keys(cfg.projects || {});
  if (!known.length) fail('no projects exist yet — add a project first');
  console.log('Available projects: ' + known.join(', '));
  const raw = await ask('Members (space/comma separated, ordered)', (existing || []).join(' '));
  const members = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const missing = members.filter((m) => !cfg.projects[m]);
  if (missing.length) fail(`unknown project(s): ${missing.join(', ')}. Known: ${known.join(', ')}`);
  return members;
}

// crew add — create a NEW project or group entirely via wizard (errors if it exists).
async function cmdAdd(flags) {
  const { cfg, path } = loadUserConfig(flags);
  const { ask, close } = makeAsker();
  try {
    const kind = normalizeKind(await ask('Add a project or a group? (project/group)', 'project'));
    const name = (await ask(`${kind === 'group' ? 'Group' : 'Project'} name`, '')).trim();
    if (!name) fail(`add: a ${kind} name is required`);
    if (cfg.projects[name] || cfg.groups[name])
      fail(`'${name}' already exists. Use: crew edit ${name}`);

    if (kind === 'group') {
      const members = await collectMembers(ask, cfg, []);
      if (!members.length) fail('add: a group needs at least one member');
      cfg.groups[name] = members;
      writeUserConfig(path, cfg);
      console.log(`\nSaved group '${name}' -> ${members.join(', ')}`);
    } else {
      cfg.projects[name] = await collectProject(ask, {});
      writeUserConfig(path, cfg);
      console.log(`\nSaved project '${name}' to ${path}`);
    }
  } finally {
    close();
  }
}

// crew edit [name] — modify an EXISTING project or group via wizard (errors if absent).
async function cmdEdit(flags, name) {
  const { cfg, path } = loadUserConfig(flags);
  const projects = Object.keys(cfg.projects || {});
  const groups = Object.keys(cfg.groups || {});
  if (!projects.length && !groups.length) fail('edit: nothing to edit yet. Run: crew add');

  // No name given: pick from a list — arrow keys when interactive, else typed.
  if (!name) {
    const items = [
      ...projects.map((n) => ({ name: n, kind: 'project' })),
      ...groups.map((n) => ({ name: n, kind: 'group' })),
    ];
    if (canInteractive()) {
      const picked = await pickFromList('Edit which?', items, (it, sel) => {
        const nm = sel ? c.bold(it.name) : it.name;
        return `${nm} ${c.dim('— ' + it.kind)}`;
      });
      if (!picked) {
        console.log('edit: cancelled');
        return;
      }
      name = picked.name;
    } else {
      const { ask, close } = makeAsker();
      try {
        console.log('Projects: ' + (projects.join(', ') || '(none)'));
        console.log('Groups:   ' + (groups.join(', ') || '(none)'));
        name = (await ask('Name to edit', '')).trim();
      } finally {
        close();
      }
    }
  }
  if (!name) fail('edit: a name is required');

  const { ask, close } = makeAsker();
  try {
    const isGroup = !!cfg.groups[name];
    const isProject = !!cfg.projects[name];
    if (!isGroup && !isProject) fail(`no such project or group '${name}'. Run: crew add`);

    if (isGroup) {
      const members = await collectMembers(ask, cfg, cfg.groups[name]);
      if (!members.length) fail('edit: a group needs at least one member');
      cfg.groups[name] = members;
      writeUserConfig(path, cfg);
      console.log(`\nUpdated group '${name}' -> ${members.join(', ')}`);
    } else {
      cfg.projects[name] = await collectProject(ask, cfg.projects[name]);
      writeUserConfig(path, cfg);
      console.log(`\nUpdated project '${name}' in ${path}`);
    }
  } finally {
    close();
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

// A line reader that works over BOTH an interactive TTY and piped/scripted stdin.
// (readline/promises' question() only resolves its FIRST call over a non-TTY pipe,
// so we consume 'line' events directly and queue them.)
function makeAsker() {
  const rl = createInterface({ input, output });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => {
    if (waiters.length) waiters.shift()(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  const ask = async (q, def) => {
    const suffix = def != null && def !== '' ? ` [${def}]` : '';
    output.write(`${q}${suffix}: `);
    let line;
    if (queue.length) line = queue.shift();
    else if (closed) line = null;
    else line = await new Promise((res) => waiters.push(res));
    if (line == null) return def ?? ''; // EOF -> take default
    const a = line.trim();
    return a === '' ? (def ?? '') : a;
  };
  return { ask, close: () => rl.close() };
}

async function confirm(flags, question) {
  if (flags.yes) return true;
  const { ask, close } = makeAsker();
  try {
    const a = await ask(`${question} (y/N)`, 'N');
    return /^y/i.test(a);
  } finally {
    close();
  }
}

// Arrow-key selectable list. Needs an interactive TTY (raw mode); callers fall back to a
// typed prompt otherwise. Up/down (or k/j) move, Enter picks, Esc/q/Ctrl-C cancel (null).
function canInteractive() {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}
function pickFromList(title, items, label) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const out = process.stdout;
    let idx = 0;
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    out.write(`${title}${c.dim('  (↑/↓ to move, Enter to pick, Esc to cancel)')}\n`);
    out.write('\x1b[?25l'); // hide cursor

    const render = (first) => {
      if (!first) out.write(`\x1b[${items.length}A`);
      items.forEach((it, i) => {
        const sel = i === idx;
        const ptr = sel ? c.cyan('❯ ') : '  ';
        out.write(`\x1b[2K${ptr}${label(it, sel)}\n`);
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
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(items[idx]);
      } else if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup();
        resolve(null);
      }
    };
    stdin.on('keypress', onKey);
  });
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
      console.error(`crew: unknown command '${cmd}'\n`);
      help();
      process.exitCode = 1;
      return;
  }
}

main().catch((err) => {
  if (err instanceof CrewError) {
    console.error(`crew: ${err.message}`);
    process.exit(1);
  }
  console.error(`crew: unexpected error: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
