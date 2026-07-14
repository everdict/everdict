# Headful Chromium (Xvfb) with a client extension baked + LOADED, exposing CDP on 9222 — the "browser+extension image"
# an Everdict service-topology harness references via target.extension.ref. Chromium binds CDP to 127.0.0.1 only
# (recent versions ignore --remote-debugging-address), so socat bridges 0.0.0.0:9222 → 127.0.0.1:9223 (the headless-shell trick).
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb socat curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY extension /ext
EXPOSE 9222
CMD ["sh","-c","Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 & socat tcp-listen:9222,fork,reuseaddr tcp:127.0.0.1:9223 & DISPLAY=:99 exec chromium --no-sandbox --disable-gpu --disable-dev-shm-usage --load-extension=/ext --disable-extensions-except=/ext --remote-debugging-port=9223 --remote-allow-origins=* --user-data-dir=/tmp/cud about:blank"]
