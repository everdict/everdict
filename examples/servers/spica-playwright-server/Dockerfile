# spica-playwright-server — extension-loaded Chromium behind a session API.
#
# Build from THIS directory:
#   docker build -t spica-playwright-server:0.1.0 .
#
# The Playwright base image already carries Chromium and its system libraries; adding them by hand is
# how versions drift apart from the `playwright` package that drives them.
# This tag is COUPLED to the pinned `playwright` version in pyproject.toml — the package resolves
# browsers under a version-stamped path, so the two move together or nothing launches.
FROM mcr.microsoft.com/playwright/python:v1.49.1-jammy

# tini reaps the Chrome trees that outlive their parent (a browser leaves zombies otherwise, and PID 1
# in a container does not reap by default). socat republishes each session's loopback-bound debugging
# port when CDP exposure is on.
# x11-utils is here for xdpyinfo: without it the entrypoint cannot tell "Xvfb is up" from "Xvfb is
# starting", and every browser launch would race the display.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini socat git curl xvfb x11-utils \
    && rm -rf /var/lib/apt/lists/*

# Node is only for the optional build-from-source path (SPICA_CLIENT_REPO). The Playwright *python*
# image ships no Node at all, and Ubuntu's own package is too old for corepack — so a documented option
# that silently could not run is worth ~120MB to make real.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv

WORKDIR /srv
COPY pyproject.toml README.md ./
COPY src ./src
# Resolve dependencies at BUILD time so a container start is not a package install (and so a broken
# dependency set fails the build rather than the first request).
RUN uv sync --no-dev

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DISPLAY=:99 \
    PORT=8080 \
    EXTENSION_PATH=/ext \
    USER_DATA_DIR=/tmp/spica-profiles \
    MAX_CONCURRENT_BROWSERS=8 \
    SESSION_TIMEOUT_MINUTES=15 \
    CLEANUP_INTERVAL_MINUTES=1

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

# -g so signals reach the whole process group: Xvfb and every Chrome tree go down with the container.
ENTRYPOINT ["tini", "-g", "--", "/entrypoint.sh"]
