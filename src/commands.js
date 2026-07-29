import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PKG } from './pkg.js';
import { c, faint, projectColors } from './colors.js';
import {
  fail,
  warn,
  tildify,
  sanitize,
  shellQuote,
  resolvePath,
  pathExists,
  exitCodeFromEvents,
  fetchUrl,
  launch,
} from './util.js';
import {
  loadMerged,
  loadUserConfig,
  writeUserConfig,
  userConfigPath,
  crewHomeFor,
  machineConfigPath,
  loadMachine,
  writeMachine,
  defaultConfig,
  membersFor,
  loadLastSelection,
  resolveProjectPath,
  PROJECT_TYPES,
  TOP_KEYS,
  PROJECT_KEYS,
  GUARD_KEYS,
  isObj,
  isStrArr,
} from './config.js';
import {
  resolveRun,
  dependencyEdges,
  connectivityStatus,
  dirList,
  validateMemberPaths,
  projectDir,
  projectIdentity,
  originOf,
  envFilesFor,
  urlHostPath,
  tokenMatchLen,
  URL_RE,
  OVERRIDE_WHEN_LOCAL,
} from './wiring.js';
import { runFanout, runGuards, wireRun } from './runner.js';
import { canInteractive, menu, makePrompter, confirm } from './prompt.js';
import { selectMembers } from './selection.js';

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
  const mode = isLong ? 'long-running' : 'run-to-completion';
  // For a co-running local set the picker shows a live wiring-connectivity footer.
  const members = await selectMembers(flags, cfg, { connectivity: isLong });
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

  // Materialize wired env files (fills {envfile}); fresh per run, cleaned up after.
  // Env overrides come from local.json (machine-local, untracked) so secrets never hit the config.
  const overrides = loadMachine(flags).overrides || {};
  const { cleanup } = wireRun(userPath, runnable, members, { dry: flags.dryRun, overrides });

  const label = members.map((m) => m.name).join(', ');
  const cmds = runnable.map((r) => `cd ${shellQuote(projectDir(r.project))} && ${r.resolved}`);

  if (flags.dryRun) {
    console.log(`# task '${task}' on: ${label} — mode: ${mode}`);
    const guardNames = [...new Set(runnable.flatMap((r) => r.project.guards || []))];
    if (guardNames.length) console.log(`# guards: ${guardNames.join(', ')}`);
    for (const r of runnable) {
      if (r._wired && r._wired.length)
        console.log(`  ${c.dim('# ' + r.name + ' wired to localhost: ' + r._wired.join(', '))}`);
      if (r._overrides && r._overrides.length)
        console.log(`  ${c.dim('# ' + r.name + ' env overrides: ' + r._overrides.join(', '))}`);
      console.log(`  ${r.name}: cd ${shellQuote(projectDir(r.project))} && ${r.resolved}`);
    }
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
    // On a TTY, enable the interactive filter/stop key layer (no-op when piped/CI).
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    const results = await runFanout(commands, { killOthers: true, announceExits: true, interactive });
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
  // Workspace-level VSCode settings from config (e.g. quiet the Jest extension's per-folder
  // auto-run: { "jest.enable": false } or { "jest.runMode": "on-demand" }). crew injects
  // nothing by default — fully agnostic.
  const settings = cfg.workspaceSettings && typeof cfg.workspaceSettings === 'object' ? cfg.workspaceSettings : {};
  const wsJson = { folders: dirs.map((p) => ({ path: p })), settings };

  if (flags.dryRun) {
    console.log(`# workspace file: ${wsFile}`);
    console.log(JSON.stringify(wsJson, null, 2));
    return;
  }

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

  if (flags.dryRun) {
    console.log(`# cwd (stable, crew-managed): ${cwd}`);
    console.log(`claude ${cliArgs.map(shellQuote).join(' ')}`);
    return;
  }
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
export function cmdGraph(flags, names) {
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

  if (!(await confirm(flags, `Delete project '${name}'?`))) return;
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
    ['help', '', 'Show this help (no args / -h / --help)'],
    ['list', '', 'List projects (alias: ls)'],
    ['install', '', 'Pick projects, run their install task'],
    ['start', '[args]', 'Pick projects, run their start task (local wiring)'],
    ['workspace', '', 'Pick projects, open as one VSCode window (alias: code)'],
    ['claude', '[session]', 'Pick projects, launch Claude Code (names the chat history, else auto)'],
    ['graph', '[project...]', 'Show the dependency graph derived from .envs'],
  ];
  const CONFIG = [
    ['add', '', 'Wizard: create a new project'],
    ['edit', '[name]', 'Wizard: modify an existing project'],
    ['remove', '<name>', 'Delete a project (-y, alias rm)'],
    ['guards', '[project]', 'List/manage guards (add/remove/link/unlink)'],
    ['overrides', '[set|remove]', 'List/set/remove per-project env overrides (local.json)'],
    ['dir', '[path]', 'Show/set the projects directory'],
    ['config', '[path|edit]', 'Print config / its path / open in $EDITOR'],
    ['check', '', 'Validate the config; report errors + warnings (alias: validate)'],
    ['pull', '<url>', 'Load config.json from a URL (backs up current)'],
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
  L.push(c.bold('SELECTION'));
  L.push('  start/install/workspace/claude always open an interactive multiselect');
  L.push('  (preselected with your last pick). The chosen set is remembered globally and');
  L.push('  reused across them. For a co-running set, start warns live if the selection');
  L.push('  isn\'t connected in the dependency graph.');
  L.push('');
  L.push(c.bold('TASKS'));
  L.push('  Per project: tasks[<task>] -> runner with {task}. start/dev/watch stream and');
  L.push('  tear down together on Ctrl-C; others run to completion, then report pass/fail.');
  L.push('  Pass placeholder values ({name}) as key=value args, e.g. crew start env=qa.');
  L.push('');
  L.push(c.bold('FLAGS'));
  for (const [f, d] of FLAGS) L.push(`  ${c.cyan(f)}${' '.repeat(Math.max(2, 18 - f.length))}${d}`);
  console.log(L.join('\n'));
}
