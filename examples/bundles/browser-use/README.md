# browser-use bundle — web-browsing agent + two open web benchmarks

Everything a [browser-use](https://github.com/browser-use/browser-use) developer needs to evaluate
their agent on Everdict, as **pure data** (no core changes): a command-harness template + instance,
and two open live-web benchmarks (WebVoyager 2025 / Online-Mind2Web) as reusable recipes.

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
- `bundle.json` — harness template/instance + the two benchmark recipes.
