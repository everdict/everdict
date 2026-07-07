# SpreadsheetBench v1-sample scoring (recalculation — verifies output.xlsx by recomputing the answer from input.xlsx, without a golden file).
# The real benchmark scores against a golden xlsx (→ sbench_grade.py), but the self-contained sample deterministically recomputes the answer to prevent cheating.
# Compares the answer_position cell (here D1 = Amount total) value-wise. exit 0=PASS, 1=FAIL, 2=error.
import os
import sys

try:
    import openpyxl
except ImportError:
    print("openpyxl not installed — the pip install in setup failed", file=sys.stderr)
    sys.exit(2)

if not os.path.exists("output.xlsx"):
    print("output.xlsx is missing — the agent did not produce an output.")
    sys.exit(1)

src = openpyxl.load_workbook("input.xlsx")["Sales"]
expected = sum(c.value for c in src["B"][1:] if isinstance(c.value, (int, float)))  # answer_position=D1
got = openpyxl.load_workbook("output.xlsx", data_only=True).active["D1"].value
ok = isinstance(got, (int, float)) and abs(got - expected) < 1e-6
print(f"answer_position D1: expected={expected} got={got} -> {'PASS' if ok else 'FAIL'}")
sys.exit(0 if ok else 1)
