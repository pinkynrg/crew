import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { COLOR, c, faint } from './colors.js';
import { fail, sanitize, shellQuote, pathExists } from './util.js';
import { crewHomeFor } from './config.js';
import {
  projectDir,
  projectIdentity,
  originOf,
  overrideVarsFor,
  applyEnvOverrides,
  wireText,
  URL_RE,
  urlHostPath,
  tokenMatchLen,
} from './wiring.js';
import { menu } from './prompt.js';

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

export function runFanout(commands, { killOthers, announceExits, interactive = false }) {
  return new Promise((resolve) => {
    const results = [];
    const live = new Set();
    const spawned = [];
    const timers = [];
    let aborting = false;
    let firstSigintAt = 0;

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

    // Interactive log viewer (streamed mode on a TTY): an alternate-screen view showing only the
    // selected projects' recent lines. `f` opens the picker to choose them (hide all -> blank
    // screen); Ctrl-C/q stop. Raw mode swallows SIGINT, so keys route through requestStop().
    // A footer is pinned to the bottom row via a DECSTBM scroll region so live logs scroll above
    // it. No-op when piped/CI (viewer stays null, output streams with prefixes).
    if (interactive && live.size) {
      const stdin = process.stdin;
      emitKeypressEvents(stdin);
      const wasRaw = stdin.isRaw;
      if (stdin.setRawMode) stdin.setRawMode(true);
      stdin.resume();
      const names = commands.map((cmd) => cmd.name);
      const history = []; // { proc, text } complete lines (capped)
      const pending = new Map(); // proc -> partial line not yet terminated
      const shown = new Set(names); // projects currently visible
      let active = true; // false while the picker owns the screen

      const rows = () => process.stdout.rows || 24;
      const footerText = () => c.dim(`crew: [f] filter logs   [Ctrl-C] stop   (${shown.size}/${names.length} shown)`);
      const drawFooter = () => {
        const r = rows();
        rawWrite(`\x1b7\x1b[${r};1H\x1b[2K${footerText()}\x1b8`); // save cursor, draw, restore
      };
      const repaint = () => {
        const r = rows();
        rawWrite('\x1b[r\x1b[2J\x1b[H'); // release region, clear, home
        if (r >= 3) rawWrite(`\x1b[1;${r - 1}r\x1b[H`); // body = rows 1..R-1, cursor home
        lastWrite.proc = null;
        lastWrite.char = '\n';
        const body = history.filter((h) => shown.has(h.proc._name)).slice(-(r - 1));
        for (const h of body) render(h.proc, h.text + '\n');
        drawFooter();
      };

      viewer = {
        feed(proc, text) {
          const parts = ((pending.get(proc) || '') + text).split('\n');
          pending.set(proc, parts.pop()); // trailing element is the incomplete remainder
          for (const line of parts) {
            history.push({ proc, text: line });
            if (history.length > LOG_HISTORY) history.shift();
            if (active && shown.has(proc._name)) render(proc, line + '\n'); // scrolls above footer
          }
        },
      };

      let onKey;
      const openFilter = async () => {
        if (menuOpen || !live.size) return;
        menuOpen = true;
        active = false; // capture to history only; let the picker own the screen
        stdin.removeListener('keypress', onKey);
        rawWrite('\x1b[r\x1b[2J\x1b[H'); // release region + clear for the menu
        let sel = null;
        try {
          sel = await menu({
            title: 'Show logs for (Space toggles, Enter applies; select none = blank screen)',
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
        }
        // menu() pauses stdin + may drop raw mode on close — re-assert both or keys go dead.
        if (stdin.setRawMode) stdin.setRawMode(true);
        stdin.resume();
        active = true;
        menuOpen = false;
        repaint(); // draw the filtered view (blank if nothing selected)
        if (live.size) stdin.on('keypress', onKey);
      };
      onKey = (str, key) => {
        if (menuOpen) return;
        if (key && key.ctrl && key.name === 'c') return requestStop();
        if (key && key.name === 'q') return requestStop();
        if (key && key.name === 'f') return void openFilter();
      };
      const onResize = () => {
        if (!menuOpen) repaint();
      };
      stdin.on('keypress', onKey);
      process.stdout.on('resize', onResize);
      detachKeys = () => {
        viewer = null; // stop capturing; final output (if any) streams normally
        stdin.removeListener('keypress', onKey);
        process.stdout.removeListener('resize', onResize);
        rawWrite('\x1b[r'); // reset scroll region
        rawWrite('\x1b[?1049l'); // leave the alternate screen -> restore the original
        if (stdin.setRawMode) stdin.setRawMode(wasRaw);
        stdin.pause();
      };
      rawWrite('\x1b[?1049h'); // enter the alternate screen
      repaint();
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
export async function runGuards(cfg, members) {
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

  console.log(c.dim('guards:'));
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
    const note = registry[r.n].comment ? '  ' + faint(registry[r.n].comment) : '';
    if (r.ok) {
      console.log(`  ${c.green('✓')} ${r.n}${note}`);
    } else {
      failed = true;
      console.log(`  ${c.red('✗')} ${r.n}${note}`);
      console.log(`      ${c.red(registry[r.n].message || 'guard failed')}`);
    }
  }
  if (failed) fail(`${results.filter((r) => !r.ok).length > 1 ? 'guards' : 'guard'} failed — nothing started.`);
}

// Local service wiring: for each runnable whose command uses {envfile}, load its base env
// (project.env), rewrite any URL pointing at a CO-RUNNING peer to that peer's `local`
// origin, and materialize a FRESH temp file per run (stateless — regenerated every start,
// deleted on teardown). {envfile} in the command is replaced with the temp path. Peers not
// in the running set (or without a `local`) stay remote. dry => annotate only, no writes.
export function wireRun(userPath, runnable, members, { dry, overrides = {} }) {
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
    if (dry) {
      const hit = new Set();
      baseText.replace(URL_RE, (u) => {
        const p = urlHostPath(u);
        if (!p) return u;
        let b = null;
        let bl = 0;
        for (const pe of myPeers)
          for (const t of pe.tokens) {
            const l = tokenMatchLen(p.host, p.path, t);
            if (l > bl) (bl = l), (b = pe);
          }
        if (b) hit.add(b.name);
        return u;
      });
      r._wired = [...hit];
      r._overrides = Object.keys(overrideVars);
      r.resolved = r.resolved.replace(/\{envfile\}/g, shellQuote(`<wired ${r.envFile}>`));
      continue;
    }
    mkdirSync(tmpDir, { recursive: true });
    const out = join(tmpDir, `${sanitize(r.name)}.env`);
    writeFileSync(out, applyEnvOverrides(wireText(baseText, myPeers), overrideVars).text);
    tempPaths.push(out);
    r.resolved = r.resolved.replace(/\{envfile\}/g, shellQuote(out));
  }
  return { cleanup: () => tempPaths.forEach((p) => { try { unlinkSync(p); } catch {} }) };
}
