#!/usr/bin/env python3
# bundle.json generator — inlines scripts/*.py into the dataset files map to make a self-contained bundle.
# After editing a script, run this again to regenerate bundle.json: python3 build-bundle.py
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def script(name):
    with open(os.path.join(HERE, "scripts", name), encoding="utf-8") as f:
        return f.read()


# Ensure openpyxl, then generate the input — a multi-step fallback so it works even under PEP668 (externally-managed Python).
def ensure_openpyxl_then(gen):
    install = (
        'python3 -c "import openpyxl" 2>/dev/null '
        "|| python3 -m pip install --user --break-system-packages --quiet openpyxl 2>/dev/null "
        "|| python3 -m pip install --user --quiet openpyxl"
    )
    return [install, f"python3 {gen}"]


V1_TASK = (
    "The file input.xlsx (sheet 'Sales') has a table with headers in row 1: 'Region' in A1 and "
    "'Amount' in B1, and data in rows 2-6. Compute the total of the Amount column and write ONLY "
    "that number into cell D1 of a NEW file named output.xlsx in the working directory. "
    "Do not modify input.xlsx."
)

V2_TASK = (
    "The file model.xlsx (sheet 'Model') has a table with headers in row 1: 'Product' (A), "
    "'Revenue' (B), 'Cost' (C), and data in rows 2-5. Create output.xlsx that (1) preserves the "
    "original Product/Revenue/Cost columns unchanged, (2) adds a 'Profit' column in D (header D1='Profit', "
    "each row's profit = Revenue - Cost), and (3) writes the total profit somewhere below the table "
    "(e.g. a 'Total' row). Save it as output.xlsx in the working directory."
)

# codex-in-image sample: so that even if codex solves it with a formula inside the image, it is scored via recalc.
CODEX_TASK = (
    "The file input.xlsx (sheet 'Sales') has 'Region' in A1 and 'Amount' in B1, with data in rows 2-6. "
    "Compute the total of the Amount column and put it into cell D1 of a NEW file output.xlsx in the working "
    "directory. A formula such as =SUM(...) is acceptable — it will be recalculated. Keep input.xlsx unchanged. "
    "Only create output.xlsx."
)
# Generate the golden answer golden.xlsx (D1=Amount total) from the input — the grader compares against this golden after recalc (the official V1 method).
GOLDEN_FROM_INPUT = (
    "python3 -c \"import openpyxl;i=openpyxl.load_workbook('input.xlsx')['Sales'];g=openpyxl.Workbook();"
    "g.active['D1']=sum(c.value for c in i['B'][1:] if isinstance(c.value,(int,float)));g.save('golden.xlsx')\""
)
CODEX_GRADER = (
    '/opt/recalc.sh output.xlsx && python3 /opt/sbench_grade.py --version v1 '
    '--output output.xlsx --golden golden.xlsx --answer-position "D1"'
)

bundle = {
    "id": "spreadsheetbench",
    "version": "1.0.0",
    "description": (
        "SpreadsheetBench (v1 + v2) benchmark bundle — registers the real spreadsheet-manipulation benchmark into Everdict. "
        "Recipes (real-data ingest templates) for v1 (912 instructions, online-judge cell comparison) + v2 (4 categories, regression/modification scoring) "
        "plus ready-to-run self-contained xlsx samples. Run with a command harness such as codex."
    ),
    # The codex command harness (same as codex-pinch — idempotent if it already exists). Replaceable by any command harness.
    "harnessTemplates": [
        {
            "kind": "command",
            "category": "cli-agent",
            "id": "codex",
            "version": "1",
            "setup": [],
            "command": "codex exec --sandbox workspace-write --skip-git-repo-check {{task}} < /dev/null",
            "model": "gpt-5-codex",
            "env": {},
            "trace": {"kind": "none"},
        },
        # codex-in-image harness — runs codex inside the image (when a scoring toolchain is needed, like SpreadsheetBench). For auth,
        # the self-hosted runner mounts ~/.codex at /codex (machine login = own-pays; `everdict runner --mount-codex-login`).
        # Inside a container, codex's own sandbox nests and fails → --dangerously-bypass-approvals-and-sandbox (isolation is the container).
        {
            "kind": "command",
            "category": "cli-agent",
            "id": "sbench-codex",
            "version": "1",
            "setup": [],
            "command": "codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check {{task}} < /dev/null",
            "model": "gpt-5-codex",
            "env": {"CODEX_HOME": "/codex"},  # the login directory the runner mounted
            "trace": {"kind": "none"},
        },
    ],
    "harnesses": [
        {"template": {"id": "codex", "version": "1"}, "id": "codex", "version": "1.0.0", "pins": {}},
        {"template": {"id": "sbench-codex", "version": "1"}, "id": "sbench-codex", "version": "1.0.0", "pins": {}},
    ],
    # Recipes: adapter templates for ingesting the real SpreadsheetBench data (HF).
    # An xlsx file tree cannot be ingested as text rows → stage the real data into the image (repoPath), and the grader interpolates
    # answer_position to run the official-formula scoring (sbench_grade.py). id/instruction/answer_position are the dataset.json fields verbatim.
    "benchmarkRecipes": [
        {
            "id": "spreadsheetbench-v1",
            "version": "1.1.0",
            "description": (
                "SpreadsheetBench v1 (RUCKBReasoning/SpreadsheetBench, HF KAKA22/SpreadsheetBench) adapter. "
                "912 instructions · 3 test-cases per case (‹N›_‹id›_input/answer.xlsx) · answer_position cell-value comparison (all must match). "
                "Running it requires staging the dataset into the image /data + bundling sbench_grade.py (see README)."
            ),
            "category": "coding",
            # Original provenance — preserve the officially published benchmark (homepage · paper · code · data · official leaderboard) even after registering.
            "origin": {
                "homepage": "https://spreadsheetbench.github.io/",
                "paper": "https://arxiv.org/abs/2406.14991",
                "code": "https://github.com/RUCKBReasoning/SpreadsheetBench",
                "data": "https://huggingface.co/datasets/KAKA22/SpreadsheetBench",
                "leaderboard": "https://spreadsheetbench.github.io/",
                "authors": "RUC KBReasoning (Renmin University of China)",
                "taskType": "Real-world spreadsheet manipulation — 912 instructions × 3 test-cases, answer_position cell-value comparison (online-judge, Pass@1). Cell/Sheet level.",
            },
            "source": {"kind": "huggingface", "dataset": "KAKA22/SpreadsheetBench"},
            "mapping": {
                "idField": "id",
                "taskField": "instruction",
                "repoPath": "/data",
                "image": "spreadsheetbench:v1",
                "placement": "docker",
                "tagFields": ["instruction_type"],
            },
            "graderTemplates": [
                {
                    "id": "tests-pass",
                    "config": {
                        # Recalc the produced xlsx via recalc.sh (formula → cached value), then run the official-formula scoring — works anywhere since LibreOffice is bundled in the image.
                        "cmd": (
                            "/opt/recalc.sh /data/outputs/{id}_output.xlsx && "
                            "python3 /opt/sbench_grade.py --version v1 "
                            "--output /data/outputs/{id}_output.xlsx "
                            "--golden /data/spreadsheet/{id}/1_{id}_answer.xlsx "
                            '--answer-position "{answer_position}"'
                        )
                    },
                }
            ],
        },
        {
            "id": "spreadsheetbench-v2",
            "version": "1.1.0",
            "description": (
                "SpreadsheetBench v2 (RUCKBReasoning/SpreadsheetBench-2, HF KAKA22/SpreadsheetBench-v2) adapter. "
                "4 categories (Debugging/Financial_Model/Template = cell accuracy, Visualization = VLM checklist). "
                "Cell categories are scored on regression (invariant cells preserved) + modification (changed cells correct) within 1% tolerance. "
                "Visualization is scored on criteria by a judge (VLM) (separately)."
            ),
            "category": "coding",
            "origin": {
                "homepage": "https://spreadsheetbench.github.io/",
                "paper": "https://arxiv.org/abs/2606.29955",
                "code": "https://github.com/RUCKBReasoning/SpreadsheetBench-2",
                "data": "https://huggingface.co/datasets/KAKA22/SpreadsheetBench-v2",
                "leaderboard": "https://spreadsheetbench.github.io/",
                "authors": "RUC KBReasoning (Renmin University of China)",
                "taskType": "End-to-end business spreadsheet workflows — 321 tasks, 4 categories (Debugging/Financial_Model/Template = cell accuracy regression+modification, Visualization = VLM checklist).",
            },
            "source": {"kind": "huggingface", "dataset": "KAKA22/SpreadsheetBench-v2"},
            "mapping": {
                "idField": "id",
                "taskField": "instruction",
                "repoPath": "/data",
                "image": "spreadsheetbench:v2",
                "placement": "docker",
            },
            "graderTemplates": [
                {
                    "id": "tests-pass",
                    "config": {
                        "cmd": (
                            "/opt/recalc.sh /data/outputs/{id}_output.xlsx && "
                            "python3 /opt/sbench_grade.py --version v2 "
                            "--output /data/outputs/{id}_output.xlsx "
                            "--golden /data/{golden_response_path} "
                            "--input /data/{spreadsheet_path} "
                            '--answer-position "{answer_position}"'
                        )
                    },
                }
            ],
        },
    ],
    # Ready-to-run self-contained samples (real xlsx, scored by recalculation without a golden file → no cheating). For demonstrating the pipeline.
    "datasets": [
        {
            "id": "spreadsheetbench-v1-sample",
            "version": "1.0.0",
            "description": "SpreadsheetBench v1-style self-contained sample — put the Amount total from input.xlsx into output.xlsx D1. answer_position cell-value comparison.",
            "cases": [
                {
                    "id": "sum-amount-column",
                    "env": {
                        "kind": "repo",
                        "source": {"files": {"gen_v1.py": script("gen_v1.py"), "grade_v1.py": script("grade_v1.py")}},
                        "setup": ensure_openpyxl_then("gen_v1.py"),
                    },
                    "task": V1_TASK,
                    "graders": [{"id": "tests-pass", "config": {"cmd": "python3 grade_v1.py"}}],
                    "timeoutSec": 600,
                    "tags": ["spreadsheetbench", "v1", "sample", "cell-level"],
                }
            ],
            "tags": ["spreadsheetbench", "v1", "sample"],
        },
        {
            "id": "spreadsheetbench-v2-sample",
            "version": "1.0.0",
            "description": "SpreadsheetBench v2-style self-contained sample — add a Profit column (modification) + preserve the original (regression). Reproduces v2 all-or-nothing scoring.",
            "cases": [
                {
                    "id": "add-profit-column",
                    "env": {
                        "kind": "repo",
                        "source": {"files": {"gen_v2.py": script("gen_v2.py"), "grade_v2.py": script("grade_v2.py")}},
                        "setup": ensure_openpyxl_then("gen_v2.py"),
                    },
                    "task": V2_TASK,
                    "graders": [{"id": "tests-pass", "config": {"cmd": "python3 grade_v2.py"}}],
                    "timeoutSec": 600,
                    "tags": ["spreadsheetbench", "v2", "sample", "workflow"],
                }
            ],
            "tags": ["spreadsheetbench", "v2", "sample"],
        },
        # codex-in-image sample — run with the sbench-codex harness. codex runs inside the container with the machine login (runner --mount-codex-login),
        # and its formula output is recalculated by LibreOffice inside the image, then scored. The image combines codex + the toolchain.
        {
            "id": "spreadsheetbench-v1-codex-sample",
            "version": "1.0.0",
            "description": "codex-in-image sample — codex runs inside the image (spreadsheetbench-codex:v1) with the machine login (runner mount), and its formula output is recalculated then scored. harness=sbench-codex, requires runner `--mount-codex-login`.",
            "cases": [
                {
                    "id": "sum-amount-formula",
                    "env": {
                        "kind": "repo",
                        "source": {"files": {"gen_v1.py": script("gen_v1.py")}},
                        "setup": ["python3 gen_v1.py", GOLDEN_FROM_INPUT],
                    },
                    "image": "spreadsheetbench-codex:v1",  # codex (the agent) + libreoffice/openpyxl/grader (scoring)
                    "task": CODEX_TASK,
                    "graders": [{"id": "tests-pass", "config": {"cmd": CODEX_GRADER}}],
                    "timeoutSec": 600,
                    "tags": ["spreadsheetbench", "v1", "codex", "in-image"],
                }
            ],
            "tags": ["spreadsheetbench", "v1", "codex"],
        },
    ],
}

out = os.path.join(HERE, "bundle.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(bundle, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(f"wrote {out} ({os.path.getsize(out)} bytes)")
