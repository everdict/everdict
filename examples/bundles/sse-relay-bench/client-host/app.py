# Playwright wrapping server (client host). Wraps a real Chrome-extension client in a session API so
# an Everdict service-topology harness can acquire it as the per-case target (target.acquire=service):
#   POST   /sessions/{key_prefix} — "start-browser": launch a persistent Chromium with the bundled
#                                   extension loaded and point it at the relay's /client page wired
#                                   to this session's streams. Returns { session_id }.
#   GET    /sessions/{id}         — session existence (200/404).
#   DELETE /sessions/{id}         — close the session's browser (acquire close on dispose).
#   GET    /stats                 — parallelism evidence: active/peak concurrent browser sessions.
# Each session's extension subscribes to its own SSE stream ({key_prefix}:chat:{session_id}) and
# reports its transcript to {key_prefix}:result:{session_id} — per-session isolation by construction.
import os
import shutil
import uuid
from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from playwright.async_api import async_playwright

RELAY_URL = os.environ.get("RELAY_URL", "http://relay:8001").rstrip("/")
EXTENSION_DIR = os.environ.get("EXTENSION_DIR", "/ext")

app = FastAPI()
sessions: dict[str, object] = {}
peak = 0
pw = None


@app.on_event("startup")
async def startup():
    global pw
    pw = await async_playwright().start()


@app.on_event("shutdown")
async def shutdown():
    for ctx in list(sessions.values()):
        try:
            await ctx.close()
        except Exception:
            pass
    if pw is not None:
        await pw.stop()


@app.post("/sessions/{key_prefix}")
async def open_session(key_prefix: str):
    global peak
    session_id = "s" + uuid.uuid4().hex[:12]
    # Extensions require a headful persistent context — Xvfb (xvfb-run in the image CMD) provides the display.
    ctx = await pw.chromium.launch_persistent_context(
        f"/tmp/pw-{session_id}",
        headless=False,
        args=[
            f"--disable-extensions-except={EXTENSION_DIR}",
            f"--load-extension={EXTENSION_DIR}",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
        ],
    )
    chat_stream = f"{key_prefix}:chat:{session_id}"
    result_stream = f"{key_prefix}:result:{session_id}"
    page = ctx.pages[0] if ctx.pages else await ctx.new_page()
    await page.goto(
        f"{RELAY_URL}/client"
        f"?stream={quote(chat_stream, safe='')}"
        f"&report={quote(result_stream, safe='')}"
        f"&session={session_id}"
    )
    sessions[session_id] = ctx
    peak = max(peak, len(sessions))
    return {"session_id": session_id}


@app.get("/sessions/{session_id}")
async def get_session(session_id: str):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="unknown session")
    return {"session_id": session_id, "status": "open"}


@app.delete("/sessions/{session_id}")
async def close_session(session_id: str):
    ctx = sessions.pop(session_id, None)
    if ctx is None:
        raise HTTPException(status_code=404, detail="unknown session")
    await ctx.close()
    # Remove the session's browser profile — without this a long-lived client-host grows disk
    # unboundedly (one profile dir per case; a 50-scorecard soak is 400 of them).
    shutil.rmtree(f"/tmp/pw-{session_id}", ignore_errors=True)
    return {"closed": session_id}


@app.get("/stats")
async def stats():
    return {"active_now": len(sessions), "peak": peak}
