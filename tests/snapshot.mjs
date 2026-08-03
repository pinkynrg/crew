#!/usr/bin/env node
// Snapshot tests for the ASCII graph renderer. Each tests/graphs/<name>.mmd is rendered in
// MONO (no color) and compared to tests/snapshots/<name>.txt.
//
//   node tests/snapshot.mjs              verify all — exit 1 on any diff / missing snapshot
//   node tests/snapshot.mjs diamond fan  verify only names containing these substrings
//   node tests/snapshot.mjs -u           accept: (re)write snapshots from current output
//   node tests/snapshot.mjs -u diamond   accept only the matching ones
//
// Workflow: change the renderer -> `node tests/snapshot.mjs` shows a side-by-side diff of every
// graph whose drawing moved. Eyeball them; the ones you like -> `-u` to bless as the new golden.
import { renderAsciiGraph, parseMermaid } from '../bin/graph.js';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gdir = join(root, 'tests', 'graphs');
const sdir = join(root, 'tests', 'snapshots');
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
const render = (src, name) => { const { nodes, edges } = parseMermaid(src); return renderAsciiGraph(nodes, edges, optsFor(name)); };

const files = readdirSync(gdir).filter((f) => f.endsWith('.mmd'))
  .filter((f) => !filters.length || filters.some((x) => f.includes(x))).sort();
if (!files.length) { console.error('no matching .mmd in tests/graphs'); process.exit(2); }

let pass = 0; const fails = [];
for (const f of files) {
  const name = f.replace(/\.mmd$/, '');
  const out = render(readFileSync(join(gdir, f), 'utf8'), name);
  const snap = join(sdir, name + '.txt');
  if (update) { writeFileSync(snap, out + '\n'); continue; }
  const exp = existsSync(snap) ? readFileSync(snap, 'utf8').replace(/\n$/, '') : null;
  if (exp === out) pass++;
  else fails.push({ name, out, exp });
}

if (update) { console.log(`wrote ${files.length} snapshot(s) to tests/snapshots/`); process.exit(0); }

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
console.log(`\n${pass}/${files.length} passed` + (fails.length ? `, \x1b[31m${fails.length} failed\x1b[0m — review, then \`node tests/snapshot.mjs -u\` to accept` : ' \x1b[32m✓\x1b[0m'));
process.exit(fails.length ? 1 : 0);
