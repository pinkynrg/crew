#!/usr/bin/env node
// Snapshot tests for the ASCII graph renderer — BLACK-BOX like tests/e2e: every case is rendered by
// the $GRAPH binary (default `node bin/graph.js`), never by importing renderer code, so a port to
// another language keeps the suite: `GRAPH="./crew-go graph-render" node tests/graph/run.mjs`.
//
// Binary contract (what a port must honor — see bin/graph.js standalone entry):
//   $GRAPH <file.mmd> [--opts <file.json>] [--color|--no-color] [--check-overlaps]
//   stdout = the render (mono when piped; --color forces the palette even piped)
//   --opts: {cursor, sublabel:{node:suffix}} — the selector rendering mode (cursor marker + [env] tags)
//   --check-overlaps: collinear edge overlaps print to stderr and exit 3 when any exist
//
// Everything about one case sits together in cases/: <name>.mmd (the graph) [+ <name>.opts.json
// render options] + <name>.snap.txt (the golden mono render, BESIDE its case).
//
//   node tests/graph/run.mjs             verify all — exit 1 on any diff / missing snapshot
//   node tests/graph/run.mjs diamond fan verify only names containing these substrings
//   node tests/graph/run.mjs -u           accept: (re)write snapshots from current output
//   node tests/graph/run.mjs -u diamond  accept only the matching ones
//
// The .txt goldens are the assertion (mono, so they stay ANSI-free and diff cleanly). But colour is
// load-bearing for a HUMAN eyeballing a graph (each edge is drawn in its SOURCE's colour) — a mono
// snapshot hides which line is which, so mistakes slip through. So on every FULL run we also (re)write
// tests/graph/gallery.html: every case rendered in colour (the binary's --color output), open it in a
// browser to check.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const gdir = join(root, 'tests', 'graph', 'cases');
const GRAPH = (process.env.GRAPH || `node ${join(root, 'bin', 'graph.js')}`).split(' ');

const argv = process.argv.slice(2);
const update = argv.includes('-u') || argv.includes('--update');
const filters = argv.filter((a) => !a.startsWith('-'));
const cpw = (s) => [...(s || '')].length;

// one spawn = one rendering; NO_COLOR strips the TTY auto-color so piped output is deterministic
const render = (args) => spawnSync(GRAPH[0], [...GRAPH.slice(1), ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
const caseArgs = (name) => {
  const opts = join(gdir, name + '.opts.json');
  return [join(gdir, name + '.mmd'), ...(existsSync(opts) ? ['--opts', opts] : [])];
};

// --- colour (gallery only) -------------------------------------------------
// the binary's --color palette (16-color SGR codes, one per node in graph order) mapped to hex for HTML.
const HEX = { 31: '#ff6b6b', 32: '#5fd38d', 33: '#e8c34a', 34: '#6aa9ff', 35: '#d68cf0', 36: '#56cbdb', 91: '#f0883e', 92: '#9ae6b4', 93: '#b794f6', 94: '#f6ad55', 95: '#7ee3d6', 96: '#ff8fab' };
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ansi2html = (s) => { // handles the binary's 16-color set + reset/default
  let out = '', open = false, last = 0, m; const re = /\x1b\[([0-9;]*)m/g;
  while ((m = re.exec(s))) {
    out += escHtml(s.slice(last, m.index)); last = re.lastIndex;
    if (open) { out += '</span>'; open = false; }
    const hex = HEX[m[1]];
    if (hex) { out += `<span style="color:${hex}">`; open = true; }
  }
  out += escHtml(s.slice(last)); if (open) out += '</span>'; return out;
};
const galleryHtml = (items) => `<!doctype html><meta charset="utf8"><title>crew graph snapshots</title>
<style>body{background:#0c0e15;color:#c7cdda;font:14px ui-monospace,"SF Mono",Menlo,monospace;margin:0;padding:24px}
h1{font-size:15px;color:#e9a94a;letter-spacing:.08em;text-transform:uppercase}
section{margin:26px 0;border:1px solid #232839;border-radius:10px;overflow:hidden}
h2{font-size:13px;margin:0;padding:8px 14px;background:#12151f;color:#838ba0;border-bottom:1px solid #232839}
pre{margin:0;padding:16px;overflow-x:auto;line-height:1.28}</style>
<h1>crew graph — colour gallery (${items.length})</h1>
${items.map((it) => `<section><h2>${escHtml(it.name)}</h2><pre>${it.html}</pre></section>`).join('\n')}
`;

const files = readdirSync(gdir).filter((f) => f.endsWith('.mmd'))
  .filter((f) => !filters.length || filters.some((x) => f.includes(x))).sort();
if (!files.length) { console.error('no matching .mmd in tests/graph/cases'); process.exit(2); }

let pass = 0; const fails = []; const gallery = []; const overlapFails = [];
for (const f of files) {
  const name = f.replace(/\.mmd$/, '');
  // INVARIANT: no two edges may draw a collinear overlap (one paints over the other). Checked in the
  // case's real render mode (its --opts) — never disabled, even under -u (exit 3 = overlaps on stderr).
  const r = render([...caseArgs(name), '--check-overlaps']);
  if (r.status !== 0 && r.status !== 3) { fails.push({ name, out: (r.stderr || 'render failed').trim(), exp: null }); continue; }
  if (r.status === 3) overlapFails.push({ name, ovl: r.stderr.trim().split('\n') });
  const out = r.stdout.replace(/\n$/, '');
  gallery.push({ name, html: ansi2html(render([...caseArgs(name), '--color']).stdout.replace(/\n$/, '')) });
  const snap = join(gdir, name + '.snap.txt');
  if (update) { writeFileSync(snap, out + '\n'); continue; }
  const exp = existsSync(snap) ? readFileSync(snap, 'utf8').replace(/\n$/, '') : null;
  if (exp === out) pass++;
  else fails.push({ name, out, exp });
}

// (re)write the colour gallery from the CURRENT render — only on a full run, so a filtered run can't
// clobber it with a partial set. It's a human-viewable aid, regenerated deterministically like the goldens.
if (!filters.length) writeFileSync(join(root, 'tests', 'graph', 'gallery.html'), galleryHtml(gallery));

if (update) { console.log(`wrote ${files.length} snapshot(s)` + (filters.length ? '' : ' + gallery.html')); process.exit(0); }

for (const { name, out, exp } of fails) {
  console.log(`\n\x1b[1;31mFAIL\x1b[0m ${name}` + (exp === null ? '  \x1b[2m(no snapshot — run -u to create)\x1b[0m' : ''));
  const a = (exp || '').split('\n'), b = out.split('\n');
  const w = Math.max(cpw('expected (snapshot)'), ...a.map(cpw));
  const pad = (s) => (s || '') + ' '.repeat(Math.max(0, w - cpw(s)));
  console.log('  ' + pad('expected (snapshot)') + ' │ actual (now)');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const same = (a[i] || '') === (b[i] || '');
    console.log((same ? '  ' : '\x1b[33m▶\x1b[0m ') + pad(a[i]) + ' │ ' + (same ? '' : '\x1b[33m') + (b[i] || '') + '\x1b[0m');
  }
}
for (const { name, ovl } of overlapFails) console.log(`\x1b[1;31mOVERLAP\x1b[0m ${name}: ${ovl.length} cell(s) — ${ovl.join(', ')}  \x1b[2m(two edges drawing a collinear line over the same cells)\x1b[0m`);
console.log(`\n${pass}/${files.length} passed` + (fails.length ? `, \x1b[31m${fails.length} failed\x1b[0m — review, then \`node tests/graph/run.mjs -u\` to accept` : ' \x1b[32m✓\x1b[0m')
  + (overlapFails.length ? `, \x1b[31m${overlapFails.length} with overlaps\x1b[0m` : '')
  + (filters.length ? '' : `  \x1b[2m· colours: open tests/graph/gallery.html\x1b[0m`));
process.exit(fails.length || overlapFails.length ? 1 : 0);
