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
import { stdin as input, stdout as output } from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

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
      (groups.length || projects.length ? '' : '\n  Nothing configured yet — run: crew init')
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
  const commands = runnable.map((r, i) => ({ command: cmds[i], name: r.name }));

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
  const { cfg } = loadMerged(flags);
  const projects = Object.entries(cfg.projects || {});
  const groups = Object.entries(cfg.groups || {});
  if (projects.length === 0 && groups.length === 0) {
    console.log('No projects or groups configured yet.\nRun: crew init');
    return;
  }
  console.log('Projects:');
  if (projects.length === 0) console.log('  (none)');
  for (const [name, p] of projects) {
    const abs = resolvePath(p.path);
    const exists = pathExists(abs) ? '✓' : '✗ MISSING';
    console.log(`  ${name}  [${p.type || 'other'}]  ${abs}  ${exists}`);
    if (p.runner) console.log(`      runner: ${p.runner}`);
    for (const [t, c] of Object.entries(p.tasks || {})) console.log(`      task ${t}: ${c}`);
    if (!p.runner && !Object.keys(p.tasks || {}).length) console.log('      (run-less)');
  }
  console.log('\nGroups:');
  if (groups.length === 0) console.log('  (none)');
  for (const [name, members] of groups) console.log(`  ${name} -> ${members.join(', ')}`);
  console.log(`\nLong-running tasks: ${(cfg.longRunning || []).join(', ') || '(none)'}`);
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

async function cmdInit(flags, projectName) {
  const { cfg, path } = loadUserConfig(flags);
  const { ask, close } = makeAsker();
  try {
    const name = (projectName || (await ask('Project name', ''))).trim();
    if (!name) fail('init: a project name is required');
    const existing = cfg.projects[name] || {};
    if (cfg.groups[name])
      console.log(`WARNING: '${name}' is also a group name — the group shadows this project.`);
    if (cfg.projects[name]) console.log(`(updating existing project '${name}')`);

    let path0 = await ask('Path', existing.path || '');
    if (!path0) fail('init: a path is required');
    const abs = resolvePath(path0);
    if (!pathExists(abs)) {
      const keep = await ask(`Path does not exist (${abs}). Save anyway? (y/N)`, 'N');
      if (!/^y/i.test(keep)) fail('init: aborted (path does not exist)');
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
    console.log('Explicit task overrides (blank task name to finish):');
    for (;;) {
      const t = (await ask('  Task name', '')).trim();
      if (!t) break;
      const c = await ask(`  Command for '${t}'`, tasks[t] || '');
      if (c) tasks[t] = c;
    }

    const project = { path: path0, type, relatedDirs };
    if (cwd) project.cwd = cwd;
    if (runner) project.runner = runner;
    if (Object.keys(tasks).length) project.tasks = tasks;

    cfg.projects[name] = project;
    writeUserConfig(path, cfg);
    console.log(`\nSaved project '${name}' to ${path}`);
  } finally {
    close();
  }
}

function cmdGroup(flags, groupName, members) {
  if (!groupName) fail('group: missing name. Usage: crew group <name> <project ...>');
  const { cfg, path } = loadUserConfig(flags);

  if (members.length === 0) {
    if (cfg.groups[groupName]) {
      console.log(`${groupName} -> ${cfg.groups[groupName].join(', ')}`);
      return;
    }
    fail(`no such group '${groupName}'. Provide members to create it: crew group ${groupName} <project ...>`);
  }

  const missing = members.filter((m) => !cfg.projects[m]);
  if (missing.length)
    fail(
      `unknown project(s): ${missing.join(', ')}. ` +
        `Known: ${Object.keys(cfg.projects).join(', ') || '(none)'}`
    );
  if (cfg.projects[groupName])
    console.log(`WARNING: '${groupName}' is also a project name — the group shadows it.`);

  cfg.groups[groupName] = members;
  writeUserConfig(path, cfg);
  console.log(`Saved group '${groupName}' -> ${members.join(', ')}`);
}

async function cmdRemove(flags, projectName) {
  if (!projectName) fail('remove: missing project name. Usage: crew remove <project>');
  const { cfg, path } = loadUserConfig(flags);
  if (!cfg.projects[projectName])
    fail(`no such project '${projectName}'. Known: ${Object.keys(cfg.projects).join(', ') || '(none)'}`);
  if (!(await confirm(flags, `Delete project '${projectName}'?`))) return;
  delete cfg.projects[projectName];
  const referencing = Object.entries(cfg.groups)
    .filter(([, m]) => m.includes(projectName))
    .map(([g]) => g);
  writeUserConfig(path, cfg);
  console.log(`Removed project '${projectName}'`);
  if (referencing.length)
    console.log(`NOTE: still referenced by group(s): ${referencing.join(', ')}`);
}

async function cmdRemoveGroup(flags, groupName) {
  if (!groupName) fail('remove-group: missing group name. Usage: crew remove-group <name>');
  const { cfg, path } = loadUserConfig(flags);
  if (!cfg.groups[groupName])
    fail(`no such group '${groupName}'. Known: ${Object.keys(cfg.groups).join(', ') || '(none)'}`);
  if (!(await confirm(flags, `Delete group '${groupName}'?`))) return;
  delete cfg.groups[groupName];
  writeUserConfig(path, cfg);
  console.log(`Removed group '${groupName}'`);
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

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function help() {
  console.log(`crew ${PKG.version} — fan a task across a group of local projects

USAGE
  crew <command> [target] [args] [flags]

COMMANDS
  help                              Show this help (also: no args, -h, --help)
  list                              List projects and groups            (alias: ls)
  run <task> <target> [args]        Fan <task> out across the target
  start <target> [args]             = crew run start <target>
  install <target>                  = crew run install <target>
  workspace <target> [--fileless]   Open target as one VSCode window    (alias: code)
  claude <target>                   Launch Claude Code once with --add-dir per dir
  init [project]                    Wizard: add/update a project
  group <name> <project ...>        Create/update a group (no members = print it)
  remove <project>                  Delete a project (confirm; -y skips) (alias: rm)
  remove-group <name>               Delete a group (confirm; -y skips)
  config [path|edit]                Print resolved config / its path / open in $EDITOR

TARGET
  A group name OR a single project name (bare project = group of one).
  Resolved group-first, then project.

TASKS
  A task resolves per project: tasks[<task>] -> runner with {task} -> skip.
  Long-running tasks (config.longRunning, default: start/dev/watch) stream and
  are torn down together on Ctrl-C. Others run to completion and report pass/fail.
  Placeholders {name} are filled by args: bare positional or key=value (strict).

FLAGS
  --dry-run            Show what would run without executing
  --fileless           workspace: open windows instead of a workspace file
  --config <path>      Use a specific config file
  -y, --yes            Skip confirmation prompts
  -h, --help           This help
  -v, --version        Print version

EXAMPLES
  crew init
  crew group full api web
  crew run install full
  crew run build api
  crew start checkout env=qa
  crew workspace full
  crew claude full`);
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
    case 'init':
      await cmdInit(flags, rest[0]);
      return;
    case 'group':
      cmdGroup(flags, rest[0], rest.slice(1));
      return;
    case 'remove':
    case 'rm':
      await cmdRemove(flags, rest[0]);
      return;
    case 'remove-group':
      await cmdRemoveGroup(flags, rest[0]);
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
