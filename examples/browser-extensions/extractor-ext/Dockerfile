# Headful Chromium (Xvfb) with the extractor extension loaded, CDP exposed via socat (same pattern as hello-ext).
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb socat curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY extension /ext
EXPOSE 9222
CMD ["sh","-c","Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 & socat tcp-listen:9222,fork,reuseaddr tcp:127.0.0.1:9223 & DISPLAY=:99 exec chromium --no-sandbox --disable-gpu --disable-dev-shm-usage --load-extension=/ext --disable-extensions-except=/ext --remote-debugging-port=9223 --remote-allow-origins=* --user-data-dir=/tmp/cud about:blank"]
