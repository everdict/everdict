# browser-ext-agent — a browser agent driving an EXTENSION-loaded browser, judged, at scale

A Playwright-based browser agent (Skyvern-style) that connects over CDP to a per-case browser Everdict provisioned
**with a client extension loaded** (`target.extension.ref` → `examples/browser-extensions/hello-ext`), navigates to a
web page, reads it, and answers via an LLM. An LLM judge scores the answer → a quality Scorecard. The same task is
then run in **parallel** to determine how many concurrent cases fit.

- `agent/` — FastAPI + Playwright `connect_over_cdp`. `POST /runs {task, browser_cdp_url}` drives the given
  (extension-loaded) browser to the task URL, reads the page, and answers with the LLM. It also reports whether the
  client extension's content script ran on the page (`extension_active`).
- `web/`   — an nginx test page with a known fact (the secret number 4242) for the agent to read.

## Run (live)

```bash
docker build -t everdict-hello-ext:1 examples/browser-extensions/hello-ext
docker build -t everdict-bxa-agent:1 examples/bundles/browser-ext-agent/agent
docker build -t everdict-bxa-web:1   examples/bundles/browser-ext-agent/web
node scripts/live/browser-ext-agent-parallel.mjs 20     # judged e2e + 20-parallel
```

## Verified (gpt-5.4-mini)

- **Judged e2e**: the agent connected over CDP to the extension-loaded browser, navigated to the page, and answered
  `4242` — judge=1.
- **20-parallel**: 20 extension-browser agent tasks ran at once — **passRate 100% (20/20), 0 errors, ~30s wall**, peak
  ~21 concurrent headful-Chromium+extension browsers, ~9 GB RAM (one browser ≈ 184 MB idle). So ~20 concurrent is
  comfortably feasible on a modest box; the ceiling is RAM (headful browsers), not the agent/judge or the machinery.

Note: for a clean cross-container CDP link the browsers run as docker containers here (Nomad dev publishes alloc ports
on 127.0.0.1 only, so cross-alloc CDP isn't reachable there — a dev-cluster networking limit, not a scale limit). The
Nomad per-case-browser provisioning of the same extension image is verified separately in
`scripts/live/browser-extension-nomad.mjs`; a real multi-node cluster with routable ports runs the same at scale.

## Complex multi-step task where the extension is genuinely REQUIRED

`tasksite/` (Flask) serves a **search form → results** page whose access code is **masked** (`••••••••`, the real value
only in `data-code`). `agent-task/` does the multi-step interaction (open → type a query → click Search → results) and
reads the code that `examples/browser-extensions/extractor-ext` **unmasks** into `#__ext_extracted`. Run with
`node scripts/live/browser-ext-task-e2e.mjs`.

**Verified by ablation** (gpt-5.4-mini):

| browser | steps | code on page | agent answer | judge |
|---|---|---|---|---|
| **with** extractor extension | goto → fill → click → results → read `#__ext_extracted` | `EVDX-4242` (unmasked) | `EVDX-4242` | **1 PASS** |
| **without** it (control) | same 4 steps | `••••••••` (masked) | "can't reveal the code" | **0 FAIL** |

So the task is a real multi-step web interaction, and the client extension is **essential** (with=PASS, without=FAIL) —
not merely loaded.
