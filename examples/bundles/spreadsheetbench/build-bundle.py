#!/usr/bin/env python3
# bundle.json 생성기 — scripts/*.py 를 데이터셋 files 맵에 인라인 임베드해 자기완결 번들을 만든다.
# 스크립트를 고치면 이걸 다시 돌려 bundle.json 을 재생성한다: python3 build-bundle.py
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def script(name):
    with open(os.path.join(HERE, "scripts", name), encoding="utf-8") as f:
        return f.read()


# openpyxl 보장 후 입력 생성 — 러너 환경이 PEP668(외부관리 파이썬)이어도 동작하도록 다단 폴백.
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

bundle = {
    "id": "spreadsheetbench",
    "version": "1.0.0",
    "description": (
        "SpreadsheetBench(v1 + v2) 벤치마크 번들 — 실제 스프레드시트 조작 벤치마크를 Assay 에 등록. "
        "v1(912 instructions, online-judge 셀 비교) + v2(4 카테고리, regression/modification 채점)의 "
        "레시피(실데이터 인입 템플릿) + 바로 돌아가는 자기완결 xlsx 샘플. codex 등 command 하니스로 수행."
    ),
    # codex command 하니스(코덱스-pinch 와 동일 — 이미 있으면 멱등). 어떤 command 하니스로도 대체 가능.
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
        }
    ],
    "harnesses": [{"template": {"id": "codex", "version": "1"}, "id": "codex", "version": "1.0.0", "pins": {}}],
    # 레시피: 실제 SpreadsheetBench 데이터(HF)를 인입하기 위한 어댑터 템플릿.
    # xlsx 파일 트리는 텍스트 행으로 인입 불가 → 실데이터는 이미지에 스테이징(repoPath)하고, grader 가 answer_position 을
    # 보간해 공식식 채점(sbench_grade.py)을 돌린다. id/instruction/answer_position 은 dataset.json 필드 그대로.
    "benchmarkRecipes": [
        {
            "id": "spreadsheetbench-v1",
            "version": "1.0.0",
            "description": (
                "SpreadsheetBench v1(RUCKBReasoning/SpreadsheetBench, HF KAKA22/SpreadsheetBench) 어댑터. "
                "912 instructions · 케이스별 3 test-case(‹N›_‹id›_input/answer.xlsx) · answer_position 셀 값 비교(전부 일치). "
                "실행엔 dataset 을 이미지 /data 에 스테이징 + sbench_grade.py 동봉 필요(README 참고)."
            ),
            "category": "coding",
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
                        # recalc.sh 로 산출 xlsx 재계산(수식→캐시값) 후 공식식 채점 — 이미지에 LibreOffice 동봉이라 어디서든 동작.
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
            "version": "1.0.0",
            "description": (
                "SpreadsheetBench v2(RUCKBReasoning/SpreadsheetBench-2, HF KAKA22/SpreadsheetBench-v2) 어댑터. "
                "4 카테고리(Debugging/Financial_Model/Template=셀정확도, Visualization=VLM 체크리스트). "
                "셀 카테고리는 regression(불변 셀 보존)+modification(변경 셀 정답) 1% 오차 채점. "
                "Visualization 은 judge(VLM) 로 criteria 채점(별도)."
            ),
            "category": "coding",
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
    # 바로 돌아가는 자기완결 샘플(실 xlsx, golden 파일 없이 재계산 채점 → 커닝 불가). 파이프라인 실증용.
    "datasets": [
        {
            "id": "spreadsheetbench-v1-sample",
            "version": "1.0.0",
            "description": "SpreadsheetBench v1 스타일 자기완결 샘플 — input.xlsx 의 Amount 합계를 output.xlsx D1 에. answer_position 셀 값 비교.",
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
            "description": "SpreadsheetBench v2 스타일 자기완결 샘플 — Profit 열 추가(modification)+원본 보존(regression). v2 all-or-nothing 채점 재현.",
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
    ],
}

out = os.path.join(HERE, "bundle.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(bundle, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(f"wrote {out} ({os.path.getsize(out)} bytes)")
