# SpreadsheetBench v1 스타일 샘플 입력 생성 — 실제 xlsx 스프레드시트를 작업 디렉터리에 심는다.
# 실제 SpreadsheetBench(912 instructions)은 포럼에서 수집한 xlsx 를 케이스별로 제공하지만, 번들에 바이너리를
# 인라인할 수 없으므로 샘플은 setup 에서 이 스크립트로 결정적 xlsx 를 생성한다(파이프라인 실증용).
import openpyxl

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Sales"
ws["A1"], ws["B1"] = "Region", "Amount"
rows = [("North", 120), ("South", 340), ("East", 80), ("West", 260), ("North", 150)]
for i, (region, amount) in enumerate(rows, start=2):
    ws[f"A{i}"], ws[f"B{i}"] = region, amount
wb.save("input.xlsx")
print(f"wrote input.xlsx ({len(rows)} rows), sum(Amount)={sum(a for _, a in rows)}")
