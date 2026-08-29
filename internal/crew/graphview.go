package crew

// The drawn `crew graph`: renders the dependency DAG (internal/graph) and pages it on a TTY;
// piped/redirected output prints plain.

import (
	"fmt"

	"github.com/pinkynrg/crew/internal/graph"
)

func graphEdgeList(ge graphEdges, shown map[string]bool, showRef bool) ([]string, []graph.Edge) {
	var nodes []string
	for _, n := range ge.nodes {
		if shown[n] {
			nodes = append(nodes, n)
		}
	}
	var edges []graph.Edge
	for _, e := range ge.real {
		if shown[e[0]] && shown[e[1]] {
			edges = append(edges, graph.Edge{From: e[0], To: e[1]})
		}
	}
	if showRef {
		for _, e := range ge.ref {
			if shown[e[0]] && shown[e[1]] {
				edges = append(edges, graph.Edge{From: e[0], To: e[1], Ref: true})
			}
		}
	}
	return nodes, edges
}

func cmdGraphDraw(flags *Flags, cfg *OM) {
	ge := collectGraphEdges(cfg)
	if len(ge.nodes) == 0 {
		emptyServicesState("Nothing to show here.")
		return
	}
	paint := serviceColors(cfg)
	clr := func(n string) string { return colorPrefix(paint, n) }
	draw := func(shown map[string]bool, showRef bool) string {
		nodes, edges := graphEdgeList(ge, shown, showRef)
		return graph.Render(nodes, edges, graph.Opts{ColorOf: clr})
	}
	showRef := loadGraphRefs(flags) // persisted, shared with the selector
	savedShown := loadGraphShown(flags)
	shown := map[string]bool{}
	src := savedShown
	if src == nil {
		src = ge.nodes
	}
	nodeSet := map[string]bool{}
	for _, n := range ge.nodes {
		nodeSet[n] = true
	}
	for _, n := range src {
		if nodeSet[n] {
			shown[n] = true
		}
	}
	if len(shown) == 0 {
		for _, n := range ge.nodes {
			shown[n] = true
		}
	}
	hasRef := len(ge.ref) > 0 // only offer the toggle when there ARE reference edges
	if !canInteractive() {
		fmt.Println(draw(shown, showRef))
		return
	}
	paintFn := func(n string) func(string) string { return paint[n] }
	for { // page the graph; 'f' overlays a node filter in place, 'r' toggles reference edges
		reason := pagerView(draw(shown, showRef), pagerMeta{
			shown: len(shown), total: len(ge.nodes), hasRef: hasRef, showRef: showRef,
			filter: &pagerFilter{
				nodes:  ge.nodes,
				shown:  shownKeys(shown, ge.nodes),
				paint:  paintFn,
				render: func(s map[string]bool) string { return draw(s, showRef) },
				onApply: func(list []string) {
					shown = map[string]bool{}
					for _, n := range list {
						shown[n] = true
					}
					saveGraphShown(flags, list)
				},
			},
		})
		if reason == "refs" {
			showRef = !showRef
			saveGraphRefs(flags, showRef)
			continue
		}
		break // "quit"
	}
}
