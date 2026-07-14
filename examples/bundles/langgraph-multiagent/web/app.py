# Minimal web frontend — exchanges messages with the agent service (web -> agent -> planner<->executor) and shows the
# planner/executor conversation. Proves the topology is a real multi-service app the user faces, not just infra.
import os

import requests
from flask import Flask, Response, jsonify, request

AGENT_URL = os.environ.get("AGENT_URL", "http://agent:8000")
app = Flask(__name__)

HTML = """<!doctype html><meta charset=utf-8><title>LangGraph Multi-Agent</title>
<body style="font-family:system-ui;max-width:720px;margin:2rem auto">
<h2>LangGraph multi-agent (planner ↔ executor)</h2>
<input id=t style="width:70%" placeholder="Ask a task…" value="What is 15% of 240?">
<button onclick=go()>Run</button>
<pre id=o style="white-space:pre-wrap;background:#f4f4f5;padding:1rem;border-radius:8px"></pre>
<script>
async function go(){o.textContent="running…";
 const r=await fetch('/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task:t.value})});
 const j=await r.json();
 o.textContent=(j.messages||[]).map(m=>`[${m.from}→${m.to}] ${m.content}`).join('\\n\\n')+`\\n\\n=== ANSWER ===\\n${j.output}`;}
</script></body>"""


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/")
def index():
    return Response(HTML, mimetype="text/html")


@app.post("/chat")
def chat():
    task = (request.json or {}).get("task", "")
    r = requests.post(f"{AGENT_URL}/runs", json={"task": task}, timeout=180)
    return jsonify(r.json())
