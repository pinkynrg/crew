import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { resolvePath, expandHome, pathExists, fail } from './util.js';

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

export const PROJECT_TYPES = ['frontend', 'backend', 'fullstack', 'other'];

// ---------------------------------------------------------------------------
// Config-validation key sets (used by `crew check`).
// ---------------------------------------------------------------------------
export const TOP_KEYS = new Set(['version', 'workspaceName', 'longRunning', 'workspaceSettings', 'internalDomains', 'projects', 'guards']);
export const PROJECT_KEYS = new Set(['path', 'type', 'runner', 'env', 'local', 'match', 'envMap', 'tasks', 'guards', 'defaultBranch']);
export const GUARD_KEYS = new Set(['comment', 'command', 'message']);
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
