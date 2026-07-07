# SpreadsheetBench (v1 + v2) — a bundle

Registers the **[SpreadsheetBench](https://spreadsheetbench.github.io/)** spreadsheet-manipulation benchmark
(both **v1** and **v2**) into Everdict as pure data, applied through `POST /bundles/apply` — **zero core/package
changes** (the "specifics live in a bundle, not core" principle; see `docs/architecture/bundles.md`). Ships:

- **Two benchmark recipes** (`spreadsheetbench-v1`, `spreadsheetbench-v2`) — adapters describing how to map the
  real SpreadsheetBench data → Everdict cases, plus the official-style grader wiring.
- **Two runnable, self-contained samples** (`spreadsheetbench-v1-sample`, `spreadsheetbench-v2-sample`) — real
  `.xlsx` cases that run **immediately** with any `command` agent (e.g. codex), no external data needed.
- **The faithful scorer** `scripts/sbench_grade.py` — an openpyxl port of the official V1/V2 comparison, reusable
  for scoring real runs.
- **codex** as a declarative `command` harness (idempotent if your workspace already has it).

## What SpreadsheetBench is

| | V1 | V2 |
|---|---|---|
| Repo | [RUCKBReasoning/SpreadsheetBench](https://github.com/RUCKBReasoning/SpreadsheetBench) · HF `KAKA22/SpreadsheetBench` | [RUCKBReasoning/SpreadsheetBench-2](https://github.com/RUCKBReasoning/SpreadsheetBench-2) · HF `KAKA22/SpreadsheetBench-v2` |
| Size | 912 instructions / 2,729 test cases | 321 tasks, 4 categories (Debugging · Financial_Model · Template · Visualization) |
| Task | isolated cell/sheet manipulation | end-to-end multi-sheet workflows |
| Data point | `id`, `instruction`, `spreadsheet_path`, `instruction_type`, `answer_position` | `id`, `instruction`, `spreadsheet_path`, `golden_response_path`, `answer_position` (Visualization adds a `criteria` checklist) |
| Test cases | 3 `{N}_{id}_input.xlsx`/`_answer.xlsx` per instruction | 1 input + 1 golden per task |
| Scoring | openpyxl `data_only`, compare `answer_position` cells **value-only** (2-dp, exact type); **all 3 test cases must pass** | **regression** (unchanged cells preserved) + **modification** (changed cells correct), 1% numeric tolerance, **all-or-nothing**; Visualization → VLM checklist, `score > 0.7` |
| Output artifact | `outputs/{setting}_{model}/{N}_{id}_output.xlsx` | `{outputs_dir}/{id}_output.xlsx` |

> Both official evals read **cached** cell values (`data_only=True`), so any output workbook with live formulas
> must be **recalculated** (LibreOffice/Excel) before scoring, or value cells read as `None`.

## Apply

```bash
# HTTP (tenant self-serve). Registering harnessTemplates/harnesses needs admin; recipes+datasets need member+.
curl -X POST "$CP/bundles/apply" -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" --data @bundle.json
# or MCP: apply_bundle { bundle: <this file's contents> }
```

Applies 6 items: `codex` template+instance, `spreadsheetbench-v1`/`-v2` recipes, `spreadsheetbench-v1-sample`/
`-v2-sample` datasets. Idempotent (identical re-apply = no-op).

## Run the samples (verified)

The samples are `repo`-env cases: `setup` ensures `openpyxl` and generates the input workbook, the agent writes
`output.xlsx`, and the `tests-pass` grader compares the answer cells (recompute-based → no golden file to leak).

```bash
node scripts/live/spreadsheetbench-selfhosted.mjs
# ① dev control plane ② pair this machine ③ everdict runner (codex on PATH)
# ④ POST /bundles/apply ⑤ run v1-sample + v2-sample × codex × self:<id> ⑥ tests_pass PASS
```

- **v1 sample** (`sum-amount-column`) — sum the `Amount` column of `input.xlsx` into `output.xlsx!D1`
  (`answer_position`-style single-cell check).
- **v2 sample** (`add-profit-column`) — add a `Profit` column (`Revenue - Cost`) + a total, **preserving** the
  original columns — exercising V2's regression + modification split.

## The runtime carries the toolchain (LibreOffice) — via the image

SpreadsheetBench needs a real toolchain: **openpyxl** (grading) and **LibreOffice** — the official eval reads
*cached* cell values (`data_only`), so a formula-producing output must be **recalculated** first. That is a
**runtime** concern, not the agent's: bake it into the image. The `Dockerfile` here builds `spreadsheetbench:v1`
= `python + libreoffice-calc + openpyxl + sbench_grade.py + recalc.sh` (with LibreOffice forced to recalc on
load). Reference it as `case.image` / recipe `mapping.image`; **every runtime honors that image** — managed
docker/nomad/k8s **and** a user's local self-hosted runner with Docker (see
`docs/architecture/portable-harness-runtime.md`). So one definition runs whole anywhere; no host setup, no
"write values not formulas" hack. Verified: agent writes `=SUM(...)` → `recalc.sh` → `sbench_grade.py` → PASS.

```bash
docker build -t spreadsheetbench:v1 examples/bundles/spreadsheetbench   # push to your registry for managed runtimes
```

## Run the real benchmark (bring the data)

SpreadsheetBench cases carry **binary `.xlsx` file trees**, which can't be inlined as dataset text. So the recipes
run real data from the **image** (SWE-bench `/testbed` style), not from HF text rows:

1. Extend the `Dockerfile` to also stage the extracted dataset at `/data` (`dataset.json` + `spreadsheet/<id>/…`)
   and tag it `spreadsheetbench:v1` / `:v2` (the `image` in each recipe's `mapping`; override to your registry).
2. Import the recipe → dataset: `POST /benchmarks/import { recipe: { id: "spreadsheetbench-v1", version: "1.0.0" } }`.
   Each case becomes a `repo` case at `repoPath:/data`; the `tests-pass` grader interpolates the row's `{id}` /
   `{answer_position}` / `{spreadsheet_path}` / `{golden_response_path}` and runs `recalc.sh` then `sbench_grade.py`.
3. Run `dataset × <your harness> × <docker runtime>` (or a **local self-hosted runner with Docker** — same image,
   same result) → `tests_pass` = official-style pass/fail; compare harnesses on the leaderboard
   (`GET /scorecards/leaderboard?dataset=…&metric=tests_pass`).

`sbench_grade.py` implements both metrics: `--version v1` (value-only, 2-dp, exact-type at `answer_position`) and
`--version v2 --input …` (regression+modification split, 1% tolerance, formula/error-aware). For V1's 3-test-case
rule, score each `{N}_{id}_output.xlsx` and require all three. For V2 **Visualization**, register a VLM
**judge** over the rendered chart against the `criteria` checklist instead of `tests-pass` (out of scope for the
deterministic samples).

## codex in the image (machine login, own-pays)

`Dockerfile.codex` builds `spreadsheetbench-codex:v1` = the grader toolchain **+ node + codex**. The `sbench-codex`
harness runs `codex exec --dangerously-bypass-approvals-and-sandbox …` **inside** that image (codex's own nested
linux-sandbox fails in Docker, so the container provides isolation). Auth is the runner's **machine ChatGPT
login**: start the self-hosted runner with `everdict runner --pair … --mount-codex-login`, which bind-mounts
`~/.codex → /codex` (`CODEX_HOME=/codex`) into containerized jobs — **own login pays, no API key** (see
`docs/architecture/portable-harness-runtime.md` slice 4). Verified:

```bash
docker build -t spreadsheetbench-codex:v1 -f Dockerfile.codex examples/bundles/spreadsheetbench
node scripts/live/spreadsheetbench-codex-selfhosted.mjs   # runner --mount-codex-login → codex-in-image → recalc → PASS
```

The `spreadsheetbench-v1-codex-sample` dataset (`image: spreadsheetbench-codex:v1`) runs codex through this path;
a formula output is recalculated by the in-image LibreOffice before scoring, so codex may write `=SUM(...)`.

## Files

| File | What |
|---|---|
| `bundle.json` | the manifest (generated) — apply this |
| `build-bundle.py` | regenerates `bundle.json`, embedding `scripts/*.py` into the sample datasets |
| `Dockerfile` | builds `spreadsheetbench:v1` (python + libreoffice-calc + openpyxl + grader + recalc) — the portable runtime image |
| `Dockerfile.codex` | builds `spreadsheetbench-codex:v1` (= `:v1` + node + codex) — runs codex *in* the image with the runner's mounted machine login (`sbench-codex` harness) |
| `scripts/sbench_grade.py` | faithful V1/V2 scorer (golden-based) — for real data |
| `scripts/recalc.sh` | LibreOffice-headless recalc of a formula xlsx → cached values (run in the grader, pre-scoring) |
| `scripts/gen_v1.py` · `grade_v1.py` | v1 sample input generator + recompute grader |
| `scripts/gen_v2.py` · `grade_v2.py` | v2 sample input generator + regression/modification grader |

Edit a script → rerun `python3 build-bundle.py` → re-apply.
