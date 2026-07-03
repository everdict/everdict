# SpreadsheetBench (v1 + v2) — a bundle

Registers the **[SpreadsheetBench](https://spreadsheetbench.github.io/)** spreadsheet-manipulation benchmark
(both **v1** and **v2**) into Assay as pure data, applied through `POST /bundles/apply` — **zero core/package
changes** (the "specifics live in a bundle, not core" principle; see `docs/architecture/bundles.md`). Ships:

- **Two benchmark recipes** (`spreadsheetbench-v1`, `spreadsheetbench-v2`) — adapters describing how to map the
  real SpreadsheetBench data → Assay cases, plus the official-style grader wiring.
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
# ① dev control plane ② pair this machine ③ assay runner (codex on PATH)
# ④ POST /bundles/apply ⑤ run v1-sample + v2-sample × codex × self:<id> ⑥ tests_pass PASS
```

- **v1 sample** (`sum-amount-column`) — sum the `Amount` column of `input.xlsx` into `output.xlsx!D1`
  (`answer_position`-style single-cell check).
- **v2 sample** (`add-profit-column`) — add a `Profit` column (`Revenue - Cost`) + a total, **preserving** the
  original columns — exercising V2's regression + modification split.

## Run the real benchmark (bring the data)

SpreadsheetBench cases carry **binary `.xlsx` file trees**, which can't be inlined as dataset text. So the recipes
run real data from an **image** (SWE-bench `/testbed` style), not from HF text rows:

1. Build an image that stages the extracted dataset at `/data` (`dataset.json` + `spreadsheet/<id>/…`) and copies
   `scripts/sbench_grade.py` to `/opt/sbench_grade.py`. Tag it `spreadsheetbench:v1` / `spreadsheetbench:v2`
   (the `image` in each recipe's `mapping`; override to your registry).
2. Import the recipe → dataset: `POST /benchmarks/import { recipe: { id: "spreadsheetbench-v1", version: "1.0.0" } }`.
   Each case becomes a `repo` case at `repoPath:/data`; the `tests-pass` grader interpolates the row's `{id}` /
   `{answer_position}` / `{spreadsheet_path}` / `{golden_response_path}` into a `sbench_grade.py` call.
3. Run `dataset × <your harness> × <docker runtime>` → `tests_pass` = official-style pass/fail; compare harnesses
   on the leaderboard (`GET /scorecards/leaderboard?dataset=…&metric=tests_pass`).

`sbench_grade.py` implements both metrics: `--version v1` (value-only, 2-dp, exact-type at `answer_position`) and
`--version v2 --input …` (regression+modification split, 1% tolerance, formula/error-aware). For V1's 3-test-case
rule, score each `{N}_{id}_output.xlsx` and require all three. For V2 **Visualization**, register a VLM
**judge** over the rendered chart against the `criteria` checklist instead of `tests-pass` (out of scope for the
deterministic samples).

## Files

| File | What |
|---|---|
| `bundle.json` | the manifest (generated) — apply this |
| `build-bundle.py` | regenerates `bundle.json`, embedding `scripts/*.py` into the sample datasets |
| `scripts/sbench_grade.py` | faithful V1/V2 scorer (golden-based) — for real data |
| `scripts/gen_v1.py` · `grade_v1.py` | v1 sample input generator + recompute grader |
| `scripts/gen_v2.py` · `grade_v2.py` | v2 sample input generator + regression/modification grader |

Edit a script → rerun `python3 build-bundle.py` → re-apply.
