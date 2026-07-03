#!/usr/bin/env python3
# SpreadsheetBench 공식 채점 로직의 이식(openpyxl 전용) — 실제 데이터(golden xlsx) 채점용.
# 실행: python3 sbench_grade.py --version v1|v2 --output OUT.xlsx --golden GOLD.xlsx --answer-position "'Sheet'!A1:B10,C3" [--input IN.xlsx]
#   exit 0 = PASS, 1 = FAIL, 2 = 오류(파일/openpyxl 없음).
#   v1: answer_position 셀을 값-기준(2dp 반올림·타입일치)으로 비교, 전부 일치해야 PASS.
#   v2: input→golden 을 diff 해 regression(불변 셀 보존)·modification(변경 셀 정답)으로 나눠 채점(1% 상대오차),
#       regression 과 modification 이 모두 100% 여야 PASS(--input 필요; regression/modification 분리를 위해).
# 참고: 공식 eval 은 data_only 로 캐시값을 읽으므로 산출 xlsx 는 사전 재계산(LibreOffice 등)돼 있어야 한다.
import argparse
import datetime
import re
import sys

try:
    import openpyxl
except ImportError:
    print("openpyxl 미설치 — 채점 불가", file=sys.stderr)
    sys.exit(2)

_RANGE_RE = re.compile(r"^(?:'([^']+)'!|([^'!]+)!)?(.+)$")


def parse_answer_position(spec):
    # 콤마로 분리하되 따옴표 안의 콤마는 무시. 각 조각 → (sheet|None, a1range).
    parts, buf, in_q = [], [], False
    for ch in spec:
        if ch == "'":
            in_q = not in_q
            buf.append(ch)
        elif ch == "," and not in_q:
            parts.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    if buf:
        parts.append("".join(buf).strip())
    out = []
    for p in parts:
        if not p:
            continue
        m = _RANGE_RE.match(p)
        sheet = m.group(1) or m.group(2)
        out.append((sheet.strip() if sheet else None, m.group(3).strip()))
    return out


def find_sheet(wb, name):
    if name is None:
        return wb[wb.sheetnames[0]]
    norm = lambda s: "".join(s.split()).lower()
    for sn in wb.sheetnames:
        if norm(sn) == norm(name):
            return wb[sn]
    raise KeyError(name)


def cells_of(ws, a1):
    if ":" not in a1:
        return [ws[a1]]
    return [c for row in ws[a1] for c in row]


def transform_value(v):
    # v1 정규화: 숫자 2dp, 시간/날짜, float 파싱 가능한 문자열.
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return round(float(v), 2)
    if isinstance(v, datetime.datetime):
        return round((v - datetime.datetime(1899, 12, 30)).days + 0.0, 0)
    if isinstance(v, datetime.time):
        return str(v)[:-3]
    if isinstance(v, str):
        try:
            return round(float(v), 2)
        except ValueError:
            return v
    return v


def eq_v1(a, b):
    ta, tb = transform_value(a), transform_value(b)
    if ta is None and tb is None:
        return True
    if type(ta) is not type(tb):
        return False
    return ta == tb


_NM = {"#div/0!", "#n/a", "n/a", "na", "n.a.", "n/m", "nm", "n.m.", "-", "--", "---", "–", "—"}


def eq_v2(a, b, tol=0.01):
    # 숫자는 1% 상대오차, 무의미 placeholder 동치, None≡0, ""≡None.
    if (a is None or a == "") and (b is None or b == ""):
        return True
    if a is None:
        a = 0
    if b is None:
        b = 0
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        denom = max(abs(a), abs(b))
        return abs(a - b) <= (tol * denom if denom else tol)
    sa, sb = str(a).strip().lower(), str(b).strip().lower()
    if sa in _NM and sb in _NM:
        return True
    fa = sa.replace("$", "").lstrip("=+").replace("=", "", 1) if sa.startswith(("=", "+")) else sa
    fb = sb.replace("$", "").lstrip("=+").replace("=", "", 1) if sb.startswith(("=", "+")) else sb
    return fa == fb


def collect(path, positions, data_only=True):
    wb = openpyxl.load_workbook(path, data_only=data_only)
    vals = {}
    for sheet, a1 in positions:
        ws = find_sheet(wb, sheet)
        # 셀 키는 '해결된 시트 제목'이 아니라 answer_position 의 시트 지정(이름 | 첫 시트)으로 — golden/output 의 첫
        # 시트 제목이 달라도(예: golden='Sheet', output='Sales') 첫 시트끼리 위치로 비교되게. 공식 eval 도 첫 시트 기준.
        skey = sheet if sheet is not None else "\x00first"
        for c in cells_of(ws, a1):
            vals[(skey, c.coordinate)] = c.value
    return vals


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", choices=["v1", "v2"], required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--golden", required=True)
    ap.add_argument("--answer-position", required=True)
    ap.add_argument("--input", help="v2 regression/modification 분리에 필요한 원본 입력 xlsx")
    a = ap.parse_args()
    pos = parse_answer_position(a.answer_position)
    try:
        gold = collect(a.golden, pos)
        out = collect(a.output, pos)
    except FileNotFoundError as e:
        print(f"파일 없음: {e}")
        sys.exit(1)

    if a.version == "v1":
        bad = [k for k in gold if not eq_v1(gold[k], out.get(k))]
        print(f"v1: {len(gold)} cells, {len(bad)} mismatched -> {'PASS' if not bad else 'FAIL'}")
        if bad[:5]:
            print("  e.g.", [(k, gold[k], out.get(k)) for k in bad[:5]])
        sys.exit(0 if not bad else 1)

    # v2: regression(불변) vs modification(변경) 분리
    if not a.input:
        print("v2 채점엔 --input 이 필요합니다(regression/modification 분리)")
        sys.exit(2)
    inp = collect(a.input, pos)
    reg = [k for k in gold if eq_v2(inp.get(k), gold[k])]
    mod = [k for k in gold if k not in reg]
    reg_ok = sum(1 for k in reg if eq_v2(gold[k], out.get(k)))
    mod_ok = sum(1 for k in mod if eq_v2(gold[k], out.get(k)))
    reg_ratio = 1.0 if not reg else reg_ok / len(reg)
    mod_ratio = 1.0 if not mod else mod_ok / len(mod)
    if reg_ratio >= 0.998:
        reg_ratio = 1.0
    ok = reg_ratio == 1.0 and mod_ratio == 1.0
    print(f"v2: regression={reg_ok}/{len(reg)} modification={mod_ok}/{len(mod)} -> {'PASS' if ok else 'FAIL'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
