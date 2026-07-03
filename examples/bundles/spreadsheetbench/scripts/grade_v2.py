# SpreadsheetBench v2-샘플 채점(재계산식) — v2 의 핵심인 regression+modification 을 함께 검증.
#   modification: 신규 D열 'Profit' = Revenue-Cost(행별) + 어딘가에 총이익 셀이 정확.
#   regression:   원본 A/B/C 열(Product/Revenue/Cost)이 그대로 보존됐는가(불변 셀 훼손 금지).
# 둘 다 100% 여야 PASS(v2 all-or-nothing). exit 0=PASS, 1=FAIL, 2=오류.
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

src = openpyxl.load_workbook("model.xlsx")["Model"]
data = [
    (c[0].value, c[1].value, c[2].value)
    for c in zip(src["A"][1:], src["B"][1:], src["C"][1:])
    if isinstance(c[1].value, (int, float))
]
exp_profits = [r - co for _, r, co in data]
exp_total = sum(exp_profits)

ws = openpyxl.load_workbook("output.xlsx", data_only=True).active

# modification: 행별 Profit(D2..) 정확?
got_profits = [ws[f"D{i}"].value for i in range(2, 2 + len(exp_profits))]
mod_profit_ok = all(isinstance(g, (int, float)) and abs(g - e) < 1e-6 for g, e in zip(got_profits, exp_profits))
# modification: 총이익 셀이 어딘가 존재?
all_nums = [c.value for row in ws.iter_rows() for c in row if isinstance(c.value, (int, float))]
mod_total_ok = any(abs(v - exp_total) < 1e-6 for v in all_nums)
# regression: 원본 Revenue/Cost 가 보존됐는가(B/C 열).
reg_ok = all(
    ws[f"B{i}"].value == r and ws[f"C{i}"].value == co for i, (_, r, co) in enumerate(data, start=2)
)

ok = mod_profit_ok and mod_total_ok and reg_ok
print(
    f"modification: profits={got_profits}(ok={mod_profit_ok}) total(ok={mod_total_ok}); "
    f"regression: Revenue/Cost preserved(ok={reg_ok}) -> {'PASS' if ok else 'FAIL'}"
)
sys.exit(0 if ok else 1)
