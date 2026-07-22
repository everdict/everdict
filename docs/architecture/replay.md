# Replay — record a run so the analysis phase can re-watch it

> **Status: doc-first SSOT.** The durable successor to
> [live-observability](./live-observability.md) (watch a run *while* it runs — ephemeral). Replay =
> the **recorded live run**: the same two streams (screen frames + log lines) live-observability
> already produces, teed into time-indexed durable storage and aligned to the trace timeline, so an
> analyst can re-watch a case long after it settled. Related: [run-as-primitive](./run-as-primitive.md)
> (the run is the addressable unit replay attaches to), [streaming-case-pipeline](./streaming-case-pipeline.md)
> (the 2-phase collect shape this mirrors), [judge-input-contract](./judge-input-contract.md) (evidence
> channels a replay can also feed).

## Problem — what survives a run today, and what doesn't

Evaluating a harness over a dataset produces a verdict, but an analyst routinely needs to answer *how*
the agent got there: what it decided, how it acted on the environment, and — the part the agent's own
trace can't see — **how the environment changed underneath it**. Today the system is optimized for the
verdict (final trace + final snapshot), not for reconstructing the execution.

**Persisted on `CaseResult` (survives the run):**
- `trace: TraceEvent[]` — the agent-decision timeline, 9 kinds (`message`/`llm_call`/`tool_call`/
  `tool_result`/`env_action`/`error`/`log`/`artifact`/`span`), each with a `t` (`contracts/src/execution/trace.ts:13`).
- `snapshot: EnvSnapshot` — a **single final state**: repo `diff`/`changedFiles`/`headSha`, browser
  `dom`+`screenshot`+`url`, os-use `screenshot`+`windows` (`contracts/src/execution/environment.ts:5`).
- `evidence?` — slots extracted from a pulled platform trace (`finalAnswer`/`dom`/`screenshot`/`custom`).

**Ephemeral — dies with the run (live-observability only):**
- `LiveFrameStore` — the **latest frame only**, 30 s TTL, in-memory single-node (`apps/api/src/common/live-frame-store.ts`).
- `LiveLogStore` — a 1,000-line ring, 15 min TTL, in-memory (`apps/api/src/common/live-log-store.ts`).
- The web live view polls `/runs/:id/screen` (2 s) and `/runs/:id/logs` (3 s / SSE) — a viewer, not a recorder.

**The five gaps that block replay:**
1. **No frame history.** The screen capture loop keeps only the newest frame (overwrite-only); the
   time series is never accumulated.
2. **No intermediate environment state.** The snapshot is captured once, at case end
   (`application-execution/src/run-case.ts:154`). "The DOM right after step 3" requires a re-run.
3. **Claude Code trace `t` is a synthetic counter** (`harnesses/src/stream-json.ts` `nextT = () => t++`),
   not wall-clock — it can't align to frames, and it silently breaks the `latency` trace-grader
   (`graders/src/trace-graders.ts`, `trace[last].t - trace[0].t` ≈ event count for Claude Code).
4. **No console/network capture** (`BrowserSnapshot.console` is a constant `[]`).
5. **Live streams don't survive the run.** The infrastructure to *see* a run exists; nothing records it.

## Reproducibility — two complementary axes

A stochastic LLM agent can't be re-executed bit-for-bit, so "reproducibility" splits:

- **Re-runnability** — *already strong.* Immutable versioned registry (harness/dataset/judge/runtime/model),
  `origin.pinOverrides`, image pins, model bindings, `rerun_scorecard`. "Run the same pinned spec again" works.
- **Audit reproducibility** — *the gap this closes.* When re-execution can't reproduce a result, the
  **recording is the ground truth** for what actually happened. Recording is not a nicety layered on top
  of reproducibility; for non-deterministic agents it *is* the reproducibility artifact. A recording
  therefore seals a **dispatch manifest** (the fully-resolved spec/model/seed/env actually dispatched —
  extending today's `origin`/`provenance`) so a run is self-describing.

## Principles

1. **Replay is the recorded live run.** Reuse the live-observability streams and rendering; the only
   difference is the data source (durable recording vs live poll). No parallel capture path.
2. **Three recording planes on one clock.** Tracking is *not* only agent-level. Every recording spans
   three planes — **agent** (decisions/tool calls), **environment** (the world it acts on: for a web
   target, DOM mutations + navigation + network + console, not merely screenshots), and **runtime/system**
   (the sandbox itself: resource usage, process/filesystem events). All tracks share one wall-clock
   timeline; the playhead crosses every plane.
3. **Instrument the environment and runtime independently of the agent.** What the agent can't perceive —
   how the DOM mutated, which requests fired, whether it OOM'd — is captured at its own layer (CDP for a
   browser, the orchestrator for the runtime), never inferred from the trace.
4. **Compute is scarce; heavy bytes never ride inline.** Frames stream out during the run through the
   existing push channel and offload to object storage (the `offloadSnapshot`/`ArtifactStore` path);
   `CaseResult` carries only a `recordingRef`, mirroring `traceRef`.
5. **Cost-bounded by default.** Trace + final snapshot are **always** recorded (as today). The frame time
   series is **opt-in**, consecutive-frame **deduped** (by hash), and under a **short default retention**.
6. **No semantic drift.** Per-case score order, judge/supersede semantics, and the stored ref-only snapshot
   are unchanged. The one deliberate change (wall-clock trace timestamps) is a bugfix, shipped with a
   regression that proves the pre-fix `t` was meaningless.
7. **Environment-agnostic by construction.** The framework knows *tracks*, not environment *kinds*. Web is
   not a special case with repo/OS bolted on — each kind (web / repo / OS-use / future) binds a **recorder
   adapter** behind one seam, and the manifest, store, and player never mention a kind. New environments
   plug in without touching the framework — the same pluggable-adapter inversion Everdict uses for
   Harness / Driver / Grader / Backend.

## Recording planes & the fidelity ladder

Tracking spans three planes; each has a **fidelity ladder** so cost scales with intent, not a single
on/off. This is the "more than agent-level trace" the design is about.

**① Agent plane** — the decision timeline (`TraceEvent[]`). Already captured; D1 gives it a real clock.

**② Environment plane** — the world the agent acts on, captured at the environment's *own* layer:
- **browser (web) — the advanced case.** Beyond periodic screenshots, drive CDP as an **event source** so
  the recording answers "how did the page change", not just "what did it look like":
  - *frames* — `Page.startScreencast` → `screencastFrame` (native-cadence, emitted on change) instead of a
    fixed 2 s poll.
  - *DOM mutations* — an injected in-page recorder (rrweb-style, **reinterpreted** per our idiom, not
    vendored blindly: initial full serialize + `MutationObserver` deltas + input/scroll/focus) yielding a
    **semantic, seekable, pixel-reconstructable** DOM replay — a diffable event log, not a movie. Injected
    via `Page.addScriptToEvaluateOnNewDocument` on provisioned CDP targets.
  - *network* — `Network.requestWillBeSent`/`responseReceived`/`loadingFinished` → a request track
    (method/url/status/timing; bodies opt-in).
  - *console* — `Runtime.consoleAPICalled` → the console track (finally drops the constant `[]`).
  - *navigation* — `Page.frameNavigated`/`navigatedWithinDocument` → URL history.
  When the target is harness-provided (a service's own session, no injection foothold), fall back to the
  injection-free CDP domains (screencast/network/console) or plain frames.
- **os-use (desktop)** — no `screencast` analog; the screen-frame series (scrot / Xvfb capture) is the
  track, window-title deltas alongside.
- **repo** — the filesystem *is* the world: `git diff` checkpoints on write-boundaries (a series of diffs),
  not one final diff (`environments/src/repo.ts:57`).

**③ Runtime/system plane** — the sandbox itself (extends [runtime-inspection](./runtime-inspection.md)):
resource usage (CPU / memory / network I/O) sampled over time from the orchestrator (Nomad alloc stats /
K8s metrics / `docker stats`), plus container lifecycle and coarse process/filesystem events. This is the
only plane that answers "did it OOM / thrash / hang" — invisible to both the agent trace and the
environment DOM.

**Fidelity ladder (per plane, opt-in):**
`off` → `final` (today's end snapshot) → `frames` (screenshot series) → `semantic` (web: rrweb/CDP
DOM + network + console) → `full` (+ runtime stats + request bodies). **Default = agent plane always +
`final`; every rung above is the `record` knob** (D3), so a routine batch stays cheap and a flagged
investigation records deeply.

## Extensibility — one recorder seam, many environment kinds

The environment is already a pluggable axis: `EnvSnapshot` is a discriminated union
(`repo | browser | os-use | prompt`, `contracts/src/execution/environment.ts`) and more kinds are expected
(a mobile target, an API/service target, a terminal, a notebook). So the environment-plane recorder is an
**adapter per kind behind one interface** — the deliberate-interface idiom, a sibling of
`Environment.snapshot()`:

```ts
type Fidelity = "off" | "final" | "frames" | "semantic" | "full";

interface EnvironmentRecorder {
  capabilities(): { maxFidelity: Fidelity; tracks: string[] };  // what this kind can actually record
  start(sink: RecordingSink, level: Fidelity): Promise<void>;   // begin streaming its tracks
  checkpoint(reason: string): Promise<void>;                    // a keyframe (e.g. on a tool_call boundary)
  stop(): Promise<void>;                                        // flush; the final snapshot stays the last keyframe
}
interface RecordingSink { emit(item: TrackEntry): void; }        // injected — appends to the RecordingStore (D4)
```

**One impl per kind (browser is the richest, not the only one):**
- **browser** → CDP recorder (screencast + rrweb DOM + network + console + nav). Up to `semantic`. (D5)
- **repo** → git recorder (`git diff` checkpoints as `stateDeltas`; optional filesystem-event track). No frames.
- **os-use** → X11/scrot recorder (frame series + window-title deltas). `frames`, not `semantic`.
- **prompt** → `NullRecorder` (nothing beyond the trace).
- **future kinds** plug in here alone — the manifest / `RecordingStore` / player stay untouched.

**Capability negotiation, never silent truncation.** The requested `record.env` rung is **clamped** to
`capabilities().maxFidelity`, and the manifest records the *effective* rung per track, so a `semantic`
request on an os-use case visibly degrades to `frames` rather than pretending it captured DOM (the
"no silent caps" rule).

**Open track vocabulary.** The known lanes cover today's kinds; a novel kind with a novel track (mobile
touch events, an API-call log) emits a **`custom` lane** (`{track:"custom", name, entry}`) with no contract
change. The player renders known lanes specially and unknown lanes generically (label + scrub) — the same
open-slot discipline as judge evidence custom slots.

## Design

### D1 — wall-clock trace timestamps (the alignment prerequisite)

Harness adapters stamp real time at **emit**, not a counter. `mapClaudeStreamJson` reads each `stream-json`
line as it streams, so `Date.now()` at read is the true event time; inject a clock (`() => number`) so the
mapper stays testable. `CommandHarness` (trace:none) already stamps real time. run-case is in-sandbox — the
Temporal determinism ban applies only to `orchestrator` workflow code, so `Date.now()` here is legal.
Secondary win: the `latency` trace-grader becomes meaningful for Claude Code. **Caveat:** this changes that
grader's output — ship it as a fix with a regression that captures the pre-fix (≈ event-count) value, and
treat it as a grader-semantics change in the changelog.

### D2 — the recording contract (`contracts`)

A recording is a **manifest** (small — lists of `{t, ref}`) plus offloaded byte blobs. Mirror `TraceRef`:

```ts
// A per-run recording manifest (stored in object storage; referenced from the record).
type CaseRecording = {
  runId: string;                 // the CP-minted, record-derivable key (see D3)
  t0: number;                    // wall-clock anchor (ms) — trace.t and track.t share this clock
  tracks: {
    // ② environment plane
    frames?: FrameEntry[];       // screen frames over time (screencast or scrot)
    domEvents?: DomEvent[];       // web: rrweb-style mutation/input stream (semantic replay)
    network?: NetEntry[];        // web: request track
    console?: ConsoleEntry[];    // web: console messages over time
    nav?: NavEntry[];            // web: navigation history
    stateDeltas?: DeltaEntry[];  // checkpointed env state (DOM / repo diff / windows)
    // ② logs + ③ runtime plane
    logs?: LogEntry[];           // environment/job log lines over time
    runtime?: RuntimeSample[];   // CPU/mem/net I/O + lifecycle over time
    // open vocabulary — a future env kind's novel track (mobile touch, API-call log, …)
    custom?: CustomEntry[];
  };
  envKind: string;               // which recorder adapter produced the env tracks
  effectiveFidelity: Fidelity;   // what was ACTUALLY captured (clamped to capabilities), not what was asked
  dispatch: DispatchManifest;    // resolved spec/model/seed/env actually dispatched (audit)
};
type FrameEntry     = { t: number; ref: string; hash?: string };        // ref = object-store PNG URL
type DomEvent       = { t: number; ref: string };                       // offloaded rrweb event batch
type NetEntry       = { t: number; method: string; url: string; status?: number; ms?: number; bodyRef?: string };
type ConsoleEntry   = { t: number; level: string; text: string };
type NavEntry       = { t: number; url: string };
type DeltaEntry     = { t: number; kind: "dom" | "repo-diff" | "os-windows"; ref: string };
type LogEntry       = { t: number; stream: "stdout" | "stderr"; text: string };
type RuntimeSample  = { t: number; cpuPct?: number; memBytes?: number; rxBytes?: number; txBytes?: number; event?: string };
type CustomEntry    = { t: number; name: string; ref?: string; text?: string };  // open-vocabulary lane

// Rides on CaseResult / RunRecord, sibling of traceRef — coordinates, never bytes.
type RecordingRef = { ref: string };  // object-store pointer to the CaseRecording manifest
```

`CaseResult` (`contracts/src/execution/eval-case.ts:84`) gains `recordingRef?: RecordingRef`. The trace
stays the agent track — it is **not** duplicated into the manifest; the player reads `result.trace`
(or the pulled trace) and the manifest side-by-side on the shared `t0` clock. Zod schema + `core-contracts`
skill update in the same PR.

### D3 — recording pipeline (reuse the live push channel; 2-phase, mirrors `traceRef`)

The frame producer already exists: the `startLiveScreenCapture` loop (`run-case.ts:72`, overlap-guarded,
default 2 s). Today its `report` callback pushes the latest frame to the ephemeral store. The change:
**tee the same stream into a durable recorder**, and stamp the capture `t`.

- **Ingestion point = the existing MCP tools.** `report_case_screen` / `report_case_log`
  (`apps/api/src/api/runner/runner-lease.mcp.ts:116`) already carry the frames/lines to the control plane.
  Their handlers append to a new `RecordingStore` **in addition to** `LiveFrameStore`/`LiveLogStore` — the
  live view keeps its 30 s / 15 min ephemeral fast-path; the recorder accumulates the full series and
  offloads each frame to `ArtifactStore` (consecutive-identical frames deduped by hash → one ref reused).
- **Keying.** The recorder keys by the CP-minted, **record-derivable** runId
  (`evd-run-<id>` / `evd-<scorecardId>-<caseId>[-t<n>]`, live-observability ③) — zero lookups, stable
  across transient retries.
- **2-phase, like trace collection (streaming-case-pipeline D4).** Phase 1: frames/logs stream during the
  run (durable append + live view at once). Phase 2: at finalize, `seal(runId)` writes the manifest and
  returns a `RecordingRef` attached to the record — the same shape as `collectTrace` → `traceRef`.
- **Opt-in + retention (per-plane fidelity).** A `record?` knob on the harness spec / scorecard submit
  selects a rung per plane:
  `{ env?: "off"|"final"|"frames"|"semantic"|"full"; runtime?: "off"|"stats"|"full"; cadenceMs?; retentionDays? }`.
  Absent = today (final snapshot only, no series). Byte-heavy tracks (frames, DOM batches, bodies) TTL on
  the object store (default short, e.g. 14 days); the manifest is cheap and kept with the record.

### D4 — the `RecordingStore` port (`application-control`) + storage

A port beside `RunStore`/`ScorecardStore`, so the concern is pluggable and the DB stays light:

```ts
type TrackEntry =        // any plane's timestamped entry, tagged by track
  | { track: "frames"; entry: FrameEntry }
  | { track: "domEvents"; entry: DomEvent }
  | { track: "network"; entry: NetEntry }
  | { track: "console"; entry: ConsoleEntry }
  | { track: "nav"; entry: NavEntry }
  | { track: "stateDeltas"; entry: DeltaEntry }
  | { track: "logs"; entry: LogEntry }
  | { track: "runtime"; entry: RuntimeSample }
  | { track: "custom"; entry: CustomEntry };

interface RecordingStore {
  append(runId: string, item: TrackEntry): Promise<void>;
  seal(runId: string, dispatch: DispatchManifest): Promise<RecordingRef>;  // freeze → manifest in object storage
  get(runId: string): Promise<CaseRecording | undefined>;
}
```

`InMemoryRecordingStore` (dev/test) + `PgRecordingStore` (append rows keyed by runId, manifest sealed to
`ArtifactStore` — the same S3/MinIO path `offloadSnapshot` uses). `list` never hydrates the tracks (same
discipline as `ScorecardStore.list` omitting heavy per-case results). Numbered migration + idempotent
`migrate`/`preflight`, per the `db` conventions.

### D5 — the browser recorder adapter (reference impl of the recorder seam)

The Extensibility section defines the `EnvironmentRecorder` interface; the **browser** adapter is its
richest impl and the one that motivates the deep-capture design (`repo`/`os-use`/`prompt` are siblings
behind the same seam). It attaches to the **CDP connection** the runtime already holds
(`topology/src/front-door/capture-cdp.ts`, `captureCdpDom`/`captureCdpScreenshot`) — no new transport:
- **At provision** (`provisionBrowserEnv` / `TargetAcquirer`), enable `Page`/`Network`/`Runtime`/`DOM`
  domains, `Page.startScreencast`, and `Page.addScriptToEvaluateOnNewDocument` (inject the rrweb-style
  recorder). CDP events (`screencastFrame`, `requestWillBeSent`, `consoleAPICalled`, `frameNavigated`) and
  the injected DOM-event batches stream to the recorder for the case's life — the **environment plane runs
  in parallel with the agent**, not on its boundaries.
- **Semantic vs frames.** `semantic` fidelity records DOM events + network + console (small, seekable,
  diffable); `frames` records the screencast (heavier, universal). The final `snapshot` is unchanged —
  it stays the terminal keyframe.
- **The sibling adapters** (Extensibility) have no CDP and record at their own ceiling: the **repo**
  recorder emits `git diff` checkpoints on write-boundaries (reuse `git diff --cached`,
  `environments/src/repo.ts:57`), the **os-use** recorder emits the periodic scrot series + window deltas.
  Same seam, different `capabilities()`.

All byte-heavy events offload to `ArtifactStore` and record a `{t, …, ref}` entry; gated by the `record`
`env` rung (clamped to the adapter's `capabilities()`) so the default stays cheap.

### D5b — runtime/system plane: track the sandbox, not just the agent

The runtime plane is captured by the **control plane / backend**, not in-sandbox (the sandbox can't
measure itself neutrally). Extend the `Backend` seam (sibling of `captureScreen`/`logs`, live-observability
④/⑤) with a periodic sampler: **`Backend.sampleRuntime(caseId)`** → `RuntimeSample` from the orchestrator
(Nomad alloc stats API / K8s metrics / `docker stats`), plus lifecycle events from the existing adopt
lookup. Samples stream into the recorder like frames. This is the natural home of
[runtime-inspection](./runtime-inspection.md) telemetry, now time-series and per-case rather than a point
probe. Gated by the `record` `runtime` rung (`stats`/`full`); `off` by default.

### D6 — the replay player (`apps/web`, reuse the live widgets)

The analysis surface (scorecard case detail / run detail) mounts a **replay player**: a scrubbable
timeline with a **lane per plane** — agent (trace events), environment (frames *or* a DOM-reconstructed
web replay, plus network/console/nav lanes), and runtime (CPU/mem sparkline). The playhead at `t`
highlights the current `tool_call`/`message` while every lane seeks with it, so an analyst sees the
decision, the page mutation it caused, the request that fired, and the memory it cost — at one instant.
For `semantic` web recordings the environment lane **reconstructs the DOM** (rrweb-style playback in an
iframe), not a video — inspectable and diffable. The decisive reuse: `live-screen.tsx` / `live-logs.tsx`
keep their rendering; **only the data source swaps** from the live poll to `GET /runs/:id/recording` (the
sealed manifest; MCP parity `get_run_recording`). The `inspect_trace` waterfall dialog (Observability)
gains the environment/runtime tracks as extra lanes. A run that is still live shows the live view; once
sealed, the same UI replays the recording — one player, two sources.

### D7 — managed-backend continuous capture (close the viewer-dependency gap)

Self-hosted runs already push frames continuously (`report_case_screen`). Managed backends (Nomad/K8s)
only capture on demand via `Backend.captureScreen` (a viewer must be watching), so a recording would have
holes. Unify by driving capture from the **in-sandbox** `LiveScreenCapture` loop for managed jobs too —
the frame producer runs regardless of a viewer, pushing through the same channel — so a recording is
complete whether or not anyone watched. (Until then, managed recordings are best-effort frame-sparse and
the manifest says so; the trace + final snapshot + deltas still make a usable replay.)

## Slices

- **S1 — wall-clock trace timestamps** (D1). Independently valuable (fixes the latency grader); the
  alignment prerequisite. Ships with the pre-fix regression.
- **S2 — contracts + seam + port** (D2, D4, Extensibility). `CaseRecording`/`RecordingRef` on the record,
  the `EnvironmentRecorder` interface + capability clamping, `RecordingStore` + `InMemoryRecordingStore` +
  a `NullRecorder` (prompt). Domain/test only, no UI, no real capture yet.
- **S3 — recording pipeline** (D3). Tee `report_case_screen`/`report_case_log` into the recorder, offload
  + dedup, `seal` at finalize, attach `recordingRef`. Self-hosted path first (its push channel exists).
- **S4 — replay player + Pg** (D6). `GET /runs/:id/recording`, the web player (live-widget reuse),
  `PgRecordingStore` + migration + object-store retention.
- **S5 — recorder adapters** (D5, D7). The **browser** adapter (CDP DOM-mutation/network/console/screencast
  + rrweb-style reconstructed web replay) plus the **repo** (git-diff checkpoints) and **os-use** (scrot)
  adapters behind the seam, and continuous managed-job capture (closes the viewer-dependency gap). The
  richest environment slice; each adapter can land independently.
- **S6 — runtime/system plane** (D5b). `Backend.sampleRuntime` time-series + the runtime lane in the
  player. The most orchestrator-specific slice, last.

S1 is the cheapest, self-contained entry point (alignment + an existing grader bug), so it leads. S2–S4
deliver a working frame-level replay; S5–S6 add the deep environment and runtime planes on top.

## Non-goals

- **Bit-exact deterministic re-execution.** Impossible for stochastic agents; recording is the audit
  substitute (see Reproducibility). Version pinning already covers re-runnability.
- **A separate recording capture path.** Replay must ride the live-observability streams; a divergent
  recorder would drift from what the live view shows.
- **Recording every run by default.** Trace + final snapshot are always kept; the frame/DOM series is
  opt-in — the storage cost scales with cases × trials × cadence and must be a deliberate choice.
- **Full request/response bodies (HAR).** The network *track* (method/url/status/timing) is in at
  `semantic` fidelity; capturing full bodies is `full`-only and off by default (size + secret-leak risk).
