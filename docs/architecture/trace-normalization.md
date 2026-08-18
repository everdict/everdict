# Getting evidence out of an agent we did not write

> Status: **analysis, no implementation.** The question this answers: Everdict can RUN an arbitrary CLI
> agent as pure data (`CommandHarnessSpec`), so why can it only produce EVIDENCE for one of them? And is
> "make normalization declarative" actually possible, or does every agent cost code?

## 1. The asymmetry, stated precisely

Registering a new agent is free — `makeHarness` (`packages/job-runner/src/registry.ts`) returns a
`CommandHarness` for any `spec.kind === "command"`, with no id branch. Thirty of Harbor's CLI agents fold
into `setup[]` + `command` + `env` with zero code.

Getting that agent's trace is not free. `CommandTraceSpec` offers six kinds:

| kind | what it requires of the agent | who can satisfy it |
| --- | --- | --- |
| `none` | nothing | everyone — and yields no evidence |
| `file` | writes **Everdict's own `TraceEvent` JSON/JSONL** into the sandbox | nobody, in practice |
| `otel` · `mlflow` · `langfuse` · `langsmith` · `phoenix` | already instrumented to that platform | an agent someone wired up |

`file` reads the path back and runs `TraceEventSchema.safeParse` per record, **dropping** what does not
parse (`readSelfReportedTrace`, `packages/harnesses/src/command.ts`). A real CLI agent writes its own
native format — Claude Code writes `--output-format stream-json`, Codex writes a rollout JSONL, the Harbor
ecosystem writes ATIF — so every record drops and the trace is empty.

The only bridge from a native format to `TraceEvent` in this repo is
`packages/harnesses/src/stream-json.ts`: **101 lines, one agent.**

Consequence, and it is the product: with no trace the `steps` / `cost` / `latency` graders and every judge
have nothing to read. `meterUsage` recovers tokens only for agents whose model base URL we can override.
**We can run thirty agents and defend the verdict of one.**

## 2. The finding that changes the plan: ATIF does not remove the code

The obvious move is "adopt ATIF" (Harbor RFC-0001, the Agent Trajectory Interchange Format). Reading
Harbor's own agents says otherwise.

Harbor declares ATIF support per agent (`SUPPORTS_ATIF`) and **still writes a converter per agent**.
`src/harbor/agents/installed/codex.py` has `_convert_events_to_trajectory` with three separate `Step(...)`
construction sites, branching on the native event type — structurally the same program as our
`mapClaudeStreamJson`. Gemini, Goose and OpenCode each carry their own.

So ATIF standardizes the **destination**, not the **derivation**. Borrowing it buys:

- ✅ every agent that has *already* paid that cost somewhere else (Harbor's ~20 ATIF agents; anything the
  ecosystem produces), and the ability to ingest a trajectory produced by a run we did not perform;
- ❌ **not** freedom from writing a converter for an agent nobody has converted.

That distinction decides the shape of the work: this is not one mechanism, it is a ladder, and the top rung
is worth far more per unit of effort than the bottom one.

## 3. The ladder

**T1 — an ATIF importer (one adapter, N agents).** `atifToTraceEvents`: `Step{tool_calls[],
observation.results[], metrics}` → our `tool_call` / `tool_result` / `llm_call` / `message`, with
`final_metrics.total_cost_usd` → the cost the budget grader reads. One piece of code serves every
ATIF-emitting agent, plus ingestion of Harbor-run trajectories as `attestation: "self_reported"` evidence.
Highest leverage; smallest surface. **Do this first.**

**T2 — a declarative record mapping (no code per agent).** For an agent that emits a JSON/JSONL event
stream that is not ATIF. Is it expressible as data? `mapClaudeStreamJson` says yes for its class — the
whole program is four moves:

1. dispatch on a discriminator path (`type`)
2. iterate a nested array and dispatch again (`message.content[].type`)
3. per branch, emit one event kind, filling fields from paths (`part.name`, `part.input`, `usage.input_tokens`)
4. join structure by id (`tool_use.id` → `spanId`; `tool_result.tool_use_id` → `parentId`)

(1)–(3) are path + dispatch. (4) is two more declared paths. We already have the precedent in the contract:
`SpanAttrMapping` (`packages/contracts/src/execution/trace-source.ts`) is exactly this idea for OTel spans —
attribute paths → `TraceEvent` fields — and it is already consumed by the `otel`/`mlflow` command-trace
kinds and by pull-ingest. T2 is that mapping generalized from "span attributes" to "records in a stream".

**T3 — a code normalizer**, for formats that are not a record stream at all (a tmux/asciinema cast, a
human-readable log). Unavoidable, and fine: it should be the rare case, not the only case.

## 4. What the borrow does NOT come with — and why it blocks

Both T1 and T2 turn "unknown records" into "records we chose not to map", and today that is invisible:

```ts
// packages/application-execution/src/run-case.ts:443
...(!defer && !collectFailure ? { traceSealed: true } : {}),
```

The seal is written whenever nothing *recorded a failure*. A normalizer that silently drops 40% of an
agent's records raises no failure, so the result would be sealed as complete evidence — precisely the
reading the seal was introduced to prevent (`CaseResult.traceSealed`: "a trace truncated without a recorded
failure is indistinguishable from a complete one unless the producer says so").

So the requirement is not optional and belongs in the first commit of this work, not a later one:

- a normalizer returns **coverage**, not just events: records seen, records mapped, records dropped **by
  reason** (unknown discriminator / failed path / schema mismatch);
- dropped records **withhold the seal** and surface as a stated gap, rather than making the trace look whole;
- coverage is provenance, so it is recorded where it is produced (L3), not re-derived from the event count
  downstream — "N events arrived" can never tell a reader whether M were thrown away.

This is the part Harbor has no equivalent of, and it is the reason to build rather than adopt: Harbor's
converters silently produce whatever they produce, because a research runner's trajectory is a convenience.
Ours is the evidence a verdict rests on.

## 5. Open questions to settle before writing T2

1. **Where does the mapping run?** In `CommandHarness` (inside the sandbox, streaming, so a live tail keeps
   working) or at the collection boundary? Streaming argues for the harness; reusability across the
   self-hosted runner and pull-ingest argues for a shared pure function called from both.
2. **How far does dispatch need to go** before a mapping language becomes a bad programming language? A
   single discriminator + one nested array level covers stream-json and ATIF. The moment it needs
   conditionals or arithmetic, T3 is the honest answer.
3. **Time.** Native records rarely carry wall-clock. Our contract already distinguishes "ordered but not
   timed" (`t` without `at`) — the mapping must be able to say "no clock" rather than inventing offsets,
   the same discipline `readSelfReportedTrace` already documents.
4. **Cost double-counting.** Claude's stream-json emits per-message `usage` AND a terminal
   `total_cost_usd`; our normalizer emits both as `llm_call` (one with `model: "aggregate"`). Whatever T2
   declares must make "this record is the aggregate, not another call" statable, or every mapped agent
   over-reports its cost.

## 6. Recommendation

Do T1 now (one adapter, immediate reach, unlocks ingesting other people's runs), pair it with the coverage
+ seal discipline of §4 — because that is the piece that makes an imported trajectory *evidence* rather
than decoration — and only then decide T2 against the open questions above. Do not start with T2: it is the
larger design and the smaller payoff, and §5.2 may well cut it down to a much narrower feature.
