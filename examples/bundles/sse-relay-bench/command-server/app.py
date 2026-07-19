# Dummy benchmark front door (command server). The topology's entry point:
#   POST /runs        — accept a benchmark task, then stream MESSAGE_COUNT dummy agent chat messages
#                       through Redis Streams ({key_prefix}:chat:{session_id}) and await the client's
#                       transcript on {key_prefix}:result:{session_id}.
#   GET  /runs/{id}   — poll status; the done body carries the sentinel observation + an inline trace.
#   GET  /stats       — parallelism evidence: active/peak run counts + per-run intervals.
# No LLM calls — the point is to exercise the full browser-use-shaped loop (front door → bus → SSE →
# in-browser extension client → result upstream) under case-level parallelism, with per-run isolation
# verified by nonce accounting (leaked/missing must be zero).
import asyncio
import json
import os
import secrets
import time

import redis.asyncio as redis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MESSAGE_COUNT = int(os.environ.get("MESSAGE_COUNT", "40"))
PUBLISH_INTERVAL_MS = int(os.environ.get("PUBLISH_INTERVAL_MS", "250"))
RESULT_TIMEOUT_S = int(os.environ.get("RESULT_TIMEOUT_S", "180"))
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")

app = FastAPI()
bus = redis.from_url(REDIS_URL, decode_responses=True)

runs: dict[str, dict] = {}
active_now = 0
active_peak = 0


class RunRequest(BaseModel):
    run_id: str
    session_id: str
    key_prefix: str
    task: str


def now_ms() -> int:
    return int(time.time() * 1000)


async def drive(req: RunRequest) -> None:
    global active_now, active_peak
    run = runs[req.run_id]
    chat_stream = f"{req.key_prefix}:chat:{req.session_id}"
    result_stream = f"{req.key_prefix}:result:{req.session_id}"
    t0 = time.monotonic()
    trace: list[dict] = []
    sent: list[dict] = []
    try:
        trace.append({"t": 0, "kind": "env_action", "action": "publish_started", "detail": {"stream": chat_stream}})
        for seq in range(MESSAGE_COUNT):
            msg = {
                "type": "chat",
                "run_id": req.run_id,
                "session_id": req.session_id,
                "seq": seq,
                "nonce": f"{req.run_id[:8]}-{seq}-{secrets.token_hex(4)}",
                "text": f"agent step {seq} for task: {req.task}",
            }
            sent.append(msg)
            await bus.xadd(chat_stream, {"payload": json.dumps(msg)})
            t_ms = int((time.monotonic() - t0) * 1000)
            trace.append({"t": t_ms, "kind": "message", "role": "assistant", "text": msg["text"]})
            await asyncio.sleep(PUBLISH_INTERVAL_MS / 1000)
        await bus.xadd(chat_stream, {"payload": json.dumps({"type": "done", "run_id": req.run_id})})

        # Await the transcript the extension client reports back (relayed onto the result stream).
        transcript = None
        last_id = "0"
        deadline = time.monotonic() + RESULT_TIMEOUT_S
        while time.monotonic() < deadline and transcript is None:
            resp = await bus.xread({result_stream: last_id}, block=2000, count=10)
            for _stream, entries in resp or []:
                for entry_id, fields in entries:
                    last_id = entry_id
                    transcript = json.loads(fields.get("payload", "{}"))
                    break
        t_result = int((time.monotonic() - t0) * 1000)
        if transcript is None:
            trace.append({"t": t_result, "kind": "error", "message": "result timeout: no transcript from the client"})
            run.update(status="failed", finished_ms=now_ms(), trace=trace)
            return

        # Verify: the transcript must contain exactly our nonces (no foreign-session leakage, no loss).
        received = transcript.get("received", [])
        sent_nonces = [m["nonce"] for m in sent]
        sent_set = set(sent_nonces)
        leaked = [
            m
            for m in received
            if m.get("run_id") != req.run_id
            or m.get("session_id") != req.session_id
            or m.get("nonce") not in sent_set
        ]
        received_set = {m.get("nonce") for m in received}
        missing = [n for n in sent_nonces if n not in received_set]
        seqs = [m.get("seq", -1) for m in received if m.get("nonce") in sent_set]
        out_of_order = sum(1 for a, b in zip(seqs, seqs[1:]) if b < a)
        ok = not leaked and not missing and transcript.get("session_id") == req.session_id
        summary = {
            "ok": ok,
            "run_id": req.run_id,
            "session_id": req.session_id,
            "key_prefix": req.key_prefix,
            "sent": len(sent),
            "received": len(received),
            "leaked": len(leaked),
            "missing": len(missing),
            "out_of_order": out_of_order,
            "duration_ms": t_result,
            "nonces": sent_nonces,
        }
        trace.append({"t": t_result, "kind": "env_action", "action": "transcript_received", "detail": summary})
        verdict = (
            f"verdict: ok={str(ok).lower()} sent={len(sent)} received={len(received)} "
            f"leaked={len(leaked)} missing={len(missing)} out_of_order={out_of_order}"
        )
        trace.append({"t": t_result, "kind": "message", "role": "assistant", "text": verdict})
        run.update(
            status="done",
            finished_ms=now_ms(),
            trace=trace,
            summary=summary,
            observation={"kind": "prompt", "output": json.dumps(summary)},
        )
    except Exception as err:  # infra failure inside the loop — surface it as a failed run, never a hang
        trace.append({"t": int((time.monotonic() - t0) * 1000), "kind": "error", "message": str(err)})
        run.update(status="failed", finished_ms=now_ms(), trace=trace)
    finally:
        active_now -= 1


@app.post("/runs")
async def submit(req: RunRequest):
    global active_now, active_peak
    if req.run_id in runs:
        return {"accepted": True, "run_id": req.run_id}  # idempotent resubmit
    runs[req.run_id] = {
        "status": "running",
        "session_id": req.session_id,
        "started_ms": now_ms(),
        "finished_ms": None,
    }
    active_now += 1
    active_peak = max(active_peak, active_now)
    asyncio.create_task(drive(req))
    return {"accepted": True, "run_id": req.run_id}


@app.get("/runs/{run_id}")
async def status(run_id: str):
    run = runs.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="unknown run")
    body = {"status": run["status"]}
    if run["status"] in ("done", "failed"):
        body["trace"] = run.get("trace", [])
        if "observation" in run:
            body["observation"] = run["observation"]
            body["summary"] = run["summary"]
    return body


@app.get("/stats")
async def stats():
    return {
        "active_now": active_now,
        "active_peak": active_peak,
        "runs": [
            {
                "run_id": rid,
                "session_id": r["session_id"],
                "status": r["status"],
                "started_ms": r["started_ms"],
                "finished_ms": r["finished_ms"],
            }
            for rid, r in runs.items()
        ],
    }
