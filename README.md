# GoTune

GoTune is a source-centered Go performance debugger for VS Code. Start from
the function under the cursor, search globally for a bottleneck, or describe
a known problem. GoTune turns pprof and runtime trace evidence into findings
beside the code, then reruns the same workload to verify whether a change
helped.

```text
Analyze current function, find global bottlenecks, or choose a known problem
→ GoTune collects matching runtime evidence
→ findings open the exact source and next action
→ edit the code
→ rerun the same scenario
→ compare runtime and business outcomes
```

The default sidebar contains only Analyze and Findings. Raw profiles, manual
captures, saved scenarios, Top, Flame Graph, Call Tree, Source, and
`go tool trace` remain available under **Show advanced evidence**.

## Start from code

Put the cursor in a Go function and run **GoTune: Analyze Current Function
Performance**. When the function has no evidence yet, GoTune starts the
current `package main` when possible, captures CPU and allocations while the
operation is reproduced, then takes a post-GC live-memory snapshot.
The function panel, CodeLens, Hover, gutter marker, and line annotations
combine all evidence in the active Investigation:

- CPU self and cumulative cost
- timed allocation bytes and object counts
- live bytes and object counts attributed to the allocation path
- block, mutex, network, syscall, and scheduler waiting
- Goroutine growth and stable blocking Findings
- primary caller and expensive callees
- matching scenario baseline delta

If evidence is missing, the editor Quick Fix captures it without requiring
you to choose a pprof endpoint first. Allocation findings can launch focused
compiler escape analysis. The same panel can mark the function as the current
optimization target and repeat a compatible evidence protocol after the edit.

## Find a global bottleneck

Open **Go Performance → Analyze → Find global bottlenecks**, then rank the
kind of cost that matters: CPU, live memory, allocations, Goroutine/blocking,
or an operation timeline. CPU, memory, allocation, mutex, and block evidence
opens as a Graphviz call graph when `dot` is available.

Graph nodes show self and inclusive cost. Clicking a node opens its local Go
source and combined function evidence. The precise Top, Source, Flame Graph,
and raw Call Tree remain available beside the graph.

## Start from a problem

Open **Go Performance → Analyze → Investigate a known performance problem**,
then choose the symptom:

- CPU usage is high
- Memory keeps growing
- Too many allocations or GC pressure
- Request stuck or possible deadlock
- Operation or request is slow

GoTune starts the current `package main` when possible and automatically
combines the relevant evidence. For example, memory growth uses a post-GC
Heap baseline, timed allocation delta, repeated Goroutine stacks, and two
more post-GC Heap snapshots. Blocking uses repeated Goroutine progress plus
Mutex and Block profiles when contention sampling is enabled.

Findings deliberately say “suspicious” or “possible” where pprof cannot prove
a deadlock or object owner. Normal stable I/O waits are not reported as
errors. From a blocking Finding, **Find related channel or lock code** uses
the Go language server's real symbol references to list senders, receivers,
lock/unlock sites, and wait/signal sites.

## Start and stop a target

GoTune can start a local target in two ways:

1. **Run current Go main with profiler** tries the active `package main`
   immediately and only asks for another target if that fails.
2. **Run launch.json with profiler** reuses a Go launch configuration's
   program, arguments, environment, and debug behavior.

Both paths use a Go build Overlay to inject an isolated pprof server without
changing the workspace. The server binds a protected random localhost port.
Stopping GoTune terminates the full process tree or the matching VS Code
debug session and removes temporary Overlay files.

GoTune inherits `go.alternateTools`, `go.toolsEnvVars`, `go.goroot`,
`go.gopath`, and `go.buildFlags` from the official VS Code Go extension.

## Repeatable scenarios and verification

A Performance Scenario stores:

- exact main package or `launch.json` target
- manual, VS Code Task, shell command, or Go Benchmark workload
- warmup and capture duration
- CPU, allocation, Heap, Goroutine, Mutex, and Block capture protocol
- success metrics and their adapter
- first-run baseline and up to nine recent runs
- Git commit, tracked dirty state, and diff summary

The first run establishes the baseline. Later runs reuse the same conditions
and produce improvement/regression Findings. Baseline Profile sessions are
preserved across VS Code restarts instead of being evicted with ordinary
history. Every run automatically records comparable runtime outcomes such as
sampled CPU, allocated bytes and objects, post-GC live-heap/object growth,
Mutex/Block delay, and Goroutine growth alongside business metrics. A scenario
that requests contention evidence also starts its target with contention
sampling enabled for that run.

Business metrics can come from:

- JSON Lines printed by a command or custom script
- regular expressions over command output
- Prometheus `/api/v1/query` or `/api/v1/query_range` URLs returning one
  scalar or series per metric
- native Go Benchmark output

Go Benchmark scenarios run repeated `go test -bench -benchmem` samples,
aggregate `ns/op`, `B/op`, and `allocs/op`, and attach CPU plus allocation
Profiles to the same source investigation.

## Execution trace

**Trace execution time** keeps the complete `go tool trace` timeline as
advanced evidence. It also automatically derives network, synchronization,
syscall, and scheduler-delay pprof profiles and maps their dominant paths back
to functions and source lines. The first result is a source-oriented timing
summary. It explicitly reports aggregate delay across Goroutines—not a fake
single-request wall-clock breakdown—and offers the raw timeline when exact
ordering or application regions matter.

## Struct layout

Run **GoTune: Inspect Struct Memory Layout** with the cursor in a struct.
The bundled Go helper uses `go/types` and the configured GOARCH to show field
offsets, size, alignment, padding, an optimized order, and estimated savings.

The automatic field reorder preserves comments and struct tags and is only
offered when conservative safety checks pass. Exported structs, unkeyed
literals, embedded/grouped fields, `unsafe.Offsetof`, cgo, generated code,
and packages with order-sensitive serialization dependencies are preview
only.

## Remote and production profiles

**Connect to a pprof server** accepts a server root such as
`http://127.0.0.1:6060`; GoTune builds the concrete protobuf endpoint.
Entering the HTML `/debug/pprof/` index as a direct Profile URL is rejected
with an actionable explanation.

Map container or production source paths to the local checkout with:

```json
{
  "gotune.sourcePathMappings": {
    "/app/src/my-service": "/Users/me/project/my-service"
  }
}
```

The mapping is shared by source navigation, Findings, CodeLens, Hover, line
annotations, and escape analysis.

## Contention profiling

Mutex and Block sampling adds runtime overhead and is disabled by default.
Use **Contention profiling** in the Running view to save the switch to VS
Code User Settings. Guided blocking/latency investigations enable it for a
new GoTune-managed run without forcing you to edit JSON settings.

## Development

```bash
npm install
npm test
cd helper && go test ./...
```

Open this folder in VS Code and press `F5` to launch the Extension
Development Host.

The extension uses the Go toolchain configured in `.vscode/settings.json`.
GoTune-specific overrides are available for the executable, environment,
build flags, program arguments, capture durations, contention profiling, and
source path mappings.
