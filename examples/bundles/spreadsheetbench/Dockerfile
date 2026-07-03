# SpreadsheetBench 실행 환경 이미지 — 하네스가 도는 런타임에 툴체인을 굽는다(호스트 무의존).
# 이 이미지를 case.image / recipe mapping.image 로 참조하면, 관리형 docker/k8s 런타임에서든 유저 로컬 self-hosted
# 러너(로컬 Docker)에서든 동일 환경으로 실행된다 — docs/architecture/portable-harness-runtime.md.
#   • python3 + openpyxl : 입력 생성 · 채점(sbench_grade.py)
#   • libreoffice-calc    : 산출 xlsx 의 수식을 재계산해 캐시값을 채움(공식 eval 이 data_only 로 읽으므로)
#   • git                 : repo env 시드(git init) 요구
# 참조(빌드는 각자/CI): docker build -t spreadsheetbench:v1 examples/bundles/spreadsheetbench
FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice-calc git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && pip install --no-cache-dir --root-user-action=ignore openpyxl

# 헤드리스 LibreOffice 가 파일 로드 시 항상 재계산하도록 강제(ODF/OOXML RecalcMode=0=Always).
# 이게 없으면 --convert-to 가 수식을 재계산하지 않아 data_only 읽기가 None 이 된다.
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

WORKDIR /assay
