#!/usr/bin/env node
// Minimal ANSI -> character-grid renderer for the TUI golden suite. Interprets the escape subset
// crew's raw-mode views emit (absolute addressing, per-row/screen erase, SGR, alt screen, scroll
// region, save/restore cursor) and prints the final rendered grid as plain text — so a golden is a
// SCREEN, not a byte stream, and any implementation (this JS one, a future port) that paints the
// same screen passes, whatever exact escapes it used. Colors are stripped: mono goldens, like
// tests/snapshots. Usage: node render.mjs [WxH] < raw-bytes  (default 100x30)
const [W, H] = (process.argv[2] || '100x30').split('x').map(Number);

let grid, cx, cy, top, bot, saved;
const blank = () => Array.from({ length: H }, () => Array(W).fill(' '));
const reset = () => { grid = blank(); cx = 0; cy = 0; top = 0; bot = H - 1; saved = null; };
reset();

const put = (ch) => {
  if (cy < 0 || cy >= H) return;
  if (cx >= W) return;                 // autowrap is disabled in crew's views (\x1b[?7l) — clip
  grid[cy][cx++] = ch;
};

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  const s = Buffer.concat(chunks).toString('utf8');
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\x1b') {
      const rest = s.slice(i);
      let m;
      if ((m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(rest))) {
        const [, p, c] = m;
        const n = p.split(';').map((x) => parseInt(x, 10));
        if (c === 'H' || c === 'f') { cy = (n[0] || 1) - 1; cx = (n[1] || 1) - 1; }
        else if (c === 'K') { const mode = n[0] || 0; if (cy >= 0 && cy < H) { if (mode === 0) for (let x = cx; x < W; x++) grid[cy][x] = ' '; else if (mode === 2) grid[cy].fill(' '); else for (let x = 0; x <= cx && x < W; x++) grid[cy][x] = ' '; } }
        else if (c === 'J') { const mode = n[0] || 0; if (mode === 2 || mode === 3) { grid = blank(); } else if (mode === 0) { for (let x = cx; x < W; x++) if (cy >= 0 && cy < H) grid[cy][x] = ' '; for (let y = cy + 1; y < H; y++) grid[y].fill(' '); } }
        else if (c === 'A') cy = Math.max(0, cy - (n[0] || 1));
        else if (c === 'B') cy = Math.min(H - 1, cy + (n[0] || 1));
        else if (c === 'C') cx = Math.min(W - 1, cx + (n[0] || 1));
        else if (c === 'D') cx = Math.max(0, cx - (n[0] || 1));
        else if (c === 'G') cx = Math.max(0, (n[0] || 1) - 1);
        else if (c === 'r') { top = (n[0] || 1) - 1; bot = (n[1] || H) - 1; }
        else if (c === 'h' || c === 'l') { if (p === '?1049') { reset(); } /* other modes (cursor, mouse, wrap): no grid effect */ }
        /* m (SGR): stripped — mono goldens */
        i += m[0].length;
        continue;
      }
      if (rest.startsWith('\x1b7')) { saved = [cx, cy]; i += 2; continue; }
      if (rest.startsWith('\x1b8')) { if (saved) [cx, cy] = saved; i += 2; continue; }
      i += 1; // lone ESC or unknown intro: skip
      continue;
    }
    if (ch === '\r') { cx = 0; i++; continue; }
    if (ch === '\n') { const atBot = cy === bot; if (atBot) { grid.splice(top, 1); grid.splice(bot, 0, Array(W).fill(' ')); } else cy = Math.min(H - 1, cy + 1); i++; continue; }
    if (ch === '\b') { cx = Math.max(0, cx - 1); i++; continue; }
    if (ch === '\x07' || ch === '\x00') { i++; continue; }
    put(ch);
    i++;
  }
  const out = grid.map((row) => row.join('').replace(/\s+$/, ''));
  while (out.length && out[out.length - 1] === '') out.pop();
  process.stdout.write(out.join('\n') + '\n');
});
