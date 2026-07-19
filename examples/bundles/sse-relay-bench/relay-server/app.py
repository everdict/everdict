# SSE relay server. Sits between the command server (Redis Streams producer) and the in-browser
# extension client:
#   GET  /client              — a bare HTML page with NO JavaScript of its own; only the loaded
#                               Chrome extension animates it (proves real extension loading).
#   GET  /events/{stream}     — SSE: XREAD the Redis stream from 0 and forward each entry until "done".
#   GET  /subscribed/{stream} — 200 iff an SSE consumer is currently connected (the acquire.ready gate).
#   POST /results/{stream}    — the client's transcript, relayed onto the result stream for the
#                               command server to pick up (closing the loop).
#   GET  /stats               — parallelism evidence: active/peak concurrent SSE streams.
import json
import os
import time

import redis.asyncio as redis
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
STREAM_TTL_S = int(os.environ.get("STREAM_TTL_S", "600"))

app = FastAPI()
bus = redis.from_url(REDIS_URL, decode_responses=True)

active: dict[str, int] = {}
peak = 0

CLIENT_PAGE = """<!doctype html>
<html>
  <head><meta charset="utf-8"><title>everdict sse relay client</title></head>
  <body>
    <h1>everdict sse relay client</h1>
    <div id="status" data-state="waiting-for-extension">waiting for extension</div>
    <div id="messages"></div>
  </body>
</html>
"""


@app.get("/client")
async def client_page():
    return HTMLResponse(CLIENT_PAGE)


@app.get("/events/{stream}")
async def events(stream: str):
    async def gen():
        global peak
        active[stream] = active.get(stream, 0) + 1
        peak = max(peak, sum(active.values()))
        try:
            last_id = "0"  # replay from the start — a late subscriber loses nothing (streams retain history)
            deadline = time.monotonic() + STREAM_TTL_S
            while time.monotonic() < deadline:
                resp = await bus.xread({stream: last_id}, block=2000, count=100)
                for _stream, entries in resp or []:
                    for entry_id, fields in entries:
                        last_id = entry_id
                        payload = fields.get("payload", "{}")
                        yield f"data: {payload}\n\n"
                        if json.loads(payload).get("type") == "done":
                            return
        finally:
            active[stream] = active.get(stream, 1) - 1
            if active[stream] <= 0:
                active.pop(stream, None)

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/subscribed/{stream}")
async def subscribed(stream: str):
    if active.get(stream, 0) > 0:
        return {"subscribers": active[stream]}
    raise HTTPException(status_code=404, detail="no active subscriber")


@app.post("/results/{stream}")
async def results(stream: str, request: Request):
    body = await request.json()
    await bus.xadd(stream, {"payload": json.dumps(body)})
    return {"ok": True}


@app.get("/stats")
async def stats():
    return {"active_now": sum(active.values()), "peak": peak}
