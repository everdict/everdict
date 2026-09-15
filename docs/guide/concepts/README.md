---
kind: wiki
title: "Core concepts"
status: current
updated: 2026-09-15
anchors: [apps/api/src/api/harness/harness-template.routes.ts, apps/api/src/api/scorecard/request/run-scorecard.ts, packages/contracts/src/execution/eval-case.ts]
---
# Core concepts

Eight nouns carry everything else in these docs. Read them in this order the first time.

- **[Workspace](workspace.md)** — the tenant, and the trust boundary everything else is scoped to
- **[Harness](harness.md)** — the agent under test, driven over a process boundary
- **[Dataset](dataset.md)** — the eval cases, harness-agnostic by construction
- **[Run](run.md)** — one execution, and the platform's universal execution record
- **[Grader & Judge](grader-and-judge.md)** — how a result becomes a measurement
- **[Scorecard](scorecard.md)** — dataset × harness, aggregated: the unit you compare
- **[Verdict](verdict.md)** — what "pass" means, and why absence is never green
- **[Runtime](runtime.md)** — where your evals actually run, and how to say "my machine"

## One evaluation, end to end

Three registrations, a batch and a comparison. This is the whole product in miniature:

```bash
# 1 — the agent under test, as a declaration (a template, then the instance a scorecard names)
curl -XPOST localhost:8787/harness-templates -H 'content-type: application/json' -d '{
  "kind": "command", "category": "cli-agent", "id": "my-agent", "version": "1",
  "command": "my-agent --task {{task}}", "model": "claude-sonnet-5",
  "trace": { "kind": "none" }}'
curl -XPOST localhost:8787/harnesses -H 'content-type: application/json' -d '{
  "template": { "id": "my-agent", "version": "1" }, "id": "my-agent", "version": "1.0.0" }'

# 2 — the problems, which never mention the agent
curl -XPOST localhost:8787/datasets -H 'content-type: application/json' -d '{
  "id": "smoke", "version": "1.0.0", "cases": [{
    "id": "write-file",
    "env": { "kind": "repo", "source": { "files": {} } },
    "task": "Create ok.txt containing the text done",
    "graders": [{ "id": "tests-pass", "config": { "cmd": "grep -q done ok.txt" } }],
    "timeoutSec": 120, "tags": [] }]}'

# 3 — run every case, three times each, on a runtime you registered
curl -XPOST localhost:8787/scorecards -H 'content-type: application/json' -d '{
  "dataset": { "id": "smoke",    "version": "latest" },
  "harness": { "id": "my-agent", "version": "latest" },
  "runtime": "local",
  "trials": 3 }'

# 4 — the only question that matters
curl 'localhost:8787/scorecards/diff?baseline=<baseline-id>&candidate=<candidate-id>'
```

Step 2 is where the leverage is. Because the dataset never names the agent, step 1 can be swapped for
Codex, Claude Code, or a competitor's product, and step 4 still means something.

## How the pieces fit

```
Workspace
   └── Scorecard  =  Dataset (N cases)  ×  Harness (one version)
                          │
                          ├─ per case → Run ─────────────────────────────┐
                          │               Environment (repo/prompt/…)    │
                          │               Driver (in-sandbox compute)    │
                          │               Backend (placement)            │
                          │                                              │
                          └─ per case ← Scores ← Graders (at run time)  ─┘
                                              ← Judges  (over the trace)
                                                   │
                                                   └→ Verdict (per case, then aggregated)
```

Two separations do most of the work.

**Grading is not the harness's job.** The agent produces a trace and a snapshot; the graders score
them. Two different agents solving the same case are scored by the same code, which is the only reason
their numbers can be compared at all.

**Placement is not compute.** A *Backend* decides *where* a job runs; a *Driver* is the in-sandbox
compute that starts the process once it is there. Mixing the two is what makes most eval tooling
impossible to move between environments.

## Two words you will meet immediately

**Registry** — harness templates and instances, datasets, judges, rubrics, models and runtimes are
versioned documents keyed `(workspace, id, version)`. Versions are **immutable**; `latest` resolves by
semver. Every comparison in Everdict rests on this.

**Trace** — the normalized event stream a run produces, and the evidence judges read. It can come from
the harness Everdict drove, or be pushed or pulled from an external observability platform for a run
that happened somewhere else entirely.
