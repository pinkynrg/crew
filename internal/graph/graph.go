// Package graph — zero-dep layered-DAG ASCII renderer, a faithful 1:1 port of bin/graph.js.
// Section numbers (§1..§10) mirror the JS source; keep them in sync when either side changes.
// The 28 goldens in tests/graph demand BYTE-EXACT output, so every heuristic detail matters:
// insertion-ordered map walks (JS Map semantics), stable sorts (JS sort is stable), and
// half-up rounding (JS Math.round = floor(x+0.5)).
package graph

import (
	"math"
	"sort"
	"strings"
)

var glyphD = []string{" ", "║", "═", "╚", "║", "║", "╔", "╠", "═", "╝", "═", "╩", "╗", "╣", "╦", "╬"} // double-line set: dependency edges
var glyphL = []string{" ", "│", "─", "└", "│", "│", "┌", "├", "─", "┘", "─", "┴", "┐", "┤", "┬", "┼"} // light set: reference edges

const (
	nBit  = 1
	eBit  = 2
	sBit  = 4
	wBit  = 8
	reset = "\x1b[0m"
	gapW  = 1
)

// jsRound = JS Math.round: half-up (floor(x+0.5)); Go's math.Round differs on negative halves.
func jsRound(x float64) int { return int(math.Floor(x + 0.5)) }

type Edge struct {
	From, To string
	Ref      bool
}

type Opts struct {
	ColorOf       func(string) string // colors a box + its OUTGOING edges by source ('' = mono)
	Sublabel      func(string) string // optional short suffix on the name line (e.g. resolved env)
	Cursor        string              // optional cursor node — tinted frame (color mode only)
	SublabelWidth int                 // pad the [env] field to this INNER width (0 = no padding)
	NoRefine      bool
}

type seg struct {
	id, cid      int
	upper, lower string
	gap, lane    int
	ref          bool
	from         string
	final        bool
	to           string
	pU, pL       int // port columns (JS portX.get(s).u / .l)
}

type chain struct {
	ref  bool
	from string
	pts  []string
}

// olist — insertion-ordered string->[]*seg map (JS Map iteration semantics).
type olist struct {
	keys []string
	m    map[string][]*seg
}

func newOlist() *olist { return &olist{m: map[string][]*seg{}} }
func (o *olist) push(k string, s *seg) {
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] = append(o.m[k], s)
}
func (o *olist) get(k string) []*seg { return o.m[k] }

func isDummy(c string) bool { return len(c) > 0 && c[0] == 0 }

// lower median of a sorted copy — JS lmed/pmed: s[(len-1)>>1]
func lmed(a []float64) float64 {
	s := append([]float64(nil), a...)
	sort.Float64s(s)
	return s[(len(s)-1)>>1]
}

// Render renders the graph; Overlaps returns the overlap-invariant violations instead.
func Render(nodes []string, edges []Edge, o Opts) string {
	t, _ := render(nodes, edges, o, false)
	return t
}
func Overlaps(nodes []string, edges []Edge, o Opts) []string {
	_, ovl := render(nodes, edges, o, true)
	return ovl
}

func render(nodes []string, edges []Edge, o Opts, wantOverlaps bool) (string, []string) {
	colorOf := o.ColorOf
	if colorOf == nil {
		colorOf = func(string) string { return "" }
	}
	sublabel := o.Sublabel
	if sublabel == nil {
		sublabel = func(string) string { return "" }
	}
	subW := o.SublabelWidth
	subField := func(c string) string {
		s := sublabel(c)
		if s == "" {
			return ""
		}
		tok := "[" + s + "]"
		t := (subW + 2) - len(tok)
		if t < 0 {
			t = 0
		}
		l := t >> 1
		return " " + strings.Repeat(" ", l) + tok + strings.Repeat(" ", t-l)
	}
	boxLabel := func(c string) string { return c + subField(c) }

	// dedupe nodes, keep order
	var NODES []string
	{
		seen := map[string]bool{}
		for _, n := range nodes {
			if !seen[n] {
				seen[n] = true
				NODES = append(NODES, n)
			}
		}
	}
	if len(NODES) == 0 {
		return "", nil
	}
	has := map[string]bool{}
	for _, n := range NODES {
		has[n] = true
	}
	var E []Edge
	for _, e := range edges {
		if has[e.From] && has[e.To] && e.From != e.To {
			E = append(E, e)
		}
	}

	// 1. back-edges ----------------------------------------------------------
	adj := map[string][]string{}
	for _, n := range NODES {
		adj[n] = nil
	}
	for _, e := range E {
		adj[e.From] = append(adj[e.From], e.To)
	}
	st := map[string]int{}
	back := map[string]bool{}
	var dfs func(u string)
	dfs = func(u string) {
		st[u] = 1
		for _, v := range adj[u] {
			if st[v] == 1 {
				back[u+" "+v] = true
			} else if st[v] == 0 {
				dfs(v)
			}
		}
		st[u] = 2
	}
	for _, n := range NODES {
		if st[n] == 0 {
			dfs(n)
		}
	}
	var lay []Edge
	for _, e := range E {
		if !back[e.From+" "+e.To] {
			lay = append(lay, e)
		}
	}

	// 2. longest-path layering ----------------------------------------------
	nxt := map[string][]string{}
	indeg := map[string]int{}
	for _, n := range NODES {
		nxt[n] = nil
		indeg[n] = 0
	}
	for _, e := range lay {
		nxt[e.From] = append(nxt[e.From], e.To)
		indeg[e.To]++
	}
	L := map[string]int{}
	d := map[string]int{}
	var q0 []string
	for _, n := range NODES {
		L[n] = 0
		d[n] = indeg[n]
		if indeg[n] == 0 {
			q0 = append(q0, n)
		}
	}
	for len(q0) > 0 {
		u := q0[0]
		q0 = q0[1:]
		for _, v := range nxt[u] {
			if L[u]+1 > L[v] {
				L[v] = L[u] + 1
			}
			d[v]--
			if d[v] == 0 {
				q0 = append(q0, v)
			}
		}
	}
	maxL := 0
	for _, n := range NODES {
		if L[n] > maxL {
			maxL = L[n]
		}
	}

	// 3. dummies -> chains ---------------------------------------------------
	cellL := map[string]int{}
	var cellKeys []string // insertion order of cellL (JS Map key order): NODES first, then dummies
	for _, n := range NODES {
		cellL[n] = L[n]
		cellKeys = append(cellKeys, n)
	}
	var chains []*chain
	dn := 0
	for _, e := range E {
		a, b := L[e.From], L[e.To]
		lo, hi := a, b
		if b < a {
			lo, hi = b, a
		}
		var mids []string
		for l := lo + 1; l < hi; l++ {
			id := string(rune(0)) + itoa(dn)
			dn++
			cellL[id] = l
			cellKeys = append(cellKeys, id)
			mids = append(mids, id)
		}
		pts := []string{e.From}
		if a <= b {
			pts = append(pts, mids...)
		} else {
			for i := len(mids) - 1; i >= 0; i-- {
				pts = append(pts, mids[i])
			}
		}
		pts = append(pts, e.To)
		chains = append(chains, &chain{ref: e.Ref, from: e.From, pts: pts})
	}

	// 4. ordering (median) ---------------------------------------------------
	rows := make([][]string, maxL+1)
	for _, n := range NODES {
		rows[cellL[n]] = append(rows[cellL[n]], n)
	}
	for _, ch := range chains {
		for _, p := range ch.pts {
			if isDummy(p) {
				rows[cellL[p]] = append(rows[cellL[p]], p)
			}
		}
	}
	pos := map[string]int{}
	for _, r := range rows {
		for i, c := range r {
			pos[c] = i
		}
	}
	nb := map[string][]string{}
	link := func(a, b string) { nb[a] = append(nb[a], b) }
	for _, ch := range chains {
		for i := 0; i < len(ch.pts)-1; i++ {
			link(ch.pts[i], ch.pts[i+1])
			link(ch.pts[i+1], ch.pts[i])
		}
	}
	med := func(a []float64) float64 {
		if len(a) == 0 {
			return -1
		}
		s := append([]float64(nil), a...)
		sort.Float64s(s)
		m := len(s) >> 1
		if len(s)&1 == 1 {
			return s[m]
		}
		return (s[m-1] + s[m]) / 2
	}
	for it := 0; it < 8; it++ {
		order := make([]int, 0, maxL+1)
		if it&1 == 1 {
			for l := maxL; l >= 0; l-- {
				order = append(order, l)
			}
		} else {
			for l := 0; l <= maxL; l++ {
				order = append(order, l)
			}
		}
		for _, l := range order {
			type ent struct {
				c    string
				m, p float64
			}
			ents := make([]ent, len(rows[l]))
			for i, c := range rows[l] {
				var vs []float64
				for _, x := range nb[c] {
					if v, ok := pos[x]; ok && v >= 0 {
						vs = append(vs, float64(v))
					}
				}
				ents[i] = ent{c, med(vs), float64(pos[c])}
			}
			sort.SliceStable(ents, func(x, y int) bool {
				kx, ky := ents[x].m, ents[y].m
				if kx < 0 {
					kx = ents[x].p
				}
				if ky < 0 {
					ky = ents[y].p
				}
				return kx < ky
			})
			for i, e := range ents {
				rows[l][i] = e.c
				pos[e.c] = i
			}
		}
	}

	// 5. segments -------------------------------------------------------------
	sid := 0
	var segs []*seg
	for ci, ch := range chains {
		for i := 0; i < len(ch.pts)-1; i++ {
			p, r := ch.pts[i], ch.pts[i+1]
			g := cellL[p]
			if cellL[r] < g {
				g = cellL[r]
			}
			upper, lower := p, r
			if cellL[r] < cellL[p] {
				upper, lower = r, p
			}
			segs = append(segs, &seg{id: sid, cid: ci, upper: upper, lower: lower, gap: g, ref: ch.ref, from: ch.from, final: i == len(ch.pts)-2, to: ch.pts[len(ch.pts)-1]})
			sid++
		}
	}

	// 6. port counts -> box widths --------------------------------------------
	botSeg, topSeg := newOlist(), newOlist()
	for _, s := range segs {
		if !isDummy(s.upper) {
			botSeg.push(s.upper, s)
		}
		if !isDummy(s.lower) {
			topSeg.push(s.lower, s)
		}
	}
	CW := func(c string) int {
		if isDummy(c) {
			return 1
		}
		w := len(boxLabel(c)) + 4
		p := len(botSeg.get(c))
		if len(topSeg.get(c)) > p {
			p = len(topSeg.get(c))
		}
		if p+2 > w {
			w = p + 2
		}
		return w
	}

	// 7. coordinates — averaged-median L1 coordinate assignment ----------------
	sepC := func(a, b string) float64 { return float64(CW(a)+CW(b))/2 + gapW }
	upNb := map[string][]string{}
	downNb := map[string][]string{}
	for _, c := range cellKeys {
		upNb[c] = nil
		downNb[c] = nil
	}
	for _, c := range cellKeys {
		for _, z := range nb[c] {
			if cellL[z] < cellL[c] {
				upNb[c] = append(upNb[c], z)
			} else {
				downNb[c] = append(downNb[c], z)
			}
		}
	}
	pavaPack := func(dp []float64) []float64 { // PAVA on dp, non-decreasing lower-median blocks
		type blk struct {
			vals []float64
			med  float64
		}
		var blks []blk
		for _, v := range dp {
			b := blk{vals: []float64{v}, med: v}
			for len(blks) > 0 && blks[len(blks)-1].med > b.med {
				p := blks[len(blks)-1]
				blks = blks[:len(blks)-1]
				b.vals = append(append([]float64(nil), p.vals...), b.vals...)
				b.med = lmed(b.vals)
			}
			blks = append(blks, b)
		}
		var q []float64
		for _, b := range blks {
			for range b.vals {
				q = append(q, b.med)
			}
		}
		return q
	}
	pava := func(r []string, cx map[string]float64, ref map[string][]string) {
		des := make([]float64, len(r))
		for i, c := range r {
			ns := ref[c]
			if len(ns) > 0 {
				vs := make([]float64, len(ns))
				for j, z := range ns {
					vs[j] = cx[z]
				}
				des[i] = lmed(vs)
			} else {
				des[i] = cx[c]
			}
		}
		pre := make([]float64, len(r))
		for i := 1; i < len(r); i++ {
			pre[i] = pre[i-1] + sepC(r[i-1], r[i])
		}
		dp := make([]float64, len(r))
		for i := range r {
			dp[i] = des[i] - pre[i]
		}
		qv := pavaPack(dp)
		for i, c := range r {
			cx[c] = qv[i] + pre[i]
		}
	}
	runPass := func(down bool) map[string]float64 {
		cx := map[string]float64{}
		ref := downNb
		if down {
			ref = upNb // align to the already-fixed side
		}
		for _, r := range rows {
			x := 0.0
			for i, c := range r {
				if i == 0 {
					x = float64(CW(c)) / 2
				} else {
					x += sepC(r[i-1], c)
				}
				cx[c] = x
			}
		}
		var order []int
		if down {
			for l := 1; l <= maxL; l++ {
				order = append(order, l)
			}
		} else {
			for l := maxL - 1; l >= 0; l-- {
				order = append(order, l)
			}
		}
		for _, l := range order {
			pava(rows[l], cx, ref)
		}
		return cx
	}
	cxm := map[string]float64{}
	cellX := map[string]float64{}
	canvasW := 1
	computeCoords := func() {
		cxD := runPass(true)
		cxU := runPass(false)
		for k := range cxm {
			delete(cxm, k)
		}
		for _, c := range cellKeys {
			cxm[c] = (cxD[c] + cxU[c]) / 2
		}
		minx := math.Inf(1)
		for _, c := range cellKeys {
			if v := cxm[c] - float64(CW(c))/2; v < minx {
				minx = v
			}
		}
		for _, c := range cellKeys {
			cxm[c] = float64(jsRound(cxm[c] - minx))
		}
		enforce := func() {
			for _, r := range rows {
				for i := 1; i < len(r); i++ {
					need := cxm[r[i-1]] + float64((CW(r[i-1])+CW(r[i])+1)>>1) + gapW
					if cxm[r[i]] < need {
						cxm[r[i]] = need
					}
				}
			}
		}
		enforce()
		// straighten dummy chains: snap all of one edge's dummies to a shared column
		for _, ch := range chains {
			var ds []string
			for _, p := range ch.pts {
				if isDummy(p) {
					ds = append(ds, p)
				}
			}
			if len(ds) < 2 {
				continue
			}
			cs := make([]float64, len(ds))
			for i, dd := range ds {
				cs[i] = cxm[dd]
			}
			sort.Float64s(cs)
			T := cs[len(cs)>>1]
			for _, dd := range ds {
				cxm[dd] = T
			}
		}
		enforce()
		for k := range cellX {
			delete(cellX, k)
		}
		for _, c := range cellKeys {
			cellX[c] = cxm[c] - float64(CW(c)>>1)
		}
		canvasW = 1
		for _, c := range cellKeys {
			if w := int(cellX[c]) + CW(c); w > canvasW {
				canvasW = w
			}
		}
	}
	computeCoords()
	cxc := func(c string) float64 { return cxm[c] }

	// 8. ports ------------------------------------------------------------------
	xU := func(s *seg) int {
		if isDummy(s.upper) {
			return int(cxc(s.upper))
		}
		return s.pU
	}
	xL := func(s *seg) int {
		if isDummy(s.lower) {
			return int(cxc(s.lower))
		}
		return s.pL
	}
	isoPlace := func(node string, list []*seg, setU bool, farX func(*seg) int) {
		lo, hi, k := int(cellX[node])+1, int(cellX[node])+CW(node)-2, len(list)
		if k == 0 {
			return
		}
		dp := make([]float64, k)
		for i, s := range list {
			dp[i] = float64(farX(s) - i)
		}
		q := pavaPack(dp)
		cap_ := float64(hi - (k - 1))
		for i, s := range list {
			v := q[i]
			if v < float64(lo) {
				v = float64(lo)
			}
			if v > cap_ {
				v = cap_
			}
			p := jsRound(v + float64(i))
			if setU {
				s.pU = p
			} else {
				s.pL = p
			}
		}
	}
	frozen := false
	assignPorts := func() {
		if !frozen { // seed/refresh port order by far-end (crossing-minimal)
			for _, k := range botSeg.keys {
				list := botSeg.m[k]
				sort.SliceStable(list, func(a, b int) bool { return cxc(list[a].lower) < cxc(list[b].lower) })
			}
			for _, k := range topSeg.keys {
				list := topSeg.m[k]
				sort.SliceStable(list, func(a, b int) bool { return cxc(list[a].upper) < cxc(list[b].upper) })
			}
		}
		for _, k := range botSeg.keys {
			for _, s := range botSeg.m[k] {
				s.pU = int(cellX[k]) + (CW(k) >> 1)
			}
		}
		for _, k := range topSeg.keys {
			for _, s := range topSeg.m[k] {
				s.pL = int(cellX[k]) + (CW(k) >> 1)
			}
		}
		for it := 0; it < 4; it++ { // relax both ends toward each other
			for _, k := range botSeg.keys {
				isoPlace(k, botSeg.m[k], true, func(s *seg) int { return xL(s) })
			}
			for _, k := range topSeg.keys {
				isoPlace(k, topSeg.m[k], false, func(s *seg) int { return xU(s) })
			}
		}
		// 8b. deconflict: a lower-port column must never equal ANOTHER edge's upper-port column
		for g := 0; g <= maxL; g++ {
			var gs []*seg
			for _, s := range segs {
				if s.gap == g {
					gs = append(gs, s)
				}
			}
			upCount := map[int]int{}
			for _, s := range gs {
				upCount[xU(s)]++
			}
			usedLo := map[int]bool{}
			for _, s := range gs {
				if isDummy(s.lower) {
					usedLo[xL(s)] = true
					continue
				}
				b, own, x0, w := xL(s), xU(s), int(cellX[s.lower]), CW(s.lower)
				otherUpAt := func(c int) bool {
					n := upCount[c]
					if c == own {
						n--
					}
					return n > 0
				}
				if otherUpAt(b) || usedLo[b] {
					var cand []int
					for c := x0 + 1; c <= x0+w-2; c++ {
						if c != b {
							cand = append(cand, c)
						}
					}
					sort.SliceStable(cand, func(p, q int) bool { return abs(cand[p]-b) < abs(cand[q]-b) })
					for _, c := range cand {
						if !otherUpAt(c) && !usedLo[c] {
							s.pL = c
							break
						}
					}
				}
				usedLo[xL(s)] = true
			}
		}
	}

	// buildLayout: lane-pack + y-layout (above the search so metric() can measure REAL crossings)
	type layout struct {
		yTop   []int
		height int
		gapY   func(int) int
		topY   func(string) int
		botY   func(string) int
	}
	buildLayout := func() layout {
		laneN := make([]int, maxL+1)
		for g := 0; g <= maxL; g++ {
			type ent struct {
				s      *seg
				lo, hi int
			}
			var es []ent
			for _, s := range segs {
				if s.gap == g {
					if xU(s) == xL(s) {
						s.lane = 0
					} else {
						lo, hi := xU(s), xL(s)
						if hi < lo {
							lo, hi = hi, lo
						}
						es = append(es, ent{s, lo, hi})
					}
				}
			}
			sort.SliceStable(es, func(p, q int) bool { // widest span first -> outer edges nest on top lanes
				wp, wq := es[p].hi-es[p].lo, es[q].hi-es[q].lo
				if wp != wq {
					return wp > wq
				}
				return es[p].lo < es[q].lo
			})
			var lanes [][]ent
			for _, e := range es {
				ln := -1
				for li, iv := range lanes {
					ok := true
					for _, x := range iv {
						if !(e.hi < x.lo || e.lo > x.hi) {
							ok = false
							break
						}
					}
					if ok {
						ln = li
						break
					}
				}
				if ln < 0 {
					ln = len(lanes)
					lanes = append(lanes, nil)
				}
				lanes[ln] = append(lanes[ln], e)
				e.s.lane = ln
			}
			laneN[g] = len(lanes)
		}
		upArrow := make([]bool, maxL+1)
		for _, s := range segs {
			if s.final && s.to == s.upper {
				upArrow[s.gap] = true
			}
		}
		gapH := make([]int, maxL+1)
		for g, c := range laneN {
			h := c
			if h < 1 {
				h = 1
			}
			h++
			if upArrow[g] {
				h++
			}
			gapH[g] = h
		}
		yTop := make([]int, maxL+1)
		y := 0
		for l := 0; l <= maxL; l++ {
			yTop[l] = y
			y += 3 + gapH[l]
		}
		return layout{
			yTop:   yTop,
			height: yTop[maxL] + 3,
			gapY: func(g int) int {
				e := 0
				if upArrow[g] {
					e = 1
				}
				return yTop[g] + 3 + e
			},
			topY: func(c string) int {
				if isDummy(c) {
					return yTop[cellL[c]] + 1
				}
				return yTop[cellL[c]]
			},
			botY: func(c string) int {
				if isDummy(c) {
					return yTop[cellL[c]] + 1
				}
				return yTop[cellL[c]] + 2
			},
		}
	}
	realCrossings := func() int {
		lay := buildLayout()
		type run struct{ col, y0, y1, cid int }
		type hrun struct{ row, x0, x1, cid int }
		var vr []run
		var hr []hrun
		for _, s := range segs {
			laneRow := lay.gapY(s.gap) + s.lane
			up := lay.botY(s.upper)
			dnv := lay.topY(s.lower)
			if !isDummy(s.lower) {
				dnv--
			}
			a, b := xU(s), xL(s)
			vr = append(vr, run{a, min(up, laneRow), max(up, laneRow), s.cid})
			vr = append(vr, run{b, min(laneRow, dnv), max(laneRow, dnv), s.cid})
			if a != b {
				hr = append(hr, hrun{laneRow, min(a, b), max(a, b), s.cid})
			}
		}
		cells := map[[2]int]bool{}
		for _, v := range vr {
			for _, h := range hr {
				if v.cid != h.cid && h.x0 <= v.col && v.col <= h.x1 && v.y0 <= h.row && h.row <= v.y1 {
					cells[[2]int{v.col, h.row}] = true
				}
			}
		}
		return len(cells)
	}
	metric := func() int { return 100 * realCrossings() }
	moveBox := func(c string, nx float64) {
		cxm[c] = nx
		cellX[c] = nx - float64(CW(c)>>1)
	}
	gapOK := func(c string, nx float64) bool {
		r := rows[cellL[c]]
		i := -1
		for j, x := range r {
			if x == c {
				i = j
				break
			}
		}
		if nx-float64(CW(c)>>1) < 0 {
			return false
		}
		if i > 0 {
			if nx-cxm[r[i-1]] < sepC(r[i-1], c) {
				return false
			}
		}
		if i < len(r)-1 {
			if cxm[r[i+1]]-nx < sepC(c, r[i+1]) {
				return false
			}
		}
		return true
	}
	assignPorts()
	if !o.NoRefine {
		// order-search: adjacent-swap hill-climb on within-layer order
		obest := metric()
		for pass := 0; pass < 12; pass++ {
			improved := false
			for l := 0; l <= maxL; l++ {
				for i := 0; i < len(rows[l])-1; i++ {
					sw := func() { rows[l][i], rows[l][i+1] = rows[l][i+1], rows[l][i] }
					sw()
					computeCoords()
					assignPorts()
					if m := metric(); m < obest {
						obest = m
						improved = true
					} else {
						sw()
						computeCoords()
						assignPorts()
					}
				}
			}
			if !improved {
				break
			}
		}
		best := metric()
		deltas := []float64{-1, 1, -2, 2, -3, 3}
		for pass := 0; pass < 24; pass++ {
			improved := false
			for _, c := range NODES {
				for _, delta := range deltas {
					cur := cxm[c]
					nx := cur + delta
					if !gapOK(c, nx) {
						continue
					}
					moveBox(c, nx)
					assignPorts()
					if cc := metric(); cc < best {
						best = cc
						improved = true
					} else {
						moveBox(c, cur)
						assignPorts()
					}
				}
			}
			// dummy-CHANNEL move: shift a long edge's whole straightened channel sideways
			for _, ch := range chains {
				var ds []string
				for _, p := range ch.pts {
					if isDummy(p) {
						ds = append(ds, p)
					}
				}
				if len(ds) == 0 {
					continue
				}
				for _, delta := range deltas {
					ok := true
					for _, dd := range ds {
						if !gapOK(dd, cxm[dd]+delta) {
							ok = false
							break
						}
					}
					if !ok {
						continue
					}
					cur := make([]float64, len(ds))
					for i, dd := range ds {
						cur[i] = cxm[dd]
					}
					for _, dd := range ds {
						moveBox(dd, cxm[dd]+delta)
					}
					assignPorts()
					if m := metric(); m < best {
						best = m
						improved = true
					} else {
						for i, dd := range ds {
							moveBox(dd, cur[i])
						}
						assignPorts()
					}
				}
			}
			if !improved {
				break
			}
		}
		// port-swap phase: freeze far-end order, swap adjacent ports when it cuts a real crossing
		frozen = true
		assignPorts()
		best = metric()
		for pass := 0; pass < 12; pass++ {
			improved := false
			for _, ol := range []*olist{botSeg, topSeg} {
				for _, k := range ol.keys {
					list := ol.m[k]
					for i := 0; i < len(list)-1; i++ {
						sw := func() { list[i], list[i+1] = list[i+1], list[i] }
						sw()
						assignPorts()
						if m := metric(); m < best {
							best = m
							improved = true
						} else {
							sw()
							assignPorts()
						}
					}
				}
			}
			if !improved {
				break
			}
		}
		mn := math.Inf(1) // shift right only if a nudge pushed a box off the left edge
		for _, c := range cellKeys {
			if cellX[c] < mn {
				mn = cellX[c]
			}
		}
		if mn < 0 {
			for _, c := range cellKeys {
				cxm[c] -= mn
				cellX[c] -= mn
			}
			assignPorts()
		}
		canvasW = 1
		for _, c := range cellKeys {
			if w := int(cellX[c]) + CW(c); w > canvasW {
				canvasW = w
			}
		}
	}

	// 8c. NO-OVERLAP deconflict -------------------------------------------------
	deconflict := func() bool {
		for iter := 0; iter < 80; iter++ {
			lay := buildLayout()
			type run struct {
				col, y0, y1, cid int
				seg              *seg
				sideU            bool
				node             string
			}
			var runs []run
			for _, s := range segs {
				laneRow := lay.gapY(s.gap) + s.lane
				up := lay.botY(s.upper)
				dnv := lay.topY(s.lower)
				if !isDummy(s.lower) {
					dnv--
				}
				runs = append(runs, run{xU(s), min(up, laneRow), max(up, laneRow), s.cid, s, true, s.upper})
				runs = append(runs, run{xL(s), min(laneRow, dnv), max(laneRow, dnv), s.cid, s, false, s.lower})
			}
			rangesHit := func(y0, y1, by0, by1 int) bool { return max(y0, by0) <= min(y1, by1) }
			boxAt := func(col, y0, y1 int) bool {
				for _, c := range NODES {
					x0 := int(cellX[c])
					if col >= x0 && col <= x0+CW(c)-1 && rangesHit(y0, y1, lay.yTop[cellL[c]], lay.yTop[cellL[c]]+2) {
						return true
					}
				}
				return false
			}
			runAt := func(col, y0, y1, cid int) bool {
				for _, r := range runs {
					if r.col == col && r.cid != cid && rangesHit(y0, y1, r.y0, r.y1) {
						return true
					}
				}
				return false
			}
			var ov []run
			for i := 0; i < len(runs) && ov == nil; i++ {
				for j := i + 1; j < len(runs); j++ {
					r, w := runs[i], runs[j]
					if r.cid != w.cid && r.col == w.col && rangesHit(r.y0, r.y1, w.y0, w.y1) {
						ov = []run{r, w}
						break
					}
				}
			}
			if ov == nil {
				return true
			}
			moved := false
			for _, r := range ov { // try to shift this run to the nearest free column
				for _, dd := range []int{1, -1, 2, -2, 3, -3} {
					nc := r.col + dd
					if nc < 0 {
						continue
					}
					if isDummy(r.node) {
						if boxAt(nc, r.y0, r.y1) || runAt(nc, r.y0, r.y1, r.cid) {
							continue
						}
						for _, dpt := range chains[r.cid].pts { // move the whole straightened channel
							if isDummy(dpt) && int(cxm[dpt]) == r.col {
								cxm[dpt] = float64(nc)
							}
						}
					} else { // a real port: stay inside the box border, land on a free column
						x0 := int(cellX[r.node])
						if nc <= x0 || nc >= x0+CW(r.node)-1 {
							continue
						}
						if runAt(nc, r.y0, r.y1, r.cid) {
							continue
						}
						if r.sideU {
							r.seg.pU = nc
						} else {
							r.seg.pL = nc
						}
					}
					moved = true
					break
				}
				if moved {
					break
				}
			}
			if !moved {
				return false // no free column — leave it (shouldn't happen at crew scale)
			}
		}
		return false
	}
	deconflict()
	for _, s := range segs {
		if xU(s)+1 > canvasW {
			canvasW = xU(s) + 1
		}
		if xL(s)+1 > canvasW {
			canvasW = xL(s) + 1
		}
	}
	fl := buildLayout()
	yTop, height, gapY, topY, botY := fl.yTop, fl.height, fl.gapY, fl.topY, fl.botY

	// 9. render --------------------------------------------------------------
	mk := func() [][]int {
		g := make([][]int, height)
		for i := range g {
			g[i] = make([]int, canvasW)
		}
		return g
	}
	mkS := func() [][]string {
		g := make([][]string, height)
		for i := range g {
			g[i] = make([]string, canvasW)
		}
		return g
	}
	mkI := func(fill int) [][]int {
		g := make([][]int, height)
		for i := range g {
			g[i] = make([]int, canvasW)
			for j := range g[i] {
				g[i][j] = fill
			}
		}
		return g
	}
	mask := mk()
	chr := mkS()  // "" = empty (JS null); a painted space is impossible (glyphs only)
	cCol := mkS() // box/arrow color
	vCol := mkS() // color of N/S owner
	hCol := mkS() // color of E/W owner
	hasV := make([][]bool, height)
	hasH := make([][]bool, height)
	for i := range hasV {
		hasV[i] = make([]bool, canvasW)
		hasH[i] = make([]bool, canvasW)
	}
	owner := mkI(-1)
	multi := make([][]bool, height)
	for i := range multi {
		multi[i] = make([]bool, canvasW)
	}
	vEdge := mkI(-1)
	hEdge := mkI(-1)
	ovlp := map[string]bool{}
	dashV := map[[2]int]bool{}
	dashH := map[[2]int]bool{}
	inb := func(x, yy int) bool { return yy >= 0 && yy < height && x >= 0 && x < canvasW }
	bit := func(x, yy, b, id int, c string, cid int) {
		if !inb(x, yy) {
			return
		}
		mask[yy][x] |= b
		if b&(nBit|sBit) != 0 {
			if vEdge[yy][x] >= 0 && vEdge[yy][x] != cid {
				ovlp["V "+itoa(x)+","+itoa(yy)] = true
			}
			vEdge[yy][x] = cid
			vCol[yy][x] = c
			hasV[yy][x] = true
		}
		if b&(eBit|wBit) != 0 {
			if hEdge[yy][x] >= 0 && hEdge[yy][x] != cid {
				ovlp["H "+itoa(x)+","+itoa(yy)] = true
			}
			hEdge[yy][x] = cid
			hCol[yy][x] = c
			hasH[yy][x] = true
		}
		if owner[yy][x] == -1 {
			owner[yy][x] = id
		} else if owner[yy][x] != id {
			multi[yy][x] = true
		}
	}
	put := func(x, yy int, ch2, c string) {
		if inb(x, yy) {
			chr[yy][x] = ch2
			cCol[yy][x] = c
		}
	}
	vsg := func(y1, y2, x int, ref bool, id int, c string, cid int) {
		a, b := y1, y2
		if b < a {
			a, b = b, a
		}
		for yy := a; yy <= b; yy++ {
			if yy > a {
				bit(x, yy, nBit, id, c, cid)
			}
			if yy < b {
				bit(x, yy, sBit, id, c, cid)
			}
			if ref {
				dashV[[2]int{x, yy}] = true
			}
		}
	}
	hsg := func(x1, x2, yy int, ref bool, id int, c string, cid int) {
		a, b := x1, x2
		if b < a {
			a, b = b, a
		}
		for x := a; x <= b; x++ {
			if x > a {
				bit(x, yy, wBit, id, c, cid)
			}
			if x < b {
				bit(x, yy, eBit, id, c, cid)
			}
			if ref {
				dashH[[2]int{x, yy}] = true
			}
		}
	}

	// cursor frame tint — gated on the node having a colour, so mono stays ANSI-free
	const curFrame = "\x1b[48;5;237m"
	boxCol := func(c string) string {
		cc := colorOf(c)
		if c == o.Cursor && cc != "" {
			return curFrame + cc
		}
		return cc
	}
	for _, c := range NODES { // boxes (own color)
		x0, w, t := int(cellX[c]), CW(c), yTop[cellL[c]]
		cc, fcc := colorOf(c), boxCol(c)
		lbl := " " + boxLabel(c) + " "
		pad := w - 2 - len(lbl)
		lp := pad >> 1
		if lp < 0 {
			lp = 0
		}
		put(x0, t, "╔", fcc)
		put(x0+w-1, t, "╗", fcc)
		put(x0, t+2, "╚", fcc)
		put(x0+w-1, t+2, "╝", fcc)
		for x := x0 + 1; x < x0+w-1; x++ {
			put(x, t, "═", fcc)
			put(x, t+2, "═", fcc)
		}
		put(x0, t+1, "║", fcc)
		put(x0+w-1, t+1, "║", fcc)
		rp := pad - lp
		if rp < 0 {
			rp = 0
		}
		text := strings.Repeat(" ", lp) + lbl + strings.Repeat(" ", rp)
		tr := []rune(text)
		for i := 0; i < len(tr) && x0+1+i < x0+w-1; i++ {
			put(x0+1+i, t+1, string(tr[i]), cc)
		}
	}
	for _, c := range NODES { // T-junctions where a line LEAVES a box (source side only)
		t, cc := yTop[cellL[c]], boxCol(c)
		for _, s := range botSeg.get(c) {
			if s.to != c {
				g := "╦"
				if s.ref {
					g = "╤"
				}
				put(xU(s), t+2, g, cc)
			}
		}
		for _, s := range topSeg.get(c) {
			if s.to != c {
				g := "╩"
				if s.ref {
					g = "╧"
				}
				put(xL(s), t, g, cc)
			}
		}
	}

	for _, s := range segs { // route each segment in its source's color
		cc := colorOf(s.from)
		laneRow := gapY(s.gap) + s.lane
		a, b := xU(s), xL(s)
		upStart := botY(s.upper) // exit bottom border
		downEnd := topY(s.lower)
		if !isDummy(s.lower) {
			downEnd-- // STOP above target border
		}
		vsg(upStart, laneRow, a, s.ref, s.id, cc, s.cid)
		hsg(a, b, laneRow, s.ref, s.id, cc, s.cid)
		vsg(laneRow, downEnd, b, s.ref, s.id, cc, s.cid)
		if s.final { // arrowhead on the incoming column (solid = dep, hollow = ref)
			toIsLower := s.to == s.lower
			var g string
			if s.ref {
				if toIsLower {
					g = "▽"
				} else {
					g = "△"
				}
			} else {
				if toIsLower {
					g = "▼"
				} else {
					g = "▲"
				}
			}
			if toIsLower {
				put(b, topY(s.lower)-1, g, cc)
			} else {
				put(a, botY(s.upper)+1, g, cc)
			}
		}
	}

	if wantOverlaps { // invariant check: the snapshot suite asserts this is empty for every fixture
		var out []string
		for k := range ovlp {
			out = append(out, k)
		}
		sort.Strings(out)
		return "", out
	}

	// 10. compose (crossings hop; color runs) --------------------------------
	var out []string
	for yy := 0; yy < height; yy++ {
		var line strings.Builder
		cur := ""
		for x := 0; x < canvasW; x++ {
			var g, c string
			if chr[yy][x] != "" {
				g, c = chr[yy][x], cCol[yy][x]
			} else if mask[yy][x] != 0 {
				m := mask[yy][x]
				k := [2]int{x, yy}
				if multi[yy][x] && hasV[yy][x] && hasH[yy][x] {
					// crossing hop: the VERTICAL passes over, drawn at ITS OWN weight
					if dashV[k] {
						g = "│"
					} else {
						g = "║"
					}
					c = vCol[yy][x]
				} else {
					set := glyphD
					if dashV[k] || dashH[k] {
						set = glyphL
					}
					g = set[m]
					c = vCol[yy][x]
					if c == "" {
						c = hCol[yy][x]
					}
				}
			} else {
				g, c = " ", ""
			}
			want := ""
			if g != " " {
				want = c
			}
			if want != cur {
				if cur != "" {
					line.WriteString(reset)
				}
				if want != "" {
					line.WriteString(want)
				}
				cur = want
			}
			line.WriteString(g)
		}
		if cur != "" {
			line.WriteString(reset)
		}
		out = append(out, trimRight(line.String()))
	}
	return strings.Join(out, "\n"), nil
}

// trimRight — JS: line.replace(/[ \t]+(\x1b\[0m)?$/, (m, r) => r || ”)
func trimRight(l string) string {
	hadReset := strings.HasSuffix(l, reset)
	body := l
	if hadReset {
		body = l[:len(l)-len(reset)]
	}
	trimmed := strings.TrimRight(body, " \t")
	if hadReset {
		return trimmed + reset
	}
	return trimmed
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		return "-" + string(b)
	}
	return string(b)
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
