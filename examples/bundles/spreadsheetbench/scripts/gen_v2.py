# SpreadsheetBench v2-샘플(워크플로/재무모델 스타일) 입력 생성 — Revenue/Cost 표가 든 model.xlsx.
# 실제 v2 Financial_Model 은 다중시트 모델(수 MB)이지만, 샘플은 regression(불변 셀 보존)+modification(신규 셀 정답)
# 이라는 v2 핵심 채점을 작은 표로 재현한다.
import openpyxl

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Model"
ws["A1"], ws["B1"], ws["C1"] = "Product", "Revenue", "Cost"
rows = [("Alpha", 1000, 600), ("Beta", 750, 500), ("Gamma", 1200, 900), ("Delta", 300, 100)]
for i, (p, r, c) in enumerate(rows, start=2):
    ws[f"A{i}"], ws[f"B{i}"], ws[f"C{i}"] = p, r, c
wb.save("model.xlsx")
print(f"wrote model.xlsx ({len(rows)} rows); profits={[r - c for _, r, c in rows]} total={sum(r - c for _, r, c in rows)}")
