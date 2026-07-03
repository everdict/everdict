# SpreadsheetBench v1-샘플 채점(재계산식 — golden 파일 없이 input.xlsx 로부터 정답을 재계산해 output.xlsx 를 검증).
# 실제 벤치마크는 golden xlsx 로 채점하지만(→ sbench_grade.py), 자기완결 샘플은 정답을 결정적으로 재계산해 커닝을 막는다.
# answer_position 셀(여기선 D1 = Amount 합계)을 값-기준으로 비교. exit 0=PASS, 1=FAIL, 2=오류.
import os
import sys

try:
    import openpyxl
except ImportError:
    print("openpyxl 미설치 — setup 의 pip 설치 실패", file=sys.stderr)
    sys.exit(2)

if not os.path.exists("output.xlsx"):
    print("output.xlsx 가 없습니다 — 에이전트가 산출물을 만들지 않았습니다.")
    sys.exit(1)

src = openpyxl.load_workbook("input.xlsx")["Sales"]
expected = sum(c.value for c in src["B"][1:] if isinstance(c.value, (int, float)))  # answer_position=D1
got = openpyxl.load_workbook("output.xlsx", data_only=True).active["D1"].value
ok = isinstance(got, (int, float)) and abs(got - expected) < 1e-6
print(f"answer_position D1: expected={expected} got={got} -> {'PASS' if ok else 'FAIL'}")
sys.exit(0 if ok else 1)
