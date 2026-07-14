# Multi-step task site: a search form -> a results page whose access code is MASKED in the DOM (data attribute only).
# The plain page shows only bullets; the real code lives in data-code. An extension is required to unmask it.
from flask import Flask, request

app = Flask(__name__)

FORM = """<!doctype html><meta charset=utf-8><title>Everdict Portal</title>
<body style="font-family:system-ui;max-width:640px;margin:3rem auto">
<h1>Everdict Portal</h1>
<form action="/results" method="get">
  <input id="q" name="q" placeholder="search…" style="width:60%">
  <button id="go" type="submit">Search</button>
</form></body>"""

# The access code is deterministic per query but NEVER rendered as text — only in data-code (masked on screen).
CODES = {"everdict": "EVDX-4242", "seoul": "SEOL-7788"}

def results(q):
    code = CODES.get((q or "").strip().lower(), "NONE-0000")
    return f"""<!doctype html><meta charset=utf-8><title>Results: {q}</title>
<body style="font-family:system-ui;max-width:640px;margin:3rem auto">
<h1>Results for "{q}"</h1>
<p>Your access code (protected):
  <span id="code" class="masked" data-code="{code}">••••••••</span></p>
<p>Only an authorized client extension can reveal it.</p></body>"""

@app.get("/health")
def health(): return {"ok": True}

@app.get("/")
def index(): return FORM

@app.get("/results")
def res(): return results(request.args.get("q", ""))
