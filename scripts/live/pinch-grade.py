#!/usr/bin/env python3
# PinchBench 의 태스크별 자동 채점기 실행기 — 태스크 .md 의 `## Automated Checks` 안 ```python``` 블록(grade(transcript,
# workspace_path) -> dict{criterion: 0..1})을 추출해 실행한다(automated/hybrid 의 진짜 채점). grade() 는 stdlib 만 쓰고
# workspace 의 산출 파일 + transcript(에이전트 대화)를 검사한다. 네트워크 없는 python 컨테이너에서 실행(결정적·안전).
#   python pinch-grade.py <task.md> <workspace_dir> <transcript.json>
#   -> stdout: {"scores": {crit: v}, "mean": m}  (또는 {"error": ...})
import json
import re
import sys


def extract_grade_src(md: str) -> str:
    # "## Automated Checks" 섹션 안의 첫 ```python ... ``` 코드펜스
    sec = re.search(r"##+\s*Automated Checks\b([\s\S]*?)(?=\n##\s|\Z)", md, re.I)
    body = sec.group(1) if sec else md
    fence = re.search(r"```(?:python)?\s*\n([\s\S]*?)```", body)
    return fence.group(1) if fence else ""


def main() -> int:
    task_md, ws, tpath = sys.argv[1], sys.argv[2], sys.argv[3]
    md = open(task_md, encoding="utf-8").read()
    src = extract_grade_src(md)
    if not src or "def grade" not in src:
        print(json.dumps({"error": "no grade() in Automated Checks"}))
        return 0
    try:
        transcript = json.load(open(tpath, encoding="utf-8"))
    except Exception:
        transcript = []
    ns: dict = {}
    try:
        exec(compile(src, "<grade>", "exec"), ns)  # noqa: S102 — PinchBench 채점 함수 정의
        grade = ns.get("grade")
        if not callable(grade):
            print(json.dumps({"error": "grade not callable"}))
            return 0
        scores = grade(transcript, ws)
        if not isinstance(scores, dict):
            scores = {"result": float(scores)}
        nums = [float(v) for v in scores.values() if isinstance(v, (int, float))]
        mean = sum(nums) / len(nums) if nums else 0.0
        print(json.dumps({"scores": scores, "mean": mean}))
    except Exception as e:  # noqa: BLE001 — 채점 함수 실패는 0점 처리(측정 계속)
        print(json.dumps({"error": f"{type(e).__name__}: {e}"[:300]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
