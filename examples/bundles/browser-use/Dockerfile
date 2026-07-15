# browser-use eval runner image — the browser-use developer's BYO image for Everdict.
# Command-harness contract: Everdict runs `python /app/run_bu.py {{task}} …` inside this container
# (spec.image promoted to case.image → DockerDriver on a self-hosted runner / managed Docker backend).
# The agent drives its own headless Chromium; the final answer is printed to stdout (trace: none).
FROM python:3.12-slim

# browser-use 0.13 drives Chromium over CDP (cdp-use) — it needs a Chromium binary but not playwright's API.
# Debian's chromium SIGTRAPs headless in slim containers, so ship playwright's docker-hardened Chromium build
# (playwright is installed only for its browser download + system deps) and point the entrypoint at it.
RUN pip install --no-cache-dir browser-use==0.13.3 playwright \
  && python -m playwright install --with-deps chromium \
  && ln -s "$(find /root/.cache/ms-playwright -maxdepth 3 -type f \( -name chrome -o -name headless_shell \) -path '*chrom*' | head -1)" /usr/local/bin/bu-chromium

ENV BROWSER_USE_EXECUTABLE_PATH=/usr/local/bin/bu-chromium

COPY run_bu.py /app/run_bu.py
# Live-screen capture helper — Everdict's runner execs it to screenshot the running Chromium over CDP (best-effort).
COPY bu_screenshot.py /app/bu_screenshot.py

# Sanity: entries parse + browser-use API surface imports (catches API drift at build time).
RUN python - <<'PY'
import ast
ast.parse(open('/app/run_bu.py').read())
ast.parse(open('/app/bu_screenshot.py').read())
from browser_use import Agent, ChatOpenAI
from browser_use.browser.profile import BrowserProfile
print('browser-use import surface OK')
PY

WORKDIR /work
