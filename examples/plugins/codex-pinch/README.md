# codex + pinch — a plugin bundle

A **plugin bundle**: harness- and benchmark-specific definitions as pure data, installed through the generalized
`POST /plugins/install` surface. **Zero core/package changes** — this is the "specifics live in a plugin, not
core" principle (see `docs/architecture/plugin-bundles.md`).

## What's inside `bundle.json`

| Section | What | Note |
|---|---|---|
| `harnessTemplates` + `harnesses` | **codex** as a declarative `command` harness (`codex exec … {{task}} {{model}}`) | tailor the `command`/`setup`/`model` to your installed codex CLI |
| `benchmarkRecipes` | **pinch** adapter — jsonl source → repo+tests cases (template for importing pinch variants) | swap `source` (jsonl/huggingface) + `mapping` field names |
| `datasets` | **pinch-building-dashboards** — the real PinchBench building-dashboards case (`env: prompt`, `judge` rubric) | the same benchmark the hermes scripts use; scored by an LLM judge |

## Install (tenant self-serve)

```bash
curl -sX POST "$ASSAY_API/plugins/install" \
  -H "authorization: Bearer $ASSAY_KEY" -H 'content-type: application/json' \
  --data @examples/plugins/codex-pinch/bundle.json
# → { "id": "codex-pinch", "version": "1.0.0", "results": [ { "kind": "harness", "status": "ok" }, ... ] }
```

Or via MCP: `install_plugin { bundle: "<contents of bundle.json>" }`.

Install is **idempotent** (re-installing identical content is a no-op; conflicting content on an existing
`(id,version)` returns `status:"conflict"` for that item without aborting the batch). AuthZ is composed from the
bundle's contents (this bundle needs `harnesses:register` + `datasets:write` → **member+**).

## Run it → dashboard

1. Register your execution runtime if needed (`POST /runtimes`) or use the shared `docker` runtime.
2. Run pinch on codex (the `judge` grader needs a judge model — pass one or set a workspace default):
   ```bash
   curl -sX POST "$ASSAY_API/scorecards" -H "authorization: Bearer $ASSAY_KEY" \
     -H 'content-type: application/json' \
     -d '{"dataset":{"id":"pinch-building-dashboards"},"harness":{"id":"codex"},"runtime":"docker",
          "judge":{"provider":"openai","model":"gpt-5.4-mini"}}'
   ```
3. See it on the **leaderboard**: `GET /scorecards/leaderboard?dataset=pinch-building-dashboards&metric=judge` →
   a `codex × <model>` row. The model axis is captured from the run (declared `spec.model`, or observed from the
   trace if codex emits one). Compare against other harnesses (e.g. hermes) on the same benchmark, or track over time.

## Adapting to real pinch

- **Real source**: change `benchmarkRecipes[0].source` to `{ "kind": "huggingface", "dataset": "<org>/pinch" }`
  or keep `jsonl` and upload rows via `POST /benchmarks/import` (`text` = your jsonl).
- **Field mapping**: set `mapping` field names to pinch's columns (task prompt, repo/ref, test command, …).
- **Custom scoring**: beyond `tests-pass`/`answer-match`, use the `command` grader (run any scorer → regex pass)
  or a registered **judge** (LLM/VLM) — all declarative, no code.
- **codex CLI**: adjust `command`/`setup`/`model` to match the codex version you install; if codex emits OTel,
  set `trace: { "kind": "otel", "endpoint": "…" }` to capture per-call model/cost.
