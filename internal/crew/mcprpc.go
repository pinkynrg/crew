package crew

// The MCP wire: newline-delimited JSON-RPC 2.0 over stdio — four message types, hand-rolled.
// `annotations` are MCP-spec tool hints (readOnlyHint/destructiveHint/idempotentHint) — clients
// use them to decide how loudly to ask permission.

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

func toolSchema(props *OM, required ...string) *OM {
	s := om("type", "object", "properties", props)
	if len(required) > 0 {
		s.Set("required", toAnyArr(required))
	}
	return s
}

func prop(typ, desc string) *OM {
	p := om("type", typ)
	if desc != "" {
		p.Set("description", desc)
	}
	return p
}

func mcpTools() []any {
	tool := func(name, desc string, ann *OM, schema *OM) *OM {
		return om("name", name, "description", desc, "annotations", ann, "inputSchema", schema)
	}
	return []any{
		tool("services",
			"List all configured services: name, type, local URL, whether the folder is present and it can start/debug, its guards, and the env labels it is deployed under. Also returns lastSelection/lastDebug — the previous run. Call this first to discover what exists.",
			om("title", "List services", "readOnlyHint", true),
			toolSchema(NewOM())),
		tool("graph",
			"The dependency graph as data: services, dependency edges, reference edges (link-backs into frontends — excluded from connectivity/env derivation). Pass env to also get each service's derived env for that selection env.",
			om("title", "Dependency graph", "readOnlyHint", true),
			toolSchema(om("env", prop("string", "optional selection env — adds the derived env per service")))),
		tool("config_get",
			"Read crew's stored config (the committable config.json shape): the whole file, or one service/guard with its shared overrides. PREFER kind+name when the question is about a specific service/guard. Reading several services = one call per service.",
			om("title", "Read config", "readOnlyHint", true),
			toolSchema(func() *OM {
				kind := om("type", "string")
				kind.Set("enum", []any{"service", "guard"})
				return om("kind", kind, "name", prop("string", ""))
			}())),
		tool("status",
			"Report a run (or all runs): each service alive or exited. In a crew-start session the current run is the default.",
			om("title", "Run status", "readOnlyHint", true),
			toolSchema(om("runId", prop("string", "the run to inspect; defaults to the current session run")))),
		tool("logs",
			"Tail a run's captured output. Be token-frugal: filter with `grep` (OR terms: 'error|warn|traceback'), add `context` lines around hits when investigating, narrow with `service` only when following evidence, and pass the returned `nextCursor` back as `cursor` to read only NEW lines since your previous call. Reads are byte-capped, so huge logs are cheap. This is a pure READ — it never changes what the human sees in their live log viewer.",
			om("title", "Run logs", "readOnlyHint", true),
			toolSchema(om(
				"runId", prop("string", "the run to read; defaults to the current session run"),
				"service", prop("string", "only this service"),
				"lines", prop("number", "max lines per service (default 100)"),
				"grep", prop("string", "keep lines containing ANY |-separated term, case-insensitive (e.g. 'error|warn|exception')"),
				"context", prop("number", "include N lines around each grep match (like grep -C, max 10)"),
				"cursor", prop("object", "the nextCursor from your previous logs call — returns only lines appended since"),
			))),
	}
}

// `instructions` ride the initialize handshake — the client injects them into the agent's context
// at connection time, so the usage contract arrives "on boot" with zero tool calls.
var mcpInstructions = strings.Join([]string{
	"You are a READ-ONLY development copilot attached to a running crew slice. The human ran `crew start` and is watching the live log viewer beside you; your job is to help them develop and debug that run — read its logs, check what's alive, reason about wiring — and ASK them when anything is uncertain. You have NO write or lifecycle powers: you cannot start, stop, or edit anything. If the user asks you to start/stop services or change config, tell them to do it themselves (`crew start`, the viewer, `crew config`) — then help with the result.",
	"The tools all READ: `status` (what's alive/exited), `logs` (tail the captured output), `services` (what exists + wiring + lastSelection), `graph` (dependencies + derived env per service), `config_get` (read a service/guard's committable config). They default to the CURRENT run — no runId needed.",
	"Investigate logs METHODICALLY, one pass per call: (1) `status` — what is even running; (2) sweep ALL services with grep \"error|warn|exception|traceback\" and NO service filter; (3) for each service with hits, re-read it with `service` + a specific grep + `context` lines around the match; (4) then conclude. Narrow scope only when following evidence or when the user asked. Use `cursor` for repeat checks — it returns only new lines.",
	"`logs` is a pure read — it NEVER changes the human's live viewer. They drive their own view (filter/search/wrap) with the keyboard; you never touch it.",
	"When you spot the cause of a failure, explain it and propose the concrete fix (which service, which command/env/flag), but let the USER apply it — you don't edit config or restart. Confirm before assuming intent.",
}, "\n")

func dispatchTool(flags *Flags, name string, args *OM) (result *OM, errText string) {
	defer func() {
		if r := recover(); r != nil {
			if ce, ok := r.(*CrewError); ok {
				errText = ce.Error()
				return
			}
			errText = fmt.Sprintf("unexpected error: %v", r)
		}
	}()
	if args == nil {
		args = NewOM()
	}
	switch name {
	case "services":
		return toolServices(flags), ""
	case "graph":
		return toolGraph(flags, args), ""
	case "config_get":
		return toolConfigGet(flags, args), ""
	case "status":
		return toolStatus(flags, args), ""
	case "logs":
		return toolLogs(flags, args), ""
	}
	return nil, "unknown tool: " + name
}

// cmdMcp — the stdio server loop. The client closing stdin ends the server; the run it observes
// keeps streaming in crew start's viewer.
func cmdMcp(flags *Flags) {
	out := bufio.NewWriter(os.Stdout)
	send := func(msg *OM) {
		out.WriteString(compactJSON(msg) + "\n")
		out.Flush()
	}
	reply := func(id any, result any) { send(om("jsonrpc", "2.0", "id", id, "result", result)) }
	replyErr := func(id any, code int, message string) {
		send(om("jsonrpc", "2.0", "id", id, "error", om("code", jsonNum(code), "message", message)))
	}
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		v, err := ParseJSON([]byte(line))
		if err != nil {
			continue
		}
		msg, ok := v.(*OM)
		if !ok {
			continue
		}
		id := msg.Get("id")
		method := msg.GetStr("method")
		switch {
		case method == "initialize":
			reply(id, om(
				"protocolVersion", "2024-11-05",
				"capabilities", om("tools", NewOM()),
				"serverInfo", om("name", "crew", "version", Version),
				"instructions", mcpInstructions,
			))
		case method == "ping":
			reply(id, NewOM())
		case strings.HasPrefix(method, "notifications/"): // notifications get no reply
		case method == "tools/list":
			tools := NewOM()
			tools.Set("tools", mcpTools())
			reply(id, tools)
		case method == "tools/call":
			params := msg.GetOM("params")
			name := params.GetStr("name")
			args := params.GetOM("arguments")
			result, errText := dispatchTool(flags, name, args)
			content := func(text string) *OM {
				c := NewOM()
				c.Set("content", []any{om("type", "text", "text", text)})
				return c
			}
			if errText != "" {
				r := content(errText)
				r.Set("isError", true)
				reply(id, r)
			} else {
				reply(id, content(MarshalJSON(result)))
			}
		default:
			if id != nil {
				replyErr(id, -32601, "method not found: "+method)
			}
		}
	}
}
