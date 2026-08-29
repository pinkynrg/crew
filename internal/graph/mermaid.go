package graph

import (
	"regexp"
	"strings"
)

// ParseMermaid — the flowchart subset that maps to a dependency DAG. `A --> B`, chains, fan `A & B --> C`, labels (`-->|x|`, `-- x -->`), node shapes (`A[Text]`
// -> id A), two-headed arrows (`<-->`, `x--x`, `o--o`). Dotted (`-.->`) or a `|ref|` label = ref
// edge. Ignores subgraph/style/class/direction lines. Not a full mermaid parser.
var (
	reComment = regexp.MustCompile(`%%.*$`)
	reKeyword = regexp.MustCompile(`(?i)^(graph|flowchart|subgraph|end|classDef|class|style|linkStyle|direction|click)\b`)
	reLabel1  = regexp.MustCompile(`--\s+([^->|][^-]*?)\s+-->`) // `-- label -->` -> `-->|label|`
	reLabel2  = regexp.MustCompile(`-\.\s+([^.]*?)\s+\.->`)     // `-. label .->` -> `-.->|label|`
	reOp      = regexp.MustCompile(`\s*(<-\.->|<-->|<--|<==>|x--x|o--o|-\.->|-\.-|--x|--o|-->|---|==>|===)\s*(?:\|([^|]*)\|\s*)?`)
	reCleanID = regexp.MustCompile(`^([A-Za-z0-9_.-]+)\s*[\[({>]`)
	reRef     = regexp.MustCompile(`(?i)ref`)
)

func ParseMermaid(text string) ([]string, []Edge) {
	var nodes []string
	seen := map[string]bool{}
	var edges []Edge
	cleanID := func(raw string) string {
		raw = strings.TrimSpace(raw)
		if m := reCleanID.FindStringSubmatch(raw); m != nil {
			raw = m[1]
		}
		raw = strings.ReplaceAll(raw, `"`, "")
		raw = strings.ReplaceAll(raw, `'`, "")
		return strings.TrimSpace(raw)
	}
	add := func(raw string) string {
		n := cleanID(raw)
		if n != "" && !seen[n] {
			seen[n] = true
			nodes = append(nodes, n)
		}
		return n
	}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(reComment.ReplaceAllString(line, ""))
		if line == "" || reKeyword.MatchString(line) {
			continue
		}
		line = reLabel1.ReplaceAllStringFunc(line, func(m string) string {
			return "-->|" + strings.TrimSpace(reLabel1.FindStringSubmatch(m)[1]) + "|"
		})
		line = reLabel2.ReplaceAllStringFunc(line, func(m string) string {
			return "-.->|" + strings.TrimSpace(reLabel2.FindStringSubmatch(m)[1]) + "|"
		})
		idx := reOp.FindAllStringSubmatchIndex(line, -1)
		var parts []string
		type opT struct{ op, label string }
		var ops []opT
		last := 0
		for _, m := range idx {
			parts = append(parts, line[last:m[0]])
			op := line[m[2]:m[3]]
			label := ""
			if m[4] >= 0 {
				label = line[m[4]:m[5]]
			}
			ops = append(ops, opT{op, label})
			last = m[1]
		}
		parts = append(parts, line[last:])
		if len(ops) == 0 { // lone node(s)
			for _, p := range strings.Split(parts[0], "&") {
				add(p)
			}
			continue
		}
		for i, op := range ops {
			var lhs, rhs []string
			for _, p := range strings.Split(parts[i], "&") {
				if n := add(p); n != "" {
					lhs = append(lhs, n)
				}
			}
			for _, p := range strings.Split(parts[i+1], "&") {
				if n := add(p); n != "" {
					rhs = append(rhs, n)
				}
			}
			ref := strings.Contains(op.op, ".") || reRef.MatchString(op.label)
			bidi := op.op[0] == '<' || op.op == "x--x" || op.op == "o--o" // two-headed -> BOTH directions (a 2-cycle)
			for _, a := range lhs {
				for _, b := range rhs {
					if a != "" && b != "" && a != b {
						edges = append(edges, Edge{From: a, To: b, Ref: ref})
						if bidi {
							edges = append(edges, Edge{From: b, To: a, Ref: ref})
						}
					}
				}
			}
		}
	}
	return nodes, edges
}
