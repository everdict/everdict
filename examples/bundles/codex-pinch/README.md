# codex + pinch — a bundle (self-hosted)

A **bundle**: harness- and benchmark-specific definitions as pure data, applied through the generalized
`POST /bundles/apply` surface. **Zero core/package changes** — the "specifics live in a bundle, not core"
principle (see `docs/architecture/bundles.md`). Verified end-to-end: **codex runs pinch on a self-hosted runner
(the machine's ChatGPT login pays; workspace budget untouched) → objective grade → leaderboard.**

## What's inside `bundle.json`

| Section | What | Note |
|---|---|---|
| `harnessTemplates` + `harnesses` | **codex** as a declarative `command` harness: `codex exec --sandbox workspace-write --skip-git-repo-check {{task}} < /dev/null` | `setup: []` (codex is pre-installed on the self-hosted runner); `< /dev/null` gives codex an immediate stdin EOF so it doesn't wait for input when run non-interactively (the harness runs it via a pipe, not a TTY); `model: gpt-5-codex` is the declared leaderboard model axis; `trace: none` → outcome-graded |
| `datasets` → **pinch-dashboards** | PinchBench building-dashboards, **coding-agent variant** (`env: repo`): codex writes `dashboard.json`, graded **deterministically** (`tests-pass`: valid JSON + p95/p99/error/volume panels) | no judge model / provider key needed — runs entirely on the runner's codex login |
| `datasets` → **pinch-building-dashboards** | the original (`env: prompt`, `judge` rubric) — the same benchmark the hermes scripts use | needs a judge model; for comparing codex vs hermes on the LLM-judged form |
| `benchmarkRecipes` → **pinch** | jsonl→repo+tests adapter (template for importing pinch variants) | swap `source`/`mapping` for real pinch data |

## Run codex on a self-hosted runner (verified)

One command drives the whole flow (dev control plane + pair + apply + run + leaderboard):

```bash
node scripts/live/codex-pinch-selfhosted.mjs
# ① dev control plane  ② POST /runners (pair this machine)  ③ assay runner --pair (codex on PATH)
# ④ POST /bundles/apply  ⑤ POST /scorecards {dataset: pinch-dashboards, harness: codex, runtime: self:<id>}
# ⑥ → provenance.ranOn=self-hosted · tests_pass PASS · leaderboard: #1 codex@1.0.0 × gpt-5-codex (score=1)
```

Manually, the self-hosted pieces:

1. **Pair the machine** → `POST /runners {label, capabilities:["repo"]}` → `{runner:{id}, token: rnr_…}`.
2. **Start the runner** (codex must be on `PATH`; it uses the machine's `codex login`):
   `node apps/cli/dist/main.js runner --pair <rnr_…> --api-url <cp>`.
3. **Apply the bundle**: `POST /bundles/apply --data @bundle.json` (or MCP `apply_bundle`).
4. **Run**: `POST /scorecards {dataset:{id:"pinch-dashboards"}, harness:{id:"codex"}, runtime:"self:<runnerId>"}`.
   The job parks in the runner's lease queue; the runner runs `codex exec` locally (LocalDriver), writes
   `dashboard.json`, the `tests-pass` grader validates it, and the result comes back tagged
   `provenance.ranOn="self-hosted"` — **workspace budget is not drawn** (own login pays).
5. **Leaderboard**: `GET /scorecards/leaderboard?dataset=pinch-dashboards&metric=tests_pass` →
   `codex × gpt-5-codex`. Compare against other harnesses/models, or track over time.

> Long codex runs (minutes) stay alive: the runner heartbeats every 30s and the control-plane lease hub treats
> `queueTimeoutMs` as an **inactivity** timeout (reset by lease/heartbeat), so only an idle/dead runner times out.

## Adapting to real pinch

- **Judged form**: run `pinch-building-dashboards` on codex with a judge (`judge:{provider,model}`) and compare
  vs hermes on the same dataset (`GET /scorecards/leaderboard?dataset=pinch-building-dashboards&metric=judge`).
- **Real source/scoring**: change `benchmarkRecipes[0].source`/`mapping` for real pinch columns; beyond
  `tests-pass`, use the `command` grader (any scorer → exit code) or a registered judge — all declarative.
- **Trace/model**: if codex emits OTel, set `trace:{kind:"otel",endpoint:"…"}` to capture per-call model/cost
  (then the leaderboard model axis is *observed*, not just declared).
