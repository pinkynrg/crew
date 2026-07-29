import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectPath } from './config.js';
import { pathExists, fail, warn, placeholdersIn, substitute, PLACEHOLDER_RE } from './util.js';
import { c, projectColors } from './colors.js';

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
