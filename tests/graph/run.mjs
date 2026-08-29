#!/usr/bin/env node
// Snapshot tests for the ASCII graph renderer. Each tests/graph/fixtures/<name>.mmd is rendered in
// MONO (no color) and compared to tests/graph/snapshots/<name>.txt.
//
//   node tests/graph/run.mjs             verify all — exit 1 on any diff / missing snapshot
//   node tests/graph/run.mjs diamond fan verify only names containing these substrings
//   node tests/graph/run.mjs -u           accept: (re)write snapshots from current output
//   node tests/graph/run.mjs -u diamond  accept only the matching ones
//
// The .txt goldens are the assertion (mono, so they stay ANSI-free and diff cleanly). But colour is
// load-bearing for a HUMAN eyeballing a graph (each edge is drawn in its SOURCE's colour) — a mono
// snapshot hides which line is which, so mistakes slip through. So on every FULL run we also (re)write
// tests/graph/snapshots/gallery.html: every fixture rendered in colour, open it in a browser to check.
import { renderAsciiGraph, parseMermaid } from '../../bin/graph.js';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const gdir = join(root, 'tests', 'graph', 'fixtures');
const sdir = join(root, 'tests', 'graph', 'snapshots');
if (!existsSync(sdir)) mkdirSync(sdir, { recursive: true });

const argv = process.argv.slice(2);
const update = argv.includes('-u') || argv.includes('--update');
const filters = argv.filter((a) => !a.startsWith('-'));
const cpw = (s) => [...(s || '')].length;
// optional per-fixture opts: a companion <name>.opts.json ({ cursor, sublabel:{node:suffix} }) exercises
// the selector rendering (inline env + cursor marker). No colorOf -> mono, so snapshots stay ANSI-free.
const optsFor = (name) => {
  const p = join(gdir, name + '.opts.json');
  if (!existsSync(p)) return {};
  const o = JSON.parse(readFileSync(p, 'utf8'));
  return { cursor: o.cursor, sublabel: o.sublabel ? (n) => o.sublabel[n] || '' : undefined };
};

// --- colour (gallery only) -------------------------------------------------
// distinct colour per node, assigned in the graph's own node order (so a graph's edges are told apart).
const PALETTE = ['#ff6b6b', '#5fd38d', '#e8c34a', '#6aa9ff', '#d68cf0', '#56cbdb', '#f0883e', '#9ae6b4', '#b794f6', '#f6ad55', '#7ee3d6', '#ff8fab'];
const colorOptsFor = (name, nodes) => {
  const cm = new Map(); nodes.forEach((n, i) => cm.set(n, PALETTE[i % PALETTE.length]));
  const ansi = (n) => { const h = cm.get(n) || '#c7cdda'; return `\x1b[38;2;${parseInt(h.slice(1, 3), 16)};${parseInt(h.slice(3, 5), 16)};${parseInt(h.slice(5, 7), 16)}m`; };
  return { ...optsFor(name), colorOf: ansi };
};
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ansi2html = (s) => { // handles the renderer's truecolor set (38;2;r;g;b) + reset (0)
  let out = '', open = false, last = 0, m; const re = /\x1b\[([0-9;]*)m/g;
  while ((m = re.exec(s))) {
    out += escHtml(s.slice(last, m.index)); last = re.lastIndex;
    if (open) { out += '</span>'; open = false; }
    const rgb = m[1].match(/38;2;(\d+);(\d+);(\d+)/);
    if (rgb) { out += `<span style="color:rgb(${rgb[1]},${rgb[2]},${rgb[3]})">`; open = true; }
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
if (!files.length) { console.error('no matching .mmd in tests/graph/fixtures'); process.exit(2); }

let pass = 0; const fails = []; const gallery = []; const overlapFails = [];
for (const f of files) {
  const name = f.replace(/\.mmd$/, '');
  const src = readFileSync(join(gdir, f), 'utf8');
  const { nodes, edges } = parseMermaid(src);
  const out = renderAsciiGraph(nodes, edges, optsFor(name));
  // INVARIANT: no two edges may draw a collinear overlap (one paints over the other). Checked in the
  // fixture's real render mode (its optsFor opts) — never disabled, even under -u.
  const ovl = renderAsciiGraph(nodes, edges, { ...optsFor(name), overlaps: true });
  if (ovl.length) overlapFails.push({ name, ovl });
  gallery.push({ name, html: ansi2html(renderAsciiGraph(nodes, edges, colorOptsFor(name, nodes))) });
  const snap = join(sdir, name + '.txt');
  if (update) { writeFileSync(snap, out + '\n'); continue; }
  const exp = existsSync(snap) ? readFileSync(snap, 'utf8').replace(/\n$/, '') : null;
  if (exp === out) pass++;
  else fails.push({ name, out, exp });
}

// (re)write the colour gallery from the CURRENT render — only on a full run, so a filtered run can't
// clobber it with a partial set. It's a human-viewable aid, regenerated deterministically like the goldens.
if (!filters.length) writeFileSync(join(sdir, 'gallery.html'), galleryHtml(gallery));

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
  + (filters.length ? '' : `  \x1b[2m· colours: open tests/graph/snapshots/gallery.html\x1b[0m`));
process.exit(fails.length || overlapFails.length ? 1 : 0);
