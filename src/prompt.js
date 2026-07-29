import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { c } from './colors.js';

export function canInteractive() {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

// Arrow-key menu (needs an interactive TTY). Single-select returns the chosen item;
// multi-select returns the checked items in toggle order. Esc/q/Ctrl-C -> null.
// Up/Down (or k/j) move; Space toggles (multi); Enter confirms.
// `footer(selection)` (optional) returns a live status block redrawn on every keypress —
// `selection` is the checked items (multi) or the highlighted item. May be multi-line.
export function menu({ title, items, label, multi = false, start = 0, preselected = [], footer = null }) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const out = process.stdout;
    let idx = Math.max(0, Math.min(start, items.length - 1));
    const checked = new Set(preselected.filter((v) => items.includes(v)));
    const order = [...checked];
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const hint = multi
      ? '  (↑/↓ move, Space toggle, Enter confirm, Esc cancel)'
      : '  (↑/↓ move, Enter select, Esc cancel)';
    out.write(`${title}${c.dim(hint)}\n`);
    out.write('\x1b[?25l'); // hide cursor

    let prevLines = 0; // lines drawn last render (items + footer), for cursor rewind
    const render = (first) => {
      if (!first) {
        out.write(`\x1b[${prevLines}A`); // back to the top of the block
        out.write('\x1b[0J'); // erase it (items + any stale footer)
      }
      let lines = 0;
      items.forEach((it, i) => {
        const cursor = i === idx;
        const ptr = cursor ? c.cyan('❯ ') : '  ';
        const box = multi ? (checked.has(it) ? c.green('◉ ') : '◯ ') : '';
        out.write(`${ptr}${box}${label(it, cursor)}\n`);
        lines++;
      });
      if (footer) {
        const f = footer(multi ? order : items[idx]);
        if (f) for (const fl of f.split('\n')) (out.write(fl + '\n'), lines++);
      }
      prevLines = lines;
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
      } else if (multi && key.name === 'space') {
        const it = items[idx];
        if (checked.has(it)) {
          checked.delete(it);
          order.splice(order.indexOf(it), 1);
        } else {
          checked.add(it);
          order.push(it);
        }
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(multi ? order : items[idx]);
      } else if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup();
        resolve(null);
      }
    };
    stdin.on('keypress', onKey);
  });
}

// Unified prompter. On a TTY: text fields are inline-EDITABLE (the current value is
// prefilled at the cursor — edit it, or clear it to unset), and enumerable choices use
// the arrow menu. Over a pipe (scripts/tests): fall back to typed lines where a blank
// keeps the prefilled default. `close()` only matters for the piped path.
export function makePrompter() {
  if (canInteractive()) {
    const ask = (labelText, prefill = '') =>
      new Promise((resolve) => {
        const rl = createInterface({ input, output });
        const p = rl.question(`${labelText}: `);
        if (prefill) rl.write(prefill);
        p.then((a) => {
          rl.close();
          resolve(a.trim());
        });
      });
    const select = async (labelText, options, current) => {
      const r = await menu({
        title: labelText,
        items: options,
        label: (o, cur) => (cur ? c.bold(o) : o),
        start: Math.max(0, options.indexOf(current)),
      });
      return r == null ? (current ?? options[0]) : r;
    };
    const multiselect = async (labelText, options, preselected = []) => {
      const r = await menu({
        title: labelText,
        items: options,
        label: (o, cur) => (cur ? c.bold(o) : o),
        multi: true,
        preselected,
      });
      return r == null ? preselected : r;
    };
    return { ask, select, multiselect, close: () => {} };
  }

  // Piped / non-interactive: one readline, line-queue (question() is unreliable here).
  const rl = createInterface({ input, output });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => (waiters.length ? waiters.shift()(line) : queue.push(line)));
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });
  const readLine = () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : closed
        ? Promise.resolve(null)
        : new Promise((res) => waiters.push(res));
  const ask = async (labelText, prefill = '') => {
    output.write(`${labelText}${prefill ? ` [${prefill}]` : ''}: `);
    const line = await readLine();
    if (line == null) return prefill;
    const a = line.trim();
    return a === '' ? prefill : a;
  };
  const select = async (labelText, options, current) => {
    output.write(`${labelText} (${options.join('/')})${current ? ` [${current}]` : ''}: `);
    const line = await readLine();
    const v = (line || '').trim();
    return v || current || options[0];
  };
  const multiselect = async (labelText, options, preselected = []) => {
    output.write(`${labelText} (space/comma separated)${preselected.length ? ` [${preselected.join(' ')}]` : ''}: `);
    const line = await readLine();
    const v = (line || '').trim();
    return v ? v.split(/[\s,]+/).filter(Boolean) : preselected;
  };
  return { ask, select, multiselect, close: () => rl.close() };
}

export async function confirm(flags, question) {
  if (flags.yes) return true;
  const { ask, close } = makePrompter();
  try {
    const a = await ask(`${question} (y/N)`, '');
    return /^y/i.test(a);
  } finally {
    close();
  }
}
