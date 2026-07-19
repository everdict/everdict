# Playwright wrapping server (client host) — session API over a real Chrome-extension client.
# The Playwright base image ships Chromium + Xvfb; the extension is baked at /ext.
# Build FROM THE BUNDLE ROOT (the context must include extension/):
#   docker build -t sse-relay-client-host:v1 -f client-host/Dockerfile .
FROM mcr.microsoft.com/playwright/python:v1.49.1-jammy
WORKDIR /srv
COPY client-host/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY client-host/app.py .
COPY extension /ext
EXPOSE 8002
# Start Xvfb directly instead of xvfb-run: as container PID 1, xvfb-run's sh never receives Xvfb's
# SIGUSR1 ready signal (the kernel drops default-disposition signals to PID 1) and hangs before ever
# starting the command. Same pattern as examples/browser-extensions/hello-ext.
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 & DISPLAY=:99 exec uvicorn app:app --host 0.0.0.0 --port 8002"]
