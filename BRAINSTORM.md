# Brainstorm — dynamic wiring & on-the-fly groups

Design notes for turning crew from "fan a task across a hardcoded group" into
"pick a set of projects on the fly, run them locally, and auto-wire them to talk to each
other locally while everything else stays remote." Not built yet — this is the plan.

## The problem

- A group (`alpha`/`beta`/`gamma`) is **hardcoded** in the config.
- Projects communicate because we pass `env=local`, and each project's `local` env file
  hardcodes peers at `localhost`: in x's env, y = localhost; in y's env, z = localhost.
- To run a **different** subset locally, you must hand-edit each project's `local` env so
  that co-run peers point local and the rest point remote. Painful, per-run.
- `workspace` / `claude` don't care (they just open dirs). Only `start` needs the wiring.

## Core reframe

Stop hardcoding "who is local" in the env files. Instead:

1. The committed env files point every peer at a **real remote** (qa / pre / pro).
2. crew, at `start`, injects `localhost` for exactly the peers that are in the chosen
   running set. Peers **not** started keep the base env's remote value.

So the "group" becomes ephemeral: the set you pass decides the wiring; nothing is edited
per run.

Example: `crew start rge-fe rge-be env=pro`
- rge-fe loads its `pro` env; rge-be is running → `BE_URL` → `localhost:5875`; mcp /
  orchestra / etc. keep their pro URLs.
- rge-be loads its `pro` env; rge-fe running → `FE_URL` → `localhost:3000`; rest pro.
- Net: fe↔be local, everything else pro.

`env` selects the per-project base file (`.envs/{env}-…`). Env sets can differ per project
(some have pre/pre2/pre3/pre4, some only pre/pre2; all have qa/pro). Resolved per project;
if a project lacks the requested env → clear error naming project + env, nothing starts.

⚠️ `env=pro` base means **unstarted peers point at production**. Powerful, sharp — normally
base on `qa`/`pre`.

## Does this remove local.env?

- **For peer/service wiring: yes.** local.env's whole job ("peers → localhost") is now done
  dynamically on top of a real env. Stop maintaining it.
- **For infra (DB / Redis / caches): open question.** Those aren't crew "projects", so crew
  won't flip them. Basing on qa/pro means using that env's DB/Redis. Options:
  - **a.** Accept the base env's infra (local code against qa DB) — often fine for qa.
  - **b.** Keep a *tiny* per-project override for infra only (DB/redis → localhost) — much
    smaller than today's local.env.
  - **c.** Register infra as crew "endpoints" (a `postgres` pseudo-entry with a `url`) so
    crew can flip it too when you choose to run it locally.

## Auto-discovery + dependency graph

Don't declare links manually (N² and huge). **Discover** them:

- Per project, one identity hint: a local `url` and a `match` slug that appears in all of
  its remote hostnames.
  ```json
  "sdk-mcp": { "url": "http://localhost:8081", "match": "bee-sdk-mcp" }
  ```
  `match` = slug common to `qa-bee-sdk-mcp…`, `pre-bee-sdk-mcp…`, `pro-bee-sdk-mcp…`, so one
  token covers every env.
- crew scans each project's env values; any value containing a peer's `match` is an edge
  `P → T` and an origin to rewrite. Aggregate → the **dependency graph**, no manual edges.

Uses of the graph:
1. **Selection by graph** instead of hardcoded groups: pick a node, crew offers its
   dependency closure to run locally (multiselect); the rest stay remote.
2. **Visualize**: `crew graph` — who talks to whom, and for a chosen set, which edges flip
   to localhost.
3. **Wiring = the same edges**: an edge flips to localhost only when **both** endpoints are
   in the running set.

Nuances: edges are env-independent (same peers; URLs differ, `match` catches all); cycles
are fine (visited-set for closure); DB/Redis aren't projects so aren't in the graph (see
infra options).

## Delivering the env (the hard part)

Most services **source** their env file at startup (`set -a && . .envs/local`, django
dotenv, orchestra's `cp .envs/$env .env`). So a plain process-env injection gets
**clobbered** by the file. Two mechanisms:

- **A — crew becomes the env loader (preferred).** crew reads the file itself, applies the
  localhost overrides last, and runs the **bare** app command with that env — no sourcing
  in the command, so nothing overrides the overrides.
  - Load the file *shell-accurately* (don't hand-parse): run
    `sh -c 'set -a; . <file>; set +a; env -0'`, capture, diff against baseline → the file's
    contribution (handles quotes/interpolation/conditionals).
  - Overlay peer overrides → spawn `go run .` / `python manage.py runserver` / … with the
    merged env.
  - Config splits per project: `env` (file, `{env}`-templated) + `start` (bare command,
    no `set -a && . … &&`).
  - Exception: apps that load a dotenv file **themselves** by path (django
    `DJANGO_DOT_ENV_PATH`, orchestra `cp`). Injection won't beat their own loader → deliver
    the same resolved env as a **temp file** and point the path var at it. No original
    mutation, overrides baked in.
- **B — transient env-file rewrite.** crew rewrites each running project's env file
  (peer→localhost), runs, **restores on teardown** (crew's settle/teardown makes restore
  safe). Universal but mutates files during the run; needs backup + crash-safe restore +
  `--dry-run` diff. Fallback if A is awkward for some app.

Net config per project (mechanism A): `env` + `start` (bare) + `url` + `match`. ~4 fields,
N entries, no N² links.

Boundary check: crew stays agnostic — it loads a file, string-swaps peer origins it's told
about, passes env. It never interprets what a URL means. (This is separate from readiness/
ordering, which is the `dependsOn` idea, still deferred; for now rge-mcp just `sleep 20`s.)

## Selection UI: terminal vs browser

The graph selection can live in either; support both, same backend.

- **Terminal (default + fallback):** arrow/space multiselect (already built) over the
  graph's reachable nodes. Always works — SSH, headless, tmux, CI.
- **Browser (`crew start --web`, opt-in):** ephemeral `node:http` server (zero dep) serves
  a self-contained HTML page with the graph (hand-rolled inline SVG to stay offline/
  zero-dep) + checkboxes; open with `open`/`xdg-open`; page POSTs the selection back; crew
  closes the server and proceeds in the terminal. Standard localhost-callback pattern
  (`gh auth login`). Auto-fall back to terminal when no browser/`DISPLAY`.

Tradeoffs: browser = nicer for a real graph but more code + a GUI requirement (can't be the
only path); terminal = universal, in-flow, less pretty.

## Config shape (sketch)

```json
"projects": {
  "sdk-mcp": {
    "path": "sdk-mcp",
    "env": ".envs/{env}-bee-sdk-mcp.env",
    "start": "go run .",
    "url": "http://localhost:8081",
    "match": "bee-sdk-mcp"
  }
}
```

## Roadmap / phasing

1. **`crew graph` (read-only).** Scan every project's `.envs/*`, match peers by `match`,
   print the dependency graph + per-edge env var. Zero risk; validates discovery against
   real envs. Pick each project's `match` slug here.
2. **Ephemeral multi-project targets** (`crew start a b c`) + terminal graph picker.
3. **Env-injection wiring** (mechanism A; temp-file variant for dotenv apps). The localhost
   flips.
4. **`--web`** visual selection on the same computed graph + selection→wiring pipeline.

## Open questions

- Infra (DB/Redis): a, b, or c above?
- Mechanism A everywhere, or B for some apps? (django/orchestra load their own dotenv.)
- Does `match`-by-slug uniquely identify every project across all its remote hostnames?
- Multi-endpoint projects (REST + MCP on different ports) — one `url` or named endpoints?
