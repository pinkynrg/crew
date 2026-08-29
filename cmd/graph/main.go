// crew-graph — standalone ASCII graph renderer honoring the black-box contract that
// tests/graph/run.mjs drives (same as bin/graph.js's standalone entry):
//
//	crew-graph <file.mmd> [--opts <file.json>] [--color|--no-color] [--check-overlaps]
//	stdout = the render (mono when piped; --color forces the palette even piped)
//	--opts: {cursor, sublabel:{node:suffix}} — the selector rendering mode
//	--check-overlaps: collinear edge overlaps print to stderr and exit 3 when any exist
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/pinkynrg/crew/internal/graph"
)

func main() {
	var file, optsFile string
	forceColor, noColor, checkOverlaps := false, false, false
	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--opts" && i+1 < len(args):
			i++
			optsFile = args[i]
		case args[i] == "--color":
			forceColor = true
		case args[i] == "--no-color":
			noColor = true
		case args[i] == "--check-overlaps":
			checkOverlaps = true
		case len(args[i]) > 0 && args[i][0] != '-':
			file = args[i]
		}
	}
	var src []byte
	var err error
	if file != "" {
		src, err = os.ReadFile(file)
	} else {
		src, err = io.ReadAll(os.Stdin)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	nodes, edges := graph.ParseMermaid(string(src))

	var opts graph.Opts
	if optsFile != "" {
		var o struct {
			Cursor   string            `json:"cursor"`
			Sublabel map[string]string `json:"sublabel"`
		}
		b, err := os.ReadFile(optsFile)
		if err == nil {
			err = json.Unmarshal(b, &o)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		opts.Cursor = o.Cursor
		if o.Sublabel != nil {
			opts.Sublabel = func(n string) string { return o.Sublabel[n] }
		}
	}

	pal := []string{"\x1b[31m", "\x1b[32m", "\x1b[33m", "\x1b[34m", "\x1b[35m", "\x1b[36m", "\x1b[91m", "\x1b[92m", "\x1b[93m", "\x1b[94m", "\x1b[95m", "\x1b[96m"}
	tty := false
	if fi, err := os.Stdout.Stat(); err == nil {
		tty = fi.Mode()&os.ModeCharDevice != 0
	}
	color := forceColor || (tty && os.Getenv("NO_COLOR") == "" && !noColor)
	if color {
		cmap := map[string]string{}
		for i, n := range nodes {
			cmap[n] = pal[i%len(pal)]
		}
		opts.ColorOf = func(n string) string { return cmap[n] }
	}
	os.Stdout.WriteString(graph.Render(nodes, edges, opts) + "\n")
	if checkOverlaps {
		opts.ColorOf = nil
		if ovl := graph.Overlaps(nodes, edges, opts); len(ovl) > 0 {
			for _, o := range ovl {
				fmt.Fprintln(os.Stderr, o)
			}
			os.Exit(3)
		}
	}
}
