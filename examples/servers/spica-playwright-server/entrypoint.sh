#!/usr/bin/env bash
# Container start: virtual display -> (optional) build the extension -> serve.
set -euo pipefail

DISPLAY="${DISPLAY:-:99}"
SCREEN="${XVFB_SCREEN:-1280x800x24}"
EXTENSION_PATH="${EXTENSION_PATH:-/ext}"

log() { printf '▶ %s\n' "$*"; }

# Is the display answering? xdpyinfo is the real check (X is up AND accepting connections); the socket
# test is the fallback for a derived image that dropped x11-utils — without one of the two, a browser
# launch races the display and fails with an unhelpful "missing X server".
display_ready() {
  if command -v xdpyinfo >/dev/null 2>&1; then
    xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1
  else
    [ -S "/tmp/.X11-unix/X${DISPLAY#:}" ]
  fi
}

# Chromium loads extensions only with a real display, so a virtual one is not optional here. Xvfb is
# started directly rather than through xvfb-run: under a container init, xvfb-run waits for a readiness
# signal it never receives and hangs before running the command.
if ! display_ready; then
  log "starting Xvfb on ${DISPLAY} (${SCREEN})"
  Xvfb "${DISPLAY}" -screen 0 "${SCREEN}" -nolisten tcp >/tmp/xvfb.log 2>&1 &
  for _ in $(seq 1 50); do
    display_ready && break
    sleep 0.2
  done
  display_ready || { log "Xvfb failed to come up"; cat /tmp/xvfb.log; exit 1; }
fi
export DISPLAY

# Optional: build spica-client from source when no extension was mounted at EXTENSION_PATH. Baking or
# mounting a prebuilt extension is the faster path; this exists so the image can stand alone.
if [ ! -d "${EXTENSION_PATH}" ] && [ -n "${SPICA_CLIENT_REPO:-}" ]; then
  src_dir="${SPICA_CLIENT_SRC:-/tmp/spica-client}"
  log "cloning ${SPICA_CLIENT_REPO} -> ${src_dir}"
  git clone --depth 1 ${SPICA_CLIENT_REF:+--branch "${SPICA_CLIENT_REF}"} "${SPICA_CLIENT_REPO}" "${src_dir}"
  ( cd "${src_dir}" && pnpm install --frozen-lockfile && pnpm build )
  built="${src_dir}/.output/chrome-mv3"
  [ -d "${built}" ] || { log "expected a build at ${built}"; exit 1; }
  mkdir -p "$(dirname "${EXTENSION_PATH}")"
  ln -sfn "${built}" "${EXTENSION_PATH}"
fi

if [ ! -d "${EXTENSION_PATH}" ]; then
  # Failing here beats starting: every /start-browser would launch a browser, walk a panel that does not
  # exist, time out, and roll back — an expensive way to report a missing mount.
  log "no extension at ${EXTENSION_PATH} — mount one or set SPICA_CLIENT_REPO"
  exit 1
fi
log "extension at ${EXTENSION_PATH} ($(du -sh "${EXTENSION_PATH}" 2>/dev/null | cut -f1))"

mkdir -p "${USER_DATA_DIR:-/tmp/spica-profiles}"
exec uv run --no-sync python -m spica_playwright_server
