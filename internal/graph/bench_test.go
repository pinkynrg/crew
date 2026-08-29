// Dev benchmark (not part of make test): documents the Prepare/Paint cost split that keeps the
// interactive selector responsive — Paint must stay orders of magnitude cheaper than Prepare.
package graph

import (
	"os"
	"testing"
)

func mustRead(b *testing.B) string {
	data, err := os.ReadFile("../../tests/graph/cases/beepro-stack.mmd")
	if err != nil {
		b.Fatal(err)
	}
	return string(data)
}

func BenchmarkPreparePaint(b *testing.B) {
	nodes, edges := ParseMermaid(mustRead(b))
	b.Run("prepare", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			Prepare(nodes, edges, Opts{})
		}
	})
	p := Prepare(nodes, edges, Opts{})
	b.Run("paint", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			p.Paint(nil, nil, "svc-09x")
		}
	})
}
