---
paths: "packages/datasets/**"
---
# Datasets rules (push)

Datasets are **harness-agnostic** eval-case bundles (`Dataset` = `EvalCase[]`). This package turns an external
benchmark source into cases; it never knows which harness runs them. See `docs/datasets.md` + skill `evaluation`.

- **Source → cases via a `CaseMapping`** (`mapping.ts`): `rowToCase`/`rowsToDataset` interpolate row fields into
  each case's `task`/`graders`/`env`. Sources (`sources.ts`) are HF (`HfRowsParams`), jsonl, csv — fetch is
  injected (`FetchLike`), never a hardcoded client.
- **`EvalCase.image` is the portability contract** (per-case compute image): `imageField` (per-row, e.g. SWE-bench
  official prebuilt = deps+repo) **wins over** `image` (dataset-common, e.g. an OSWorld desktop image). Reference
  an image, **don't build** one in-platform.
- **A case may declare the WORLD it needs**, not just its image: `resources` (cpu millicores/memoryMb/gpu)
  and `network` (`public`|`none`|`allowlist`). These belong to the TASK, not the harness — a build task
  needs 4 GB whichever agent attempts it, and an offline benchmark must be offline for every harness being
  compared — which is why they are harness-agnostic case data. An adapter that reads a source declaring
  them (a container-task format's `[environment]`) MUST carry them over rather than drop them: the
  execution site enforces or refuses (rule `drivers`), but only if the declaration survives the import.
- Cases are harness-agnostic — do NOT bake harness/model assumptions into a case here (grader config is fine;
  harness selection happens at run/scorecard submit).
- Validate every parsed row at the boundary with Zod; a bad enum throws (no silent fallback). Tenant-owned +
  `_shared` fallback like the other registries (rule `registry`).
