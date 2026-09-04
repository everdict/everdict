# Agent telemetry — collecting what the harness cannot see by reading files

Most of this harness's indicators are answerable from the repository: git history, the ledgers, the eval
suite's own record. Three are not, because they are facts about a **session** rather than about a tree —
how many ran at once, how much of one was steering rather than waiting, and which tool decisions were denied.
The agent emits those as OpenTelemetry or not at all.

`pnpm telemetry` starts a dependency-free OTLP/HTTP receiver on `127.0.0.1:4318` that appends every payload
it gets to `.git/everdict-telemetry.jsonl`.

## The recipe

Start the sink in one terminal, then run sessions with the export enabled:

```sh
pnpm telemetry
```

```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_LOG_TOOL_DETAILS=1        # tool names and skill names on the decision events
export OTEL_METRIC_EXPORT_INTERVAL=10000
```

`http/json` is deliberate — the sink decodes JSON and holds no dependencies, which is the trade that lets
collecting start today instead of after someone stands up a collector.

Deliberately **not** set: `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_RAW_API_BODIES`.
This is a public repository and the sink writes to a plain file; the indicators below need none of that
content, and turning it on would put conversation text on disk for a measurement that does not use it.

## What each indicator reads

| Indicator | Signal |
|---|---|
| concurrent sessions per engineer | `claude_code.session.count` with `OTEL_METRICS_INCLUDE_SESSION_ID=true` (the default) |
| steering vs waiting | `claude_code.active_time.total` against wall clock |
| tool decisions allowed / denied | the `claude_code.tool_decision` event, and the `claude_code.code_edit_tool.decision` metric |
| cost and tokens per session | `claude_code.cost.usage`, `claude_code.token.usage` |
| commits per session | `claude_code.commit.count` |

The push gate's own allow/deny decisions are **not** here. They are recorded by the gate itself in
`.git/everdict-gate-log.jsonl`, because a control's refusals are evidence about that control and belong with
it rather than in a stream that only exists while a sink happens to be listening.

## What this does not do

- **Nothing is collected while the sink is not running, and the exporting session is not told.** That is a
  property of the exporter, not a bug here; the sink refuses a busy port rather than appearing to start,
  which is the one failure it can make visible.
- It is local (`.git/`), not shared. It describes this checkout's sessions.
- `http/protobuf` and gRPC are not accepted. Both would need a dependency.

## No longer owed

The debt this section used to name — *nothing forces the recipe on, and a session run without it is invisible*
— is paid. `.claude/settings.json` sets the block above for every session in this repository.

The decision rested on a measurement rather than a hope: a session with the full recipe and **nothing** on the
port produced 157 bytes of stderr, all of it an unrelated stdin warning. Exports are dropped silently when the
sink is down, which is the property that made turning it on safe. Start `pnpm telemetry` when you want them
kept; the recipe above is still what to export by hand for a CLI run outside this repository's settings.
