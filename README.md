# GoTune

GoTune is a source-centered Go performance studio for VS Code. Version 0.3
implements the first analysis and verification workflow from the design plan:

```text
Import or fetch pprof
→ inspect Top, Flame Graph, and Call Tree
→ open the matching Go source
→ see line heat and hotspot CodeLens
→ run focused escape analysis
→ compare the result with a baseline
```

## Run with Profiler

The **Running** view automates the normal local workflow:

1. Open a Go file and click **Run current Go main with profiler**.
2. If the active file is `package main`, GoTune saves it and runs its directory
   immediately. `go list` is used to resolve the package name but is not
   allowed to block the run.
3. Only when the active file is not `package main` does GoTune scan the
   workspace. If the current main fails to start, GoTune offers
   **Choose Another Target** instead of opening the folder picker first.
4. It uses a Go build Overlay to inject an isolated pprof server without
   creating or changing a Go file in the workspace.
5. The server binds a random `127.0.0.1` port and requires a random token.
6. Open **Live performance overview** to watch heap, allocation rate,
   goroutines, and GC, then choose the problem-oriented CPU, memory, or
   goroutine action.
7. Profile pages explain what the selected metric means, identify likely
   business-code hotspots, and link each conclusion back to source.
7. Each capture automatically becomes the current Session and opens the
   profile analysis.

Temporary Overlay files are removed when the target exits. Target stdout,
stderr, the exact Go command, and compatibility flags are available through
**Show target output**.

GoTune reuses `go.alternateTools`, `go.toolsEnvVars`, `go.goroot`,
`go.gopath`, and `go.buildFlags` from the official VS Code Go extension.
GoTune-specific settings override the inherited environment and build flags.

## Run locally

```bash
npm install
npm run compile
```

Open this folder in VS Code, press `F5`, and choose `Extension Development
Host`.

## Use

1. Open **Go Performance** in the Activity Bar.
2. In **Sessions**, use **Import pprof Profile** or **Fetch Profile from URL**.
   Remote capture accepts a pprof server root such as `http://127.0.0.1:6060`
   and builds the selected CPU, heap, goroutine, mutex, or block endpoint.
3. Click a row in Top, Flame Graph, Call Tree, or Findings to open its source.
4. Click the GoTune CodeLens or **Analyze Escapes for Hotspot** to run
   `go build -gcflags=-m=2 .` for that package.
5. In Sessions, right-click a profile and choose **Set as Baseline**.
6. Import or fetch another profile, then choose **Compare with Baseline**.

Sessions and the selected baseline are retained per workspace. Persisted
sessions are capped and compacted to keep VS Code workspace storage bounded.

For a non-default Go installation, set:

```json
{
  "gotune.goExecutable": "/Users/wnz/go/go1.19.2/bin/go"
}
```

Program arguments, environment, and build flags can also be configured:

```json
{
  "gotune.runArguments": ["-config", "dev.json"],
  "gotune.runEnvironment": {
    "APP_ENV": "development"
  },
  "gotune.runBuildFlags": []
}
```

Set `gotune.enableContentionProfiles` to `true` before starting a target when
capturing Mutex or Block profiles. These runtime sampling modes add overhead
and are therefore disabled by default.

The same setting is available as **Contention profiling** in the Running view.
Clicking it writes the value to VS Code User Settings. If a target is already
running, restart it before capturing Mutex or Block profiles.

## Goroutine Inspector

**Inspect Goroutines** captures the detailed `debug=2` dump and groups
goroutines by runtime state and normalized call stack. GoTune-owned profiler
goroutines are excluded.

- `IO wait`, `running`, and `runnable` start as normal.
- Channel, semaphore, mutex, select, condition, and WaitGroup stacks start as
  Watch.
- Capture again while the operation should be progressing. Repeated unchanged
  blocking groups are promoted to Suspicious.
- Expand a group to inspect the complete representative stack or jump to its
  source.

The assessment is evidence for investigation, not proof of deadlock. Long-lived
server goroutines may legitimately keep the same blocked stack.

GoTune only shows escape diagnostics related to the selected hotspot file.
Profile sessions are intentionally in-memory in version 0.1.

## Current scope

- CPU, heap, allocation, goroutine, block, and mutex protobuf profiles
- Heap metric selection: `inuse_space`, `inuse_objects`, `alloc_space`, and
  `alloc_objects`
- Gzip-compressed and uncompressed pprof files
- Direct HTTP/HTTPS profile URLs
- Top search, zoomable Flame Graph, Call Tree, Source view, source navigation,
  visible line heat, and CodeLens
- Function-scoped escape diagnostics
- Runtime-frame filtering in Findings, Top, Source, and Profile Diff
- Baseline/current profile comparison with regression and improvement filtering
- Workspace session and baseline persistence
- Automatic `main` package discovery and Overlay-based Run with Profiler
- Protected random localhost pprof server and one-click profile capture
- Guided CPU capture with workload timing prompts
- Three-snapshot GC-backed memory trend detection with persistent-growth
  source links
- Automatic profile and profile-diff conclusions linked to source
- Live runtime overview for heap, allocations, goroutines, and GC
- Automatic three-sample goroutine growth and stable-blocking checks
- Execution trace capture opened with the matching `go tool trace`

Benchmark comparison and struct layout are planned for later versions.
