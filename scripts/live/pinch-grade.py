#!/usr/bin/env python3
# PinchBench per-task automated grader runner — extracts and runs the ```python``` block (grade(transcript,
# workspace_path) -> dict{criterion: 0..1}) inside a task .md's `## Automated Checks` (the real grading for automated/hybrid). grade() uses only stdlib and
# inspects the workspace's output files + transcript (agent conversation). Runs in a network-less python container (deterministic, safe).
#   python pinch-grade.py <task.md> <workspace_dir> <transcript.json>
#   -> stdout: {"scores": {crit: v}, "mean": m}  (or {"error": ...})
import json
import re
import sys


def extract_grade_src(md: str) -> str:
    # The first ```python ... ``` code fence inside the "## Automated Checks" section
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
        exec(compile(src, "<grade>", "exec"), ns)  # noqa: S102 — defines the PinchBench grading function
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
    except Exception as e:  # noqa: BLE001 — a grading-function failure is scored 0 (measurement continues)
        print(json.dumps({"error": f"{type(e).__name__}: {e}"[:300]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
