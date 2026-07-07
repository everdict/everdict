#!/bin/sh
# Open the produced xlsx in headless LibreOffice to recalculate → fill in cached values, then save it in place.
# The official SpreadsheetBench eval reads with data_only (cached values), so if the agent used formulas, it must be recalculated before scoring.
# Forcing recalculation is handled by the image's registrymodifications.xcu (RecalcMode=Always); here we only open → save.
set -e
f="$1"
[ -f "$f" ] || { echo "recalc: file not found $f" >&2; exit 1; }
dir=$(dirname "$f")
base=$(basename "$f")
out="$dir/_recalc"
rm -rf "$out" && mkdir -p "$out"
# Set HOME explicitly to ensure registrymodifications is applied. A separate profile directory avoids lock conflicts.
HOME=/root soffice --headless --calc --convert-to xlsx:"Calc MS Excel 2007 XML" \
  --outdir "$out" "$f" >/dev/null 2>&1
mv -f "$out/$base" "$f"
rm -rf "$out"
