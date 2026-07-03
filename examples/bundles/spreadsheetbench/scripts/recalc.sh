#!/bin/sh
# 산출 xlsx 를 LibreOffice 헤드리스로 열어 재계산 → 캐시값을 채운 뒤 원위치 저장.
# 공식 SpreadsheetBench eval 은 data_only(캐시값)로 읽으므로, 에이전트가 수식을 쓴 경우 채점 전에 반드시 재계산해야 한다.
# 재계산 강제는 이미지의 registrymodifications.xcu(RecalcMode=Always)가 담당하고, 여기선 열기→저장만 한다.
set -e
f="$1"
[ -f "$f" ] || { echo "recalc: 파일 없음 $f" >&2; exit 1; }
dir=$(dirname "$f")
base=$(basename "$f")
out="$dir/_recalc"
rm -rf "$out" && mkdir -p "$out"
# HOME 을 명시해 registrymodifications 를 확실히 적용. 별도 프로파일 디렉터리로 락 충돌 회피.
HOME=/root soffice --headless --calc --convert-to xlsx:"Calc MS Excel 2007 XML" \
  --outdir "$out" "$f" >/dev/null 2>&1
mv -f "$out/$base" "$f"
rm -rf "$out"
