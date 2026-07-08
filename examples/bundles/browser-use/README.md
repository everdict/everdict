# browser-use bundle — web-browsing agent + three open web benchmarks

Everything a [browser-use](https://github.com/browser-use/browser-use) developer needs to evaluate
their agent on Everdict, as **pure data** (no core changes): a command-harness template + instance,
and three open live-web benchmarks (WebVoyager 2025 / Online-Mind2Web / **BU Bench V1 open
reconstruction**) as reusable recipes. These are the three benchmark sets browser-use actually
implements + reports scores on (WebVoyager 89.1% via `browser-use/eval`; Online-Mind2Web 97% via
`browser-use/online-mind2web`; BU Bench V1 via `browser-use/benchmark`).

## The three benchmarks (and one caveat)

| Recipe | Upstream | Tasks | Runnable here |
|---|---|---|---|
| `webvoyager-2025` | WebVoyager 2025 revalidated (`convergence-ai/WebVoyager2025Valid`) | ~600 live-web | ✅ full set (HF) |
| `online-mind2web` | Online-Mind2Web / OSU-NLP (`XueyingJia/online-mind2web-sorted`) | 300 live-web / 136 sites | ✅ full set (HF) |
| `bu-bench-v1-open` | BU Bench V1 (`browser-use/benchmark`) | 100 = 20 Custom + 20 WebBench + 20 Mind2Web-2 + 20 GAIA + 20 BrowseComp | ⚠️ **open reconstruction only** |

> **Why BU Bench V1 is a reconstruction:** browser-use ships the official 100 hand-picked tasks
> **encrypted** (`BU_Bench_V1.enc`, decrypted in-memory at run time), and two of its components
> (GAIA is gated, BrowseComp answers are encrypted) are not freely distributable. So `bu-bench-v1-open`
> is an **open, browseable stand-in** (`bu_bench_v1_open.jsonl`): representative tasks in the style of
> each of the five source components, on bot-friendly info-seeking sites, each tagged with its
> `source` component. It is not the official set and its scores are not comparable to browser-use's
> published BU Bench numbers — it exists so the composite is *runnable* end-to-end.

## How it models browser-use

browser-use is a Python library that drives **its own** headless Chromium in-process — there is no
server to deploy and no browser for Everdict to provision. That maps to a **command harness** on a
**prompt env**: `run_bu.py` runs one `Agent(task).run()` against an OpenAI-compatible endpoint and
prints a `BROWSER_USE_RESULT` block (final_result / steps / self_reported_success) to stdout; with
`trace: none` the stdout tail becomes the final assistant message, which the judge grader scores
against each benchmark's rubric (WebVoyager-style answer judging).

If you want Everdict-observed browser state instead (DOM/screenshot outcome grading), that is the
service-topology path (`docs/service-harness.md`, harness `bu`) — heavier: serve browser-use behind
a front door and let the topology runtime provision the target browser.

## Install

```bash
# 1) Build the BYO image on the machine that runs your self-hosted runner
docker build -t browseruse-eval:0.13.3 .

# 2) Set your model-endpoint key (personal secret; the template references it via secretRef)
#    PUT /secrets/OPENAI_API_KEY {value, scope:"user"}  (or MCP set_secret)

# 3) Install the bundle (harness template + instance + benchmark recipes)
#    POST /bundles/apply with bundle.json  (or MCP apply_bundle)

# 4) Import the benchmarks from the recipes (full datasets)
#    POST /benchmarks/import {recipe:{id:"webvoyager-2025"}}  → dataset webvoyager-2025
#    POST /benchmarks/import {recipe:{id:"online-mind2web"}}  → dataset online-mind2web
#    POST /benchmarks/import {recipe:{id:"bu-bench-v1-open"}, text:@bu_bench_v1_open.jsonl} → dataset bu-bench-v1-open
#      (jsonl source → pass the shipped bu_bench_v1_open.jsonl as opts.text)

# 5) Run a scorecard on your machine (self-hosted runner with docker capability)
#    POST /scorecards {dataset, harness:{id:"browser-use"}, runtime:"self:<runner>",
#                      judge:{model:"gpt-5.4-mini"}, cases:{limit:10}}
```

## Knobs

- `pins.model` / template `env.OPENAI_API_BASE` — any OpenAI-compatible endpoint (LiteLLM proxy,
  OpenAI, vLLM). The default `172.17.0.1:4000/v1` reaches a host-local LiteLLM from inside the
  job container (docker bridge gateway).
- `overrides.params.max_steps` — agent step budget per case (default 15).
- `env.BU_USE_VISION` — `"true"` sends screenshots to the model (needs a vision-capable model).
- The judge model is per-request (`judge {model}`) or the workspace default (settings.judge); on a
  self-hosted runner the judge key/baseURL come from the runner process env
  (`OPENAI_API_KEY` / `OPENAI_BASE_URL`).

## Files

- `Dockerfile` — python:3.12-slim + browser-use (pinned) + playwright's docker-hardened Chromium
  (Debian's chromium SIGTRAPs headless in slim containers; playwright is used only for its browser).
- `run_bu.py` — the eval entrypoint (version-defensive against browser-use API drift).
- `bundle.json` — harness template/instance + the three benchmark recipes.
- `bu_bench_v1_open.jsonl` — the open reconstruction of BU Bench V1 (10 tasks, tagged by source
  component); passed as `opts.text` when importing the `bu-bench-v1-open` recipe.
