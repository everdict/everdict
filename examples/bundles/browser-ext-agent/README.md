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

## A REAL agent that drives the browser to complete the task (`agent-real/`)

`agent-real/` is a genuine **ReAct loop** — the LLM is *in* the loop, not a script around it. Each turn it `observe()`s
the page (indexed interactive elements incl. their current values + the visible body text), the model **decides ONE
action** (`goto` / `type` / `click` / `read` / `finish`), the agent executes it over CDP, re-observes, and repeats until
it answers. Nothing about the task steps is hard-coded; the model works out the plan from what it sees.

`tasksite/` (Flask) serves a **search form → results** page whose access code is **masked** (`••••••••`, the real value
only in `data-code`, never in the text the agent sees). `examples/browser-extensions/extractor-ext` **unmasks** it into
`#__ext_extracted`. Run the judged e2e + ablation with `node scripts/live/browser-ext-task-e2e.mjs`.

**Verified by ablation** (gpt-5.4-mini) — the agent's own decision trace, then an LLM judge:

| browser | LLM-decided steps | agent answer | judge |
|---|---|---|---|
| **with** extractor extension | `goto` → `type "everdict"` → `click` Search → `finish` | `EVDX-4242` (read from `#__ext_extracted`) | **1 PASS** |
| **without** it (control) | `goto` → `type` → `click` → **`read`** (sees `••••••••`) → `finish` | "I can't retrieve the protected access code…" | **0 FAIL** |

Two things this proves: (1) the agent **genuinely controls the browser** — it navigates, types, submits, reads, and
answers from the *real* page state (in the control it even adds an extra `read` step to check, then honestly reports it
can't find the code — behaviour that changes with the page, so it is neither scripted nor hallucinated); (2) the client
extension is **essential** (with=PASS, without=FAIL), not merely loaded.

Note: the agent container reaches the host LiteLLM via `host.docker.internal` (`--add-host=…:host-gateway`); on this box
ufw blocks the docker0 gateway `172.17.0.1:4000` directly. `agent-task/` remains as the earlier *scripted* baseline for
contrast — `agent-real/` is the actual agent.
