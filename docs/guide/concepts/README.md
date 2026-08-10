# Core concepts

Seven nouns carry everything else in these docs. Read them in this order the first time.

| Concept | One line |
| --- | --- |
| [Workspace](workspace.md) | the tenant, and the trust boundary — everything else is scoped to it |
| [Harness](harness.md) | the agent under test, driven over a process boundary |
| [Dataset](dataset.md) | the eval cases — harness-agnostic by construction |
| [Run](run.md) | one execution, and the platform's universal execution record |
| [Grader & Judge](grader-and-judge.md) | how a result becomes a measurement |
| [Scorecard](scorecard.md) | dataset × harness, aggregated — the unit you compare |
| [Verdict](verdict.md) | what "pass" means, and why absence is never green |

## How one evaluation flows through them

```
Workspace
   └── Scorecard  =  Dataset (N cases)  ×  Harness (one version)
                          │
                          ├─ per case → Run ─────────────────────────────┐
                          │               Environment (repo/browser/os)  │
                          │               Driver (in-sandbox compute)    │
                          │               Backend (placement)            │
                          │                                              │
                          └─ per case ← Scores ← Graders (at run time)  ─┘
                                              ← Judges  (over the trace)
                                                   │
                                                   └→ Verdict (per case, then aggregated)
```

Two separations do most of the work:

**Grading is not the harness's job.** The agent produces a trace and a snapshot of the world; the
graders score them. Two different agents solving the same case are therefore scored by the same code,
which is the only reason their numbers can be compared.

**Placement is not compute.** A *Backend* decides *where* a job runs (a Nomad cluster, a Kubernetes
cluster, your laptop). A *Driver* is the in-sandbox compute that actually starts the process once it is
there. Mixing the two is what makes most eval tooling impossible to move between environments.

## Two words you will meet immediately

- **Registry** — harnesses, datasets, judges, and runtimes are all versioned documents keyed
  `(workspace, id, version)`. Versions are **immutable**; `latest` resolves by semver. Every
  comparison in Everdict rests on this.
- **Trace** — the normalized event stream a run produces (`TraceEvent[]`), and the evidence judges read.
  It can come from the harness Everdict drove, or be pushed/pulled from an external observability
  platform for a run that happened elsewhere.
