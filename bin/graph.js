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
  const sublabel = opts.sublabel || (() => '');   // optional short suffix on the name line (e.g. resolved env) — no extra box height
  const cursor = opts.cursor;                      // optional cursor node (interactive selector)
  const sel = cursor != null;                      // selector mode: reserve a ▸ marker gutter so moving the cursor never reflows widths
  const subW = opts.sublabelWidth || 0;            // pad the [env] field to this INNER width, spaces OUTSIDE the tight brackets (centered), so a box keeps its width when its sublabel changes (local<->qa in the selector). 0 = no padding.
  const subField = (c) => { const s = sublabel(c); if (!s) return ''; const tok = '[' + s + ']', t = Math.max(0, (subW + 2) - tok.length), l = t >> 1; return ' ' + ' '.repeat(l) + tok + ' '.repeat(t - l); };
  const boxLabel = (c) => (sel ? (c === cursor ? '▸ ' : '  ') : '') + c + subField(c); // env is any string the caller gives; the [brackets] are ours
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
  for (let ci = 0; ci < chains.length; ci++) { const ch = chains[ci]; for (let i = 0; i < ch.pts.length - 1; i++) {
    const p = ch.pts[i], r = ch.pts[i + 1], gap = Math.min(cellL.get(p), cellL.get(r));
    const upper = cellL.get(p) < cellL.get(r) ? p : r, lower = upper === p ? r : p;
    segs.push({ id: sid++, cid: ci, upper, lower, gap, lane: 0, ref: ch.ref, from: ch.from, final: i === ch.pts.length - 2, to: ch.pts[ch.pts.length - 1] });
  } }

  // 6. port counts -> box widths ------------------------------------------
  const botSeg = new Map(), topSeg = new Map();
  for (const s of segs) { if (!isDummy(s.upper)) (botSeg.get(s.upper) || botSeg.set(s.upper, []).get(s.upper)).push(s); if (!isDummy(s.lower)) (topSeg.get(s.lower) || topSeg.set(s.lower, []).get(s.lower)).push(s); }
  const CW = (c) => isDummy(c) ? 1 : Math.max(boxLabel(c).length + 4, Math.max((botSeg.get(c) || []).length, (topSeg.get(c) || []).length) + 2);

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
  // §7 as a callable — the order-search below re-runs it after reordering a layer so coords co-adapt to
  // the new within-layer order. Mutates the shared cxm/cellX/canvasW in place (keeps every closure valid).
  const cxm = new Map(), cellX = new Map();
  let canvasW = 1;
  const computeCoords = () => {
    const cxD = runPass(true), cxU = runPass(false);
    cxm.clear(); for (const c of cellL.keys()) cxm.set(c, (cxD.get(c) + cxU.get(c)) / 2);
    let minx = Infinity; for (const c of cxm.keys()) minx = Math.min(minx, cxm.get(c) - CW(c) / 2);
    for (const c of cxm.keys()) cxm.set(c, Math.round(cxm.get(c) - minx));
    for (const r of rows) for (let i = 1; i < r.length; i++) { const need = cxm.get(r[i - 1]) + ((CW(r[i - 1]) + CW(r[i]) + 1) >> 1) + GAP; if (cxm.get(r[i]) < need) cxm.set(r[i], need); }
    // straighten dummy chains: snap all of one edge's dummies to a shared column so the chain is a clean
    // vertical and the horizontal offset lands in ONE end-segment (an L) instead of a diagonal staircase.
    for (const ch of chains) { const ds = ch.pts.filter(isDummy); if (ds.length < 2) continue; const cs = ds.map((d) => cxm.get(d)).sort((p, q) => p - q); const T = cs[cs.length >> 1]; for (const d of ds) cxm.set(d, T); }
    for (const r of rows) for (let i = 1; i < r.length; i++) { const need = cxm.get(r[i - 1]) + ((CW(r[i - 1]) + CW(r[i]) + 1) >> 1) + GAP; if (cxm.get(r[i]) < need) cxm.set(r[i], need); } // re-enforce order/min-gap after the snap
    cellX.clear(); for (const c of cxm.keys()) cellX.set(c, cxm.get(c) - (CW(c) >> 1));
    canvasW = Math.max(1, ...[...cxm.keys()].map((c) => cellX.get(c) + CW(c)));
  };
  computeCoords();
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
  const xU = (s) => isDummy(s.upper) ? cxc(s.upper) : portX.get(s).u;
  const xL = (s) => isDummy(s.lower) ? cxc(s.lower) : portX.get(s).l;
  // §8 port assignment as a callable — the local-search below re-runs it after every box nudge so
  // placement and routing finally co-adapt. Deterministic: same box columns in -> same ports out.
  let frozen = false; // once true, keep the current port ORDER (the port-swap search permutes it) instead of re-sorting by far-end
  const assignPorts = () => {
    portX.clear();
    if (!frozen) { // seed/refresh port order by far-end (crossing-minimal) — during the box-move phase only
      for (const [, list] of botSeg) list.sort((a, b) => cxc(a.lower) - cxc(b.lower));
      for (const [, list] of topSeg) list.sort((a, b) => cxc(a.upper) - cxc(b.upper));
    }
    for (const [node, list] of botSeg) list.forEach((s) => setPort(s, 'u', cellX.get(node) + (CW(node) >> 1))); // seed at box center
    for (const [node, list] of topSeg) list.forEach((s) => setPort(s, 'l', cellX.get(node) + (CW(node) >> 1)));
    for (let it = 0; it < 4; it++) { // relax both ends toward each other until ports line up
      for (const [node, list] of botSeg) isoPlace(node, list, 'u', (s) => xL(s));
      for (const [node, list] of topSeg) isoPlace(node, list, 'l', (s) => xU(s));
    }
    // 8b. deconflict: a lower-port column must never equal ANOTHER edge's upper-port column, else the two
    // verticals stack collinear and one paints over the other. Nudge the real lower port to a free column.
    for (let g = 0; g <= maxL; g++) {
      const gs = segs.filter((s) => s.gap === g);
      const upCount = new Map();
      for (const s of gs) upCount.set(xU(s), (upCount.get(xU(s)) || 0) + 1);
      const usedLo = new Set();
      for (const s of gs) {
        if (isDummy(s.lower)) { usedLo.add(xL(s)); continue; }
        const b = xL(s), own = xU(s), x0 = cellX.get(s.lower), w = CW(s.lower);
        const otherUpAt = (c) => (upCount.get(c) || 0) - (c === own ? 1 : 0) > 0;
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
  };
  // 8a. LOCAL-SEARCH refinement. §7 places boxes and §8 routes ports independently, so a box can sit a
  // column off and force an avoidable crossing (the ma_back_edges B<->C case). Hill-climb: nudge a real
  // box ±1 col (keeping its layer's order + min-gap), re-run assignPorts(), keep the nudge iff it lowers
  // cost = 100*crossings ONLY. Chasing fewer bends OR shorter edges lopsided otherwise-symmetric layouts
  // (diamond/ampersand/fan splay EVENLY only if we leave §7's symmetric coords alone) — not worth a few
  // saved turns/cells, so BOTH dropped. The search moves a box only to cut a crossing. No RNG -> deterministic.
  // buildLayout: lane-pack + y-layout. Moved above the search so metric() can measure REAL crossings.
  const buildLayout = () => {
    const laneN = new Array(maxL + 1).fill(0);
    for (let g = 0; g <= maxL; g++) {
      const es = segs.filter((s) => s.gap === g && xU(s) !== xL(s)).map((s) => ({ s, lo: Math.min(xU(s), xL(s)), hi: Math.max(xU(s), xL(s)) }));
      for (const s of segs) if (s.gap === g && xU(s) === xL(s)) s.lane = 0;
      es.sort((p, q) => (q.hi - q.lo) - (p.hi - p.lo) || p.lo - q.lo); // widest span first -> outer edges nest on top lanes
      const lanes = [];
      for (const e of es) { let ln = lanes.findIndex((iv) => iv.every((x) => e.hi < x.lo || e.lo > x.hi)); if (ln < 0) { ln = lanes.length; lanes.push([]); } lanes[ln].push(e); e.s.lane = ln; }
      laneN[g] = lanes.length;
    }
    const upArrow = new Array(maxL + 1).fill(false);
    for (const s of segs) if (s.final && s.to === s.upper) upArrow[s.gap] = true;
    const gapH = laneN.map((c, g) => Math.max(1, c) + 1 + (upArrow[g] ? 1 : 0));
    const yTop = []; let y = 0;
    for (let l = 0; l <= maxL; l++) { yTop[l] = y; y += 3 + gapH[l]; }
    return {
      yTop, height: yTop[maxL] + 3,
      gapY: (g) => yTop[g] + 3 + (upArrow[g] ? 1 : 0),
      topY: (c) => isDummy(c) ? yTop[cellL.get(c)] + 1 : yTop[cellL.get(c)],
      botY: (c) => isDummy(c) ? yTop[cellL.get(c)] + 1 : yTop[cellL.get(c)] + 2,
    };
  };
  // REAL geometric crossings: a vertical run of edge X and a horizontal run of edge Y (X != Y) sharing a
  // cell. Replaces the old adjacent-layer port-inversion PROXY, which was blind to back-edge crossings
  // (ma_back_edges reported 0 while truly 2). Needs the y-layout, hence buildLayout above.
  const realCrossings = () => {
    const lay = buildLayout();
    const vr = [], hr = [];
    for (const s of segs) {
      const laneRow = lay.gapY(s.gap) + s.lane, up = lay.botY(s.upper), dn = isDummy(s.lower) ? lay.topY(s.lower) : lay.topY(s.lower) - 1;
      const a = xU(s), b = xL(s);
      vr.push({ col: a, y0: Math.min(up, laneRow), y1: Math.max(up, laneRow), cid: s.cid });
      vr.push({ col: b, y0: Math.min(laneRow, dn), y1: Math.max(laneRow, dn), cid: s.cid });
      if (a !== b) hr.push({ row: laneRow, x0: Math.min(a, b), x1: Math.max(a, b), cid: s.cid });
    }
    const cells = new Set(); // dedupe by crossing CELL — a segment's two vertical runs meet at the lane row, so a horizontal there would otherwise be counted twice
    for (const v of vr) for (const h of hr) if (v.cid !== h.cid && h.x0 <= v.col && v.col <= h.x1 && v.y0 <= h.row && h.row <= v.y1) cells.add(v.col + ',' + h.row);
    return cells.size;
  };
  const metric = () => { const cr = realCrossings(); return { cr, cost: 100 * cr }; };
  const moveBox = (c, nx) => { cxm.set(c, nx); cellX.set(c, nx - (CW(c) >> 1)); };
  const gapOK = (c, nx) => {
    const r = rows[cellL.get(c)], i = r.indexOf(c), Ln = r[i - 1], Rn = r[i + 1];
    if (nx - (CW(c) >> 1) < 0) return false;
    if (Ln != null && nx - cxm.get(Ln) < sepC(Ln, c)) return false;
    if (Rn != null && cxm.get(Rn) - nx < sepC(c, Rn)) return false;
    return true;
  };
  assignPorts();
  if (!opts.noRefine) {
    // order-search: permute WITHIN-layer node order — the coarsest crossing lever. §4's median is a
    // heuristic seeded by INPUT order (so the same edges in a different declaration order draw differently
    // and can carry avoidable crossings). Adjacent-swap hill-climb: swap two neighbours in a layer, re-run
    // §7 coords + ports, keep iff realCrossings drops. Strictly-better only -> monotonic, deterministic.
    let obest = metric().cost;
    for (let pass = 0; pass < 12; pass++) {
      let improved = false;
      for (let l = 0; l <= maxL; l++) for (let i = 0; i < rows[l].length - 1; i++) {
        const sw = () => { const t = rows[l][i]; rows[l][i] = rows[l][i + 1]; rows[l][i + 1] = t; };
        sw(); computeCoords(); assignPorts();
        if (metric().cost < obest) { obest = metric().cost; improved = true; } else { sw(); computeCoords(); assignPorts(); }
      }
      if (!improved) break;
    }
    let best = metric().cost;
    for (let pass = 0; pass < 24; pass++) {
      let improved = false;
      for (const c of NODES) for (const delta of [-1, 1, -2, 2, -3, 3]) {
        const cur = cxm.get(c), nx = cur + delta;
        if (!gapOK(c, nx)) continue;
        moveBox(c, nx); assignPorts();
        const cc = metric().cost;
        if (cc < best) { best = cc; improved = true; } else { moveBox(c, cur); assignPorts(); }
      }
      // dummy-CHANNEL move: shift a long edge's whole straightened channel sideways (e.g. route B->D
      // left of C instead of right) — lets the search reroute a through-edge, not just move boxes.
      for (const ch of chains) {
        const ds = ch.pts.filter(isDummy); if (!ds.length) continue;
        for (const delta of [-1, 1, -2, 2, -3, 3]) {
          if (!ds.every((d) => gapOK(d, cxm.get(d) + delta))) continue;
          const cur = ds.map((d) => cxm.get(d));
          ds.forEach((d) => moveBox(d, cxm.get(d) + delta)); assignPorts();
          if (metric().cost < best) { best = metric().cost; improved = true; } else { ds.forEach((d, i) => moveBox(d, cur[i])); assignPorts(); }
        }
      }
      if (!improved) break;
    }
    // port-swap phase: freeze the far-end order, then swap adjacent ports on a border whenever it cuts a
    // real crossing (e.g. admin->api / billing->api into a shared target). isoPlace keeps ports in list
    // order, so a swap = a column swap; only strictly-better swaps kept -> monotonic, can't add crossings.
    frozen = true; assignPorts(); best = metric().cost;
    for (let pass = 0; pass < 12; pass++) {
      let improved = false;
      for (const map of [botSeg, topSeg]) for (const [, list] of map) for (let i = 0; i < list.length - 1; i++) {
        const sw = () => { const t = list[i]; list[i] = list[i + 1]; list[i + 1] = t; };
        sw(); assignPorts();
        if (metric().cost < best) { best = metric().cost; improved = true; } else { sw(); assignPorts(); }
      }
      if (!improved) break;
    }
    let mn = Infinity; for (const c of cxm.keys()) mn = Math.min(mn, cellX.get(c)); // shift right only if a nudge pushed a box off the left edge (keeps the baseline left margin -> no cosmetic churn)
    if (mn < 0) { for (const c of cxm.keys()) { cxm.set(c, cxm.get(c) - mn); cellX.set(c, cellX.get(c) - mn); } assignPorts(); }
    canvasW = Math.max(1, ...[...cxm.keys()].map((c) => cellX.get(c) + CW(c)));
  }
  if (opts.metric) return metric();

  // 5b. lane packing + vertical layout: buildLayout() is defined above §8a (so the search can measure
  // real crossings); §8c below reuses it to re-derive rows after nudging a column.

  // 8c. NO-OVERLAP deconflict. Two DIFFERENT edges must never draw a collinear vertical over shared cells
  // (one paints over the other — an "overlap"; a crossing is fine). §8b only handles port==port; this also
  // catches a long-edge DUMMY channel colliding with another vertical. Fix = jog one run onto the nearest
  // free column via a corner (its own colour). Iterates + rebuilds rows; deterministic (fixed order, no RNG).
  const deconflict = () => {
    for (let iter = 0; iter < 80; iter++) {
      const lay = buildLayout();
      const runs = [];
      for (const s of segs) {
        const laneRow = lay.gapY(s.gap) + s.lane, up = lay.botY(s.upper), dn = isDummy(s.lower) ? lay.topY(s.lower) : lay.topY(s.lower) - 1;
        runs.push({ col: xU(s), y0: Math.min(up, laneRow), y1: Math.max(up, laneRow), cid: s.cid, seg: s, side: 'u', node: s.upper });
        runs.push({ col: xL(s), y0: Math.min(laneRow, dn), y1: Math.max(laneRow, dn), cid: s.cid, seg: s, side: 'l', node: s.lower });
      }
      const rangesHit = (y0, y1, by0, by1) => Math.max(y0, by0) <= Math.min(y1, by1);
      const boxAt = (col, y0, y1) => NODES.some((c) => { const x0 = cellX.get(c); return col >= x0 && col <= x0 + CW(c) - 1 && rangesHit(y0, y1, lay.yTop[cellL.get(c)], lay.yTop[cellL.get(c)] + 2); });
      const runAt = (col, y0, y1, cid) => runs.some((r) => r.col === col && r.cid !== cid && rangesHit(y0, y1, r.y0, r.y1));
      let ov = null;
      for (let i = 0; i < runs.length && !ov; i++) for (let j = i + 1; j < runs.length; j++) { const r = runs[i], w = runs[j]; if (r.cid !== w.cid && r.col === w.col && rangesHit(r.y0, r.y1, w.y0, w.y1)) { ov = [r, w]; break; } }
      if (!ov) return true;
      let moved = false;
      for (const r of ov) { // try to shift this run to the nearest free column
        for (const d of [1, -1, 2, -2, 3, -3]) {
          const nc = r.col + d; if (nc < 0) continue;
          if (isDummy(r.node)) {
            if (boxAt(nc, r.y0, r.y1) || runAt(nc, r.y0, r.y1, r.cid)) continue;
            for (const dpt of chains[r.cid].pts) if (isDummy(dpt) && cxm.get(dpt) === r.col) cxm.set(dpt, nc); // move the whole straightened channel
          } else { // a real port: stay inside the box border, land on a free column
            const x0 = cellX.get(r.node); if (nc <= x0 || nc >= x0 + CW(r.node) - 1) continue;
            if (runAt(nc, r.y0, r.y1, r.cid)) continue;
            portX.get(r.seg)[r.side] = nc;
          }
          moved = true; break;
        }
        if (moved) break;
      }
      if (!moved) return false; // no free column — leave it (shouldn't happen at crew scale)
    }
    return false;
  };
  deconflict();
  canvasW = Math.max(canvasW, ...segs.flatMap((s) => [xU(s) + 1, xL(s) + 1]));
  const { yTop, height, gapY, topY, botY } = buildLayout();

  // 9. render --------------------------------------------------------------
  const mask = Array.from({ length: height }, () => new Int8Array(canvasW));
  const chr = Array.from({ length: height }, () => new Array(canvasW).fill(null));
  const cCol = Array.from({ length: height }, () => new Array(canvasW).fill(null)); // box/arrow color
  const vCol = Array.from({ length: height }, () => new Array(canvasW).fill(null)); // color of N/S owner
  const hCol = Array.from({ length: height }, () => new Array(canvasW).fill(null)); // color of E/W owner
  const owner = Array.from({ length: height }, () => new Array(canvasW).fill(-1));
  const multi = Array.from({ length: height }, () => new Uint8Array(canvasW));
  const vEdge = Array.from({ length: height }, () => new Int16Array(canvasW).fill(-1)); // EDGE (chain) that painted this cell's vertical — for overlap detection
  const hEdge = Array.from({ length: height }, () => new Int16Array(canvasW).fill(-1)); // ... horizontal
  const ovlp = new Set();
  const dashV = new Set(), dashH = new Set(); // cells where a REF edge's vertical / horizontal runs (ref = thin single line)
  const inb = (x, yy) => yy >= 0 && yy < height && x >= 0 && x < canvasW;
  const bit = (x, yy, b, id, c, cid) => {
    if (!inb(x, yy)) return;
    mask[yy][x] |= b;
    if (b & (N_ | S_)) { if (vEdge[yy][x] >= 0 && vEdge[yy][x] !== cid) ovlp.add('V ' + x + ',' + yy); vEdge[yy][x] = cid; vCol[yy][x] = c; }
    if (b & (E_ | W_)) { if (hEdge[yy][x] >= 0 && hEdge[yy][x] !== cid) ovlp.add('H ' + x + ',' + yy); hEdge[yy][x] = cid; hCol[yy][x] = c; }
    if (owner[yy][x] === -1) owner[yy][x] = id; else if (owner[yy][x] !== id) multi[yy][x] = 1;
  };
  const put = (x, yy, ch2, c) => { if (inb(x, yy)) { chr[yy][x] = ch2; cCol[yy][x] = c; } };
  const vsg = (y1, y2, x, ref, id, c, cid) => { const [a, b] = y1 <= y2 ? [y1, y2] : [y2, y1]; for (let yy = a; yy <= b; yy++) { if (yy > a) bit(x, yy, N_, id, c, cid); if (yy < b) bit(x, yy, S_, id, c, cid); if (ref) dashV.add(x + ',' + yy); } };
  const hsg = (x1, x2, yy, ref, id, c, cid) => { const [a, b] = x1 <= x2 ? [x1, x2] : [x2, x1]; for (let x = a; x <= b; x++) { if (x > a) bit(x, yy, W_, id, c, cid); if (x < b) bit(x, yy, E_, id, c, cid); if (ref) dashH.add(x + ',' + yy); } };

  for (const c of NODES) { // boxes (own color)
    const x0 = cellX.get(c), w = CW(c), t = yTop[cellL.get(c)], cc = colorOf(c), lbl = ` ${boxLabel(c)} `, pad = w - 2 - lbl.length, lp = Math.max(0, pad >> 1);
    put(x0, t, '╔', cc); put(x0 + w - 1, t, '╗', cc); put(x0, t + 2, '╚', cc); put(x0 + w - 1, t + 2, '╝', cc);
    for (let x = x0 + 1; x < x0 + w - 1; x++) { put(x, t, '═', cc); put(x, t + 2, '═', cc); }
    put(x0, t + 1, '║', cc); put(x0 + w - 1, t + 1, '║', cc);
    const text = ' '.repeat(lp) + lbl + ' '.repeat(Math.max(0, pad - lp));
    for (let i = 0; i < text.length && x0 + 1 + i < x0 + w - 1; i++) put(x0 + 1 + i, t + 1, text[i], cc);
  }
  for (const c of NODES) { // T-junctions where a line LEAVES a box (source side only — a target side already
    const t = yTop[cellL.get(c)], cc = colorOf(c);                                // has an arrowhead, so no tick there). DEP=double (╦/╩), REF=single-into-double (╤/╧).
    for (const s of botSeg.get(c) || []) if (s.to !== c) put(xU(s), t + 2, s.ref ? '╤' : '╦', cc); // leaves the bottom, going down
    for (const s of topSeg.get(c) || []) if (s.to !== c) put(xL(s), t, s.ref ? '╧' : '╩', cc);     // leaves the top, going up
  }

  for (const s of segs) { // route each segment in its source's color
    const cc = colorOf(s.from), laneRow = gapY(s.gap) + s.lane, a = xU(s), b = xL(s);
    const upStart = isDummy(s.upper) ? botY(s.upper) : botY(s.upper);          // exit bottom border
    const downEnd = isDummy(s.lower) ? topY(s.lower) : topY(s.lower) - 1;       // STOP above target border
    vsg(upStart, laneRow, a, s.ref, s.id, cc, s.cid);
    hsg(a, b, laneRow, s.ref, s.id, cc, s.cid);
    vsg(laneRow, downEnd, b, s.ref, s.id, cc, s.cid);
    if (s.final) { // arrowhead on the incoming column (solid = dep, hollow = ref)
      const toIsLower = s.to === s.lower;
      put(toIsLower ? b : a, toIsLower ? topY(s.lower) - 1 : botY(s.upper) + 1, s.ref ? (toIsLower ? '▽' : '△') : (toIsLower ? '▼' : '▲'), cc);
    }
  }

  if (process.env.OVLP) { // cell-precise, edge-keyed overlap: a cell where two DIFFERENT edges paint the same orientation
    for (const o of [...ovlp].sort()) console.error('OVERLAP', o);
    console.error('TOTAL overlap cells:', ovlp.size);
    let xing = 0; for (let y = 0; y < height; y++) for (let x = 0; x < canvasW; x++) if (vEdge[y][x] >= 0 && hEdge[y][x] >= 0 && vEdge[y][x] !== hEdge[y][x]) xing++;
    console.error('REAL crossing cells:', xing);
  }
  if (opts.overlaps) return [...ovlp]; // invariant check: the snapshot suite asserts this is empty for every fixture
  if (process.env.DUMPCOL != null) {
    const cx = +process.env.DUMPCOL, bn = (m) => ((m & N_) ? 'N' : '') + ((m & S_) ? 'S' : '') + ((m & E_) ? 'E' : '') + ((m & W_) ? 'W' : '');
    for (let y = 0; y < height; y++) console.error('row', y, 'mask', bn(mask[y][cx]) || '-', 'vEdge', vEdge[y][cx], 'hEdge', hEdge[y][cx], 'chr', chr[y][cx] || '.');
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
  const text = out.join('\n');
  if (!opts.withLayout) return text;
  // Layout for an interactive caller (the graph selector): real nodes per layer left-to-right, and each
  // node's centre-x + top row, so it can move a cursor (←→ within a layer, ↑↓ to the nearest node in the
  // next) and scroll the box into view.
  const layers = rows.map((r) => r.filter((c) => !isDummy(c)).sort((a, b) => cxc(a) - cxc(b)));
  const place = new Map(NODES.map((c) => [c, { layer: cellL.get(c), cx: cxc(c), x0: Math.round(cellX.get(c)), w: CW(c), y0: yTop[cellL.get(c)], h: 3 }]));
  return { text, layers, place, height };
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
