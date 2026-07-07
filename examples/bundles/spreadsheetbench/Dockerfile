# SpreadsheetBench execution-environment image — bakes the toolchain into the runtime the harness runs in (host-independent).
# Referencing this image as case.image / recipe mapping.image runs in the same environment whether on a managed docker/k8s runtime
# or on a user's local self-hosted runner (local Docker) — docs/architecture/portable-harness-runtime.md.
#   • python3 + openpyxl : input generation · scoring (sbench_grade.py)
#   • libreoffice-calc    : recalculate the produced xlsx's formulas to fill in cached values (since the official eval reads with data_only)
#   • git                 : required for the repo env seed (git init)
# For reference (build it yourself / in CI): docker build -t spreadsheetbench:v1 examples/bundles/spreadsheetbench
FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice-calc git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && pip install --no-cache-dir --root-user-action=ignore openpyxl

# Force headless LibreOffice to always recalculate on file load (ODF/OOXML RecalcMode=0=Always).
# Without this, --convert-to does not recalculate formulas and the data_only read returns None.
RUN mkdir -p /root/.config/libreoffice/4/user \
  && printf '%s\n' \
  '<?xml version="1.0" encoding="UTF-8"?>' \
  '<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' \
  ' <item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>0</value></prop></item>' \
  ' <item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>' \
  '</oor:items>' \
  > /root/.config/libreoffice/4/user/registrymodifications.xcu

COPY scripts/sbench_grade.py scripts/recalc.sh /opt/
RUN chmod +x /opt/recalc.sh

WORKDIR /everdict
