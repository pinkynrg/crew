#!/usr/bin/env node
// bin/graph.js — zero-dep layered-DAG ASCII renderer for `crew graph` (top-down).
// Also runnable standalone: `node bin/graph.js file.mmd` (or pipe mermaid on stdin).
//
// renderAsciiGraph(nodes, edges, opts) -> string
//   nodes: string[]                       all node ids (isolated ones included)
//   edges: {from,to,ref?}[]               ref = link-back (dashed line, hollow head)
//   opts:  { colorOf?: (name)=>ansiPrefix }   colors a box + its OUTGOING edges by source
//
// Sugiyama-lite, improved over mermaid-ascii (naive parent+1 + greedy routing):
//   1. back-edge detection (DFS)              -> ranking stays a DAG
//   2. longest-path layering                  -> rows, top -> bottom
//   3. dummy nodes split long edges           -> every segment crosses ONE gap
//   4. median ordering                        -> fewer crossings
//   5. PORTS: each in/out edge gets its own column on the box border  -> all N shown
//   6. one horizontal lane per edge per gap   -> + ports => no two lines ever collinear
//   7. per-edge COLOR by source; box in its own color; an incoming edge stops ABOVE the
//      target border (port stays the box's color) and its arrowhead sits on that column
//   8. CROSSINGS (two different edges meeting) render as a vertical-over hop `│` in the
//      vertical edge's color — NOT a merged single-color `┼`
// Deterministic (stable input order, no RNG).

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const GLYPH = [' ', '║', '═', '╚', '║', '║', '╔', '╠', '═', '╝', '═', '╩', '╗', '╣', '╦', '╬']; // double-line set: dependency edges (bolder than heavy — max contrast vs the thin ref line)
const LIGHT = [' ', '│', '─', '└', '│', '│', '┌', '├', '─', '┘', '─', '┴', '┐', '┤', '┬', '┼']; // light set: reference edges. double vs light is a wide, reliably-1-cell delta (unlike the ╍/╏ double-dashes many terminal fonts mis-space)
const N_ = 1, E_ = 2, S_ = 4, W_ = 8, RESET = '\x1b[0m', GAP = 1;

export function renderAsciiGraph(nodes, edges, opts = {}) {
  const colorOf = opts.colorOf || (() => '');
  const NODES = [...new Set(nodes)];
  if (!NODES.length) return '';
  const has = new Set(NODES);
  edges = (edges || []).filter((e) => has.has(e.from) && has.has(e.to) && e.from !== e.to);

  // 1. back-edges ----------------------------------------------------------
  const adj = new Map(NODES.map((n) => [n, []]));
  for (const e of edges) adj.get(e.from).push(e.to);
  const st = new Map();
  const back = new Set();
  const dfs = (u) => { st.set(u, 1); for (const v of adj.get(u)) { if (st.get(v) === 1) back.add(u + ' ' + v); else if (!st.get(v)) dfs(v); } st.set(u, 2); };
  for (const n of NODES) if (!st.get(n)) dfs(n);
  const lay = edges.filter((e) => !back.has(e.from + ' ' + e.to));

  // 2. longest-path layering ----------------------------------------------
  const nxt = new Map(NODES.map((n) => [n, []]));
  const indeg = new Map(NODES.map((n) => [n, 0]));
  for (const e of lay) { nxt.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1); }
  const L = new Map(NODES.map((n) => [n, 0]));
  const d = new Map(indeg), q0 = NODES.filter((n) => !indeg.get(n));
  while (q0.length) { const u = q0.shift(); for (const v of nxt.get(u)) { if (L.get(u) + 1 > L.get(v)) L.set(v, L.get(u) + 1); if (!d.set(v, d.get(v) - 1).get(v)) q0.push(v); } }
  const maxL = Math.max(0, ...NODES.map((n) => L.get(n)));

  // 3. dummies -> chains ---------------------------------------------------
  const cellL = new Map(NODES.map((n) => [n, L.get(n)]));
  const isDummy = (c) => c[0] === '\0';
  const chains = [];
  let dn = 0;
  for (const e of edges) {
    const a = L.get(e.from), b = L.get(e.to), lo = Math.min(a, b), hi = Math.max(a, b), mids = [];
    for (let l = lo + 1; l < hi; l++) { const id = '\0' + dn++; cellL.set(id, l); mids.push(id); }
    chains.push({ ref: !!e.ref, from: e.from, pts: a <= b ? [e.from, ...mids, e.to] : [e.from, ...mids.reverse(), e.to] });
  }

  // 4. ordering (median) ---------------------------------------------------
  const rows = Array.from({ length: maxL + 1 }, () => []);
  for (const n of NODES) rows[cellL.get(n)].push(n);
  for (const ch of chains) for (const p of ch.pts) if (isDummy(p)) rows[cellL.get(p)].push(p);
  const pos = new Map();
  rows.forEach((r) => r.forEach((c, i) => pos.set(c, i)));
  const nb = new Map();
  const link = (a, b) => { (nb.get(a) || nb.set(a, []).get(a)).push(b); };
  for (const ch of chains) for (let i = 0; i < ch.pts.length - 1; i++) { link(ch.pts[i], ch.pts[i + 1]); link(ch.pts[i + 1], ch.pts[i]); }
  const med = (a) => { if (!a.length) return -1; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2; };
  for (let it = 0; it < 8; it++) {
    for (const l of it & 1 ? [...rows.keys()].reverse() : [...rows.keys()]) {
      rows[l] = rows[l].map((c) => [c, med((nb.get(c) || []).map((x) => pos.get(x)).filter((v) => v >= 0)), pos.get(c)])
        .sort((x, y) => (x[1] < 0 ? x[2] : x[1]) - (y[1] < 0 ? y[2] : y[1])).map((x) => x[0]);
      rows[l].forEach((c, i) => pos.set(c, i));
    }
  }

  // 5. segments (lanes assigned later in §5b, once port x-spans are known) --
  let sid = 0;
  const segs = [];
  for (const ch of chains) for (let i = 0; i < ch.pts.length - 1; i++) {
    const p = ch.pts[i], r = ch.pts[i + 1], gap = Math.min(cellL.get(p), cellL.get(r));
    const upper = cellL.get(p) < cellL.get(r) ? p : r, lower = upper === p ? r : p;
    segs.push({ id: sid++, upper, lower, gap, lane: 0, ref: ch.ref, from: ch.from, final: i === ch.pts.length - 2, to: ch.pts[ch.pts.length - 1] });
  }

  // 6. port counts -> box widths ------------------------------------------
  const botSeg = new Map(), topSeg = new Map();
  for (const s of segs) { if (!isDummy(s.upper)) (botSeg.get(s.upper) || botSeg.set(s.upper, []).get(s.upper)).push(s); if (!isDummy(s.lower)) (topSeg.get(s.lower) || topSeg.set(s.lower, []).get(s.lower)).push(s); }
  const CW = (c) => isDummy(c) ? 1 : Math.max(c.length + 4, Math.max((botSeg.get(c) || []).length, (topSeg.get(c) || []).length) + 2);

  // 7. coordinates — averaged-median L1 coordinate assignment ----------------------
  // Two anchored single passes (align down to parents' median, align up to children's median), each
  // packed with exact min-displacement (isotonic/PAVA-L1) respecting order + min-gap, then AVERAGED.
  // Anchoring each pass at one end avoids the rightward drift a repeated median walk has. (Tried full
  // Brandes-Köpf here: it came out wider and didn't help the trapped-dummy jogs — those are an ORDERING
  // artefact BK respects — so reverted.) Dummy chains are snapped straight below.
  const sepC = (a, b) => (CW(a) + CW(b)) / 2 + GAP;
  const lmed = (a) => { const s = [...a].sort((p, q) => p - q); return s[(s.length - 1) >> 1]; };
  const upNb = new Map(), downNb = new Map();
  for (const c of cellL.keys()) { upNb.set(c, []); downNb.set(c, []); }
  for (const c of cellL.keys()) for (const z of nb.get(c) || []) (cellL.get(z) < cellL.get(c) ? upNb : downNb).get(c).push(z);
  const pava = (r, cx) => { // place ordered cells at their desired x with min-gap, min total move
    const des = r.map((c) => { const ns = (cx.__ref === 'up' ? upNb : downNb).get(c).map((z) => cx.get(z)); return ns.length ? lmed(ns) : cx.get(c); });
    const pre = [0]; for (let i = 1; i < r.length; i++) pre.push(pre[i - 1] + sepC(r[i - 1], r[i]));
    const dp = des.map((v, i) => v - pre[i]); const blk = [];
    for (const v of dp) { const b = { vals: [v], med: v }; while (blk.length && blk[blk.length - 1].med > b.med) { const p = blk.pop(); b.vals = p.vals.concat(b.vals); b.med = lmed(b.vals); } blk.push(b); }
    const qv = []; for (const b of blk) for (let k = 0; k < b.vals.length; k++) qv.push(b.med);
    r.forEach((c, i) => cx.set(c, qv[i] + pre[i]));
  };
  const runPass = (down) => {
    const cx = new Map(); cx.__ref = down ? 'up' : 'down'; // align to the already-fixed side
    for (const r of rows) { let x = 0; r.forEach((c, i) => { x = i ? x + sepC(r[i - 1], c) : CW(c) / 2; cx.set(c, x); }); }
    const order = down ? [...rows.keys()].slice(1) : [...rows.keys()].slice(0, -1).reverse();
    for (const l of order) pava(rows[l], cx);
    return cx;
  };
  const cxD = runPass(true), cxU = runPass(false);
  const cxm = new Map(); for (const c of cellL.keys()) cxm.set(c, (cxD.get(c) + cxU.get(c)) / 2);
  let minx = Infinity; for (const c of cxm.keys()) minx = Math.min(minx, cxm.get(c) - CW(c) / 2);
  for (const c of cxm.keys()) cxm.set(c, Math.round(cxm.get(c) - minx));
  for (const r of rows) for (let i = 1; i < r.length; i++) { const need = cxm.get(r[i - 1]) + ((CW(r[i - 1]) + CW(r[i]) + 1) >> 1) + GAP; if (cxm.get(r[i]) < need) cxm.set(r[i], need); }
  // straighten dummy chains: snap all of one edge's dummies to a shared column so the chain is a clean
  // vertical and the horizontal offset lands in ONE end-segment (an L) instead of a diagonal staircase.
  for (const ch of chains) { const ds = ch.pts.filter(isDummy); if (ds.length < 2) continue; const cs = ds.map((d) => cxm.get(d)).sort((p, q) => p - q); const T = cs[cs.length >> 1]; for (const d of ds) cxm.set(d, T); }
  for (const r of rows) for (let i = 1; i < r.length; i++) { const need = cxm.get(r[i - 1]) + ((CW(r[i - 1]) + CW(r[i]) + 1) >> 1) + GAP; if (cxm.get(r[i]) < need) cxm.set(r[i], need); } // re-enforce order/min-gap after the snap
  const cellX = new Map(); for (const c of cxm.keys()) cellX.set(c, cxm.get(c) - (CW(c) >> 1));
  const canvasW = Math.max(1, ...[...cxm.keys()].map((c) => cellX.get(c) + CW(c)));
  const cxc = (c) => cxm.get(c);

  // 8. ports — place each on its box border AS NEAR its far end's column as possible, keeping order
  // (by far-end x, so sibling edges don't cross) and a 1-col min-gap. Iterating both ends pulls an
  // edge's two ports toward the SAME column -> zero-length horizontal -> a straight, turn-free drop
  // wherever the boxes overlap in x. (Even spacing — the old way — forced a jog on nearly every edge.)
  const portX = new Map();
  const pmed = (a) => { const s = [...a].sort((p, q) => p - q); return s[(s.length - 1) >> 1]; };
  const setPort = (s, key, v) => { (portX.get(s) || portX.set(s, {}).get(s))[key] = v; };
  const isoPlace = (node, list, key, farX) => { // isotonic L1: near farX(s), strictly increasing, min-gap 1, inside box
    const lo = cellX.get(node) + 1, hi = cellX.get(node) + CW(node) - 2, k = list.length; if (!k) return;
    // Bounded isotonic-L1: substitute p[i]=z[i]+i (so min-gap-1 becomes z non-decreasing), run PAVA on
    // (farX - i) UNBOUNDED, then clamp the RESULT z into [lo, hi-(k-1)] element-wise (clamp preserves
    // monotonicity). Clamping the OUTPUT (not the input) keeps every port in-box without a rigid row
    // shift — so a cramped left cluster can't drag right-hand ports off their column — yet doesn't
    // over-constrain a narrow box the way an input-band clamp would.
    const d = list.map((s, i) => farX(s) - i);
    const blk = [];
    for (const v of d) { const b = { vals: [v], med: v }; while (blk.length && blk[blk.length - 1].med > b.med) { const p = blk.pop(); b.vals = p.vals.concat(b.vals); b.med = pmed(b.vals); } blk.push(b); }
    const q = []; for (const b of blk) for (let j = 0; j < b.vals.length; j++) q.push(b.med);
    const cap = hi - (k - 1);
    list.forEach((s, i) => setPort(s, key, Math.round(Math.min(cap, Math.max(lo, q[i])) + i)));
  };
  for (const [, list] of botSeg) list.sort((a, b) => cxc(a.lower) - cxc(b.lower));   // fixed order = far-end x (crossing-minimal)
  for (const [, list] of topSeg) list.sort((a, b) => cxc(a.upper) - cxc(b.upper));
  for (const [node, list] of botSeg) list.forEach((s) => setPort(s, 'u', cellX.get(node) + (CW(node) >> 1))); // seed at box center
  for (const [node, list] of topSeg) list.forEach((s) => setPort(s, 'l', cellX.get(node) + (CW(node) >> 1)));
  const xU = (s) => isDummy(s.upper) ? cxc(s.upper) : portX.get(s).u;
  const xL = (s) => isDummy(s.lower) ? cxc(s.lower) : portX.get(s).l;
  for (let it = 0; it < 4; it++) { // relax both ends toward each other until ports line up
    for (const [node, list] of botSeg) isoPlace(node, list, 'u', (s) => xL(s));
    for (const [node, list] of topSeg) isoPlace(node, list, 'l', (s) => xU(s));
  }
  // 8b. deconflict vertical columns per gap: a lower-port column must never equal ANOTHER edge's
  // upper-port (or dummy) column — else the two verticals stack into one collinear line and one
  // paints over the other (e.g. a ref edge's arrowhead welding onto a down-edge). Ports are already
  // distinct within a box; this only fixes upper-of-one == lower-of-another across boxes. Nudge the
  // real lower port to the nearest free interior column of its own box.
  for (let g = 0; g <= maxL; g++) {
    const gs = segs.filter((s) => s.gap === g);
    const upCount = new Map();                                // how many edges' upper verticals sit in each column
    for (const s of gs) upCount.set(xU(s), (upCount.get(xU(s)) || 0) + 1);
    const usedLo = new Set();
    for (const s of gs) {
      if (isDummy(s.lower)) { usedLo.add(xL(s)); continue; }
      const b = xL(s), own = xU(s), x0 = cellX.get(s.lower), w = CW(s.lower);
      const otherUpAt = (c) => (upCount.get(c) || 0) - (c === own ? 1 : 0) > 0; // a DIFFERENT edge's upper is at c (own upper is fine -> straight edge)
      if (otherUpAt(b) || usedLo.has(b)) {
        const cand = [];
        for (let c = x0 + 1; c <= x0 + w - 2; c++) if (c !== b) cand.push(c);
        cand.sort((p, q) => Math.abs(p - b) - Math.abs(q - b));
        const pick = cand.find((c) => !otherUpAt(c) && !usedLo.has(c));
        if (pick != null) portX.get(s).l = pick;
      }
      usedLo.add(xL(s));
    }
  }

  // 5b. lane packing + vertical layout (needs the final port x-spans from §8) -----
  // Pack each gap's horizontals into as few lane rows as possible (edges whose [lo,hi] x-spans don't
  // overlap SHARE a row), but process WIDEST span first so outer edges land on the TOP lanes and inner
  // ones nest below. That nesting is what keeps a fan-out clean: an inner edge never has to drop its
  // vertical THROUGH an outer edge's horizontal (which is the crossing greedy-by-left produces).
  const laneN = new Array(maxL + 1).fill(0);
  for (let g = 0; g <= maxL; g++) {
    const es = segs.filter((s) => s.gap === g && xU(s) !== xL(s)).map((s) => ({ s, lo: Math.min(xU(s), xL(s)), hi: Math.max(xU(s), xL(s)) })); // straight segs (no horizontal) need no lane
    es.sort((p, q) => (q.hi - q.lo) - (p.hi - p.lo) || p.lo - q.lo); // widest span first -> outer edges get lower (top) lane indices
    const lanes = [];                                        // each lane = the intervals placed in it
    for (const e of es) { let ln = lanes.findIndex((iv) => iv.every((x) => e.hi < x.lo || e.lo > x.hi)); if (ln < 0) { ln = lanes.length; lanes.push([]); } lanes[ln].push(e); e.s.lane = ln; }
    laneN[g] = lanes.length;
  }
  const upArrow = new Array(maxL + 1).fill(false);           // reserve a top margin row where a ref/back edge points UP into its box
  for (const s of segs) if (s.final && s.to === s.upper) upArrow[s.gap] = true;
  const gapH = laneN.map((c, g) => Math.max(1, c) + 1 + (upArrow[g] ? 1 : 0));
  const yTop = []; let y = 0;
  for (let l = 0; l <= maxL; l++) { yTop[l] = y; y += 3 + gapH[l]; }
  const height = yTop[maxL] + 3;
  const gapY = (g) => yTop[g] + 3 + (upArrow[g] ? 1 : 0);
  const topY = (c) => isDummy(c) ? yTop[cellL.get(c)] + 1 : yTop[cellL.get(c)];
  const botY = (c) => isDummy(c) ? yTop[cellL.get(c)] + 1 : yTop[cellL.get(c)] + 2;

  // 9. render --------------------------------------------------------------
  const mask = Array.from({ length: height }, () => new Int8Array(canvasW));
  const chr = Array.from({ length: height }, () => new Array(canvasW).fill(null));
  const cCol = Array.from({ length: height }, () => new Array(canvasW).fill(null)); // box/arrow color
  const vCol = Array.from({ length: height }, () => new Array(canvasW).fill(null)); // color of N/S owner
  const hCol = Array.from({ length: height }, () => new Array(canvasW).fill(null)); // color of E/W owner
  const owner = Array.from({ length: height }, () => new Array(canvasW).fill(-1));
  const multi = Array.from({ length: height }, () => new Uint8Array(canvasW));
  const dashV = new Set(), dashH = new Set(); // cells where a REF edge's vertical / horizontal runs (ref = thin single line)
  const inb = (x, yy) => yy >= 0 && yy < height && x >= 0 && x < canvasW;
  const bit = (x, yy, b, id, c) => {
    if (!inb(x, yy)) return;
    mask[yy][x] |= b;
    if (b & (N_ | S_)) vCol[yy][x] = c;
    if (b & (E_ | W_)) hCol[yy][x] = c;
    if (owner[yy][x] === -1) owner[yy][x] = id; else if (owner[yy][x] !== id) multi[yy][x] = 1;
  };
  const put = (x, yy, ch2, c) => { if (inb(x, yy)) { chr[yy][x] = ch2; cCol[yy][x] = c; } };
  const vsg = (y1, y2, x, ref, id, c) => { const [a, b] = y1 <= y2 ? [y1, y2] : [y2, y1]; for (let yy = a; yy <= b; yy++) { if (yy > a) bit(x, yy, N_, id, c); if (yy < b) bit(x, yy, S_, id, c); if (ref) dashV.add(x + ',' + yy); } };
  const hsg = (x1, x2, yy, ref, id, c) => { const [a, b] = x1 <= x2 ? [x1, x2] : [x2, x1]; for (let x = a; x <= b; x++) { if (x > a) bit(x, yy, W_, id, c); if (x < b) bit(x, yy, E_, id, c); if (ref) dashH.add(x + ',' + yy); } };

  for (const c of NODES) { // boxes (own color)
    const x0 = cellX.get(c), w = CW(c), t = yTop[cellL.get(c)], cc = colorOf(c), lbl = ` ${c} `, pad = w - 2 - lbl.length, lp = Math.max(0, pad >> 1);
    put(x0, t, '╔', cc); put(x0 + w - 1, t, '╗', cc); put(x0, t + 2, '╚', cc); put(x0 + w - 1, t + 2, '╝', cc);
    for (let x = x0 + 1; x < x0 + w - 1; x++) { put(x, t, '═', cc); put(x, t + 2, '═', cc); }
    put(x0, t + 1, '║', cc); put(x0 + w - 1, t + 1, '║', cc);
    const text = ' '.repeat(lp) + lbl + ' '.repeat(Math.max(0, pad - lp));
    for (let i = 0; i < text.length && x0 + 1 + i < x0 + w - 1; i++) put(x0 + 1 + i, t + 1, text[i], cc);
  }

  for (const s of segs) { // route each segment in its source's color
    const cc = colorOf(s.from), laneRow = gapY(s.gap) + s.lane, a = xU(s), b = xL(s);
    const upStart = isDummy(s.upper) ? botY(s.upper) : botY(s.upper);          // exit bottom border
    const downEnd = isDummy(s.lower) ? topY(s.lower) : topY(s.lower) - 1;       // STOP above target border
    vsg(upStart, laneRow, a, s.ref, s.id, cc);
    hsg(a, b, laneRow, s.ref, s.id, cc);
    vsg(laneRow, downEnd, b, s.ref, s.id, cc);
    if (s.final) { // arrowhead on the incoming column (solid = dep, hollow = ref)
      const toIsLower = s.to === s.lower;
      put(toIsLower ? b : a, toIsLower ? topY(s.lower) - 1 : botY(s.upper) + 1, s.ref ? (toIsLower ? '▽' : '△') : (toIsLower ? '▼' : '▲'), cc);
    }
  }

  // 10. compose (crossings hop; color runs) --------------------------------
  const out = [];
  for (let yy = 0; yy < height; yy++) {
    let line = '', cur = null;
    for (let x = 0; x < canvasW; x++) {
      let g, c;
      if (chr[yy][x] != null) { g = chr[yy][x]; c = cCol[yy][x]; }
      else if (mask[yy][x]) {
        const m = mask[yy][x];
        const k = x + ',' + yy;
        if (multi[yy][x] && m & (N_ | S_) && m & (E_ | W_)) { g = dashV.has(k) ? '│' : '║'; c = vCol[yy][x]; } // crossing hop: the VERTICAL passes over, drawn at ITS OWN weight (║ dep stays double, │ ref stays single) — never thinned
        else { g = (dashV.has(k) || dashH.has(k) ? LIGHT : GLYPH)[m]; c = vCol[yy][x] || hCol[yy][x]; }
      } else { g = ' '; c = null; }
      const want = g === ' ' ? null : c;
      if (want !== cur) { if (cur) line += RESET; if (want) line += want; cur = want; }
      line += g;
    }
    if (cur) line += RESET;
    out.push(line.replace(/[ \t]+(\x1b\[0m)?$/, (mm, r) => r || ''));
  }
  return out.join('\n');
}

// ---- standalone CLI: parse a mermaid flowchart and render -------------------
// Supports the flowchart subset that maps to a dependency DAG: `A --> B`, chains
// `A --> B --> C`, fan `A & B --> C`, labels (`-->|x|`, `-- x -->`), node shapes
// (`A[Text]` -> id A), two-headed arrows (`<-->`, `x--x`, `o--o` -> a single A->B edge).
// Dotted edges (`-.->`, `<-.->`) or a `|ref|` label = reference edge. Ignores
// subgraph/style/class/direction lines. Not a full mermaid parser.
export function parseMermaid(text) {
  const nodes = [], seen = new Set(), edges = [];
  const cleanId = (raw) => { raw = raw.trim(); const m = raw.match(/^([A-Za-z0-9_.-]+)\s*[[({>]/); return (m ? m[1] : raw).replace(/["']/g, '').trim(); };
  const add = (raw) => { const n = cleanId(raw); if (n && !seen.has(n)) { seen.add(n); nodes.push(n); } return n; };
  for (let line of text.split('\n')) {
    line = line.replace(/%%.*$/, '').trim();
    if (!line || /^(graph|flowchart|subgraph|end|classDef|class|style|linkStyle|direction|click)\b/i.test(line)) continue;
    line = line.replace(/--\s+([^->|][^-]*?)\s+-->/g, (m, l) => `-->|${l.trim()}|`);   // `-- label -->` -> `-->|label|`
    line = line.replace(/-\.\s+([^.]*?)\s+\.->/g, (m, l) => `-.->|${l.trim()}|`);       // `-. label .->` -> `-.->|label|`
    const opRe = /\s*(<-\.->|<-->|<--|<==>|x--x|o--o|-\.->|-\.-|--x|--o|-->|---|==>|===)\s*(?:\|([^|]*)\|\s*)?/g; // two-headed forms (<-->, x--x, o--o…) first so `<` isn't left on the node id
    const parts = []; const ops = []; let last = 0, mm;
    while ((mm = opRe.exec(line))) { parts.push(line.slice(last, mm.index)); ops.push({ op: mm[1], label: mm[2] }); last = opRe.lastIndex; }
    parts.push(line.slice(last));
    if (!ops.length) { parts[0].split('&').forEach(add); continue; }                    // lone node(s)
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i].op;
      const lhs = parts[i].split('&').map(add).filter(Boolean);
      const rhs = parts[i + 1].split('&').map(add).filter(Boolean);
      const ref = op.includes('.') || /ref/i.test(ops[i].label || '');       // dotted edge (-.->, <-.->) or |ref| label
      const bidi = op[0] === '<' || op === 'x--x' || op === 'o--o';           // two-headed -> emit BOTH directions (renders as a 2-cycle)
      for (const a of lhs) for (const b of rhs) if (a && b && a !== b) { edges.push({ from: a, to: b, ref }); if (bidi) edges.push({ from: b, to: a, ref }); }
    }
  }
  return { nodes, edges };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv.find((a, i) => i >= 2 && !a.startsWith('-'));
  const src = readFileSync(file || 0, 'utf8');
  const { nodes, edges } = parseMermaid(src);
  const PAL = ['\x1b[31m', '\x1b[32m', '\x1b[33m', '\x1b[34m', '\x1b[35m', '\x1b[36m', '\x1b[91m', '\x1b[92m', '\x1b[93m', '\x1b[94m', '\x1b[95m', '\x1b[96m'];
  const color = process.stdout.isTTY && !process.env.NO_COLOR && !process.argv.includes('--no-color');
  const cmap = new Map(nodes.map((n, i) => [n, PAL[i % PAL.length]]));
  const colorOf = color ? (n) => cmap.get(n) || '' : () => '';
  process.stdout.write(renderAsciiGraph(nodes, edges, { colorOf }) + '\n');
}
