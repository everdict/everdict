# Standard task-format on-ramp — bring an existing agent benchmark, run it managed

> Status: **M2 in progress.** Slice 1 (Terminal-Bench task → EvalCase pure mapper) landed; later slices
> wire ingestion, the API/MCP surface, image provenance, and the web. SSOT for how Everdict ingests the
> emerging *standard agent-benchmark task formats* (Terminal-Bench first, Harbor next) into its
> harness-agnostic `Dataset` model.

## Why

The market gap Everdict targets is the managed **run + score** layer over standard task formats — the
"Harbor's managed cloud" position: a team that already has Terminal-Bench (or Harbor / SWE-bench) tasks
should point Everdict at them and get a defensible verdict, without re-authoring the benchmark. Today the
dataset on-ramp (`packages/datasets`) is **row-based** (HuggingFace / jsonl / csv → `CaseMapping` →
`EvalCase`), which fits tabular QA/web benchmarks but not the **directory/container** task formats that
coding & terminal agents use. This is the missing on-ramp.

## The seam — external task format → `EvalCase[]`, reusing everything downstream

An agent benchmark task becomes one `EvalCase`; a set of tasks becomes a `Dataset`. Once it is a
`Dataset`, the entire existing pipeline applies unchanged — registry versioning, `runSuite`, graders,
judges, scorecards, **trials / pass@k** (M1), regression diff, leaderboard.

Row-based formats keep using `CaseMapping` (`mapping.ts`). Container/directory formats that are richer
than a flat row (per-task image, working dir, test command, difficulty, array tags) get a **dedicated
pure mapper** — the same way `importWebVoyager` is a preset, but one level up. The mapper is pure,
dependency-free (core only), and fully unit-tested; **parsing the source files (YAML/git) is a boundary
concern** kept out of `packages/datasets` (done at the ingestion edge, which may use a YAML lib).

## Terminal-Bench (`packages/datasets/src/terminal-bench.ts`) — slice 1

A Terminal-Bench task (github.com/laude-institute/terminal-bench) is a directory: `task.yaml`
(`instruction`, `difficulty`, `tags`, timeouts), a `Dockerfile` (the environment), and `tests/`
(graded by exit code). The caller parses those files into a `TerminalBenchTask`; the mapper produces the
`EvalCase`:

| Terminal-Bench | Everdict `EvalCase` |
| --- | --- |
| `instruction` | `task` (the prompt) |
| prebuilt task image (or an `imageTemplate` `{id}`) | `image` (**referenced, not built** — the portability contract) |
| in-image working dir (default `/app`) | `env = { kind: "repo", source: { path } }` (no clone) |
| test command (default `bash /tests/run-tests.sh`) | `graders: [{ id: "tests-pass", config: { cmd } }]` |
| `difficulty` + `tags` | `tags` (difficulty prepended) |
| `max_agent_timeout_sec` | `timeoutSec` (default 900) |

`terminalBenchTaskToCase(task, { imageTemplate })` + `terminalBenchToDataset(tasks, meta, opts)`. The
image is **required** — a task with neither `image` nor a resolvable `imageTemplate` throws
`BadRequestError` (Everdict references images, it never builds them; `case.image` is the portability
contract, rule `datasets`).

### Image provenance
Terminal-Bench builds task images locally at run time; a managed run needs them **prebuilt and pushed**
to a registry the runtime can pull (workspace image registry — `docs/architecture/workspace-image-registry.md`).
The `imageTemplate` (e.g. `ghcr.io/acme/tb-tasks/{id}:v1`) keeps the recipe terse. A prebuild+push helper
(mirroring `examples/bundles/spreadsheetbench/build-bundle.py`) is a later slice.

## Slices

1. **Terminal-Bench pure mapper** (this doc + `terminal-bench.ts` + tests) — task → `EvalCase`, dataset
   build, image-required guard. ✅ Green in `datasets`, no network/docker.
2. **Ingestion edge** — parse a Terminal-Bench task set (YAML task.yaml from a git repo / uploaded
   tarball / manifest) into `TerminalBenchTask[]` at the API/CLI boundary, then `terminalBenchToDataset`.
3. **API/MCP surface** — expose it as a benchmark source/recipe kind so `POST /datasets` / `import_benchmark`
   accept a Terminal-Bench source (BFF↔MCP parity).
4. **Image provenance helper** — prebuild+push tasks to the workspace registry; `imageWarnings` on register.
5. **Web** — the add-benchmark wizard recognizes the Terminal-Bench source kind.
6. **Harbor** ✅ — the same seam for Anthropic's Harbor task format (`harbor.ts`, a second dedicated mapper).
   A Harbor task (instruction.md + task.toml `[metadata]`/`[agent]`/`[environment]`/`[verifier]` + environment/
   Dockerfile + tests/ verifier) maps to the SAME EvalCase shape as Terminal-Bench (image env + instruction +
   tests-pass over the verifier command). Pure + tested in `datasets`.

## Non-goals (for now)
- Building task images in-platform (against the `case.image` contract — reference, don't build).
- A full git-clone-and-discover crawler in the pure package (that is the ingestion edge's job).
- Terminal-Bench's agent-adapter layer — Everdict runs the tenant's own harness against the task, so the
  benchmark's bundled agents are irrelevant; only the task (env + instruction + tests) is ingested.
