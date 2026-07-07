# Minimal HTTP server exposing real browser-use as the front-door of everdict's service topology.
# ServiceTopologyBackend contract: POST /runs {task, browser_cdp_url, thread_id, ...} (blocks until done) → 200,
# after which the topology runtime snapshots the per-case browser. browser-use spins up its own browser and truly drives it
# with the LLM, exposing the last visited URL / extracted text via /observe → mapped to everdict's BrowserSnapshot(url/dom) → url-matches/dom-contains.
#
# Extras:
#  - GET /form, GET /result?q= : *interactive* pages served directly by the container (for navigate→input→click multi-step tasks).
#  - OTLP emit: per run, send real token usage (TokenCost) + real action list (action_names) as spans to Jaeger(:4318). The trace_id
#    is extracted from thread_id ("run-<32hex>") → everdict's OtelTraceSource.fetch(runId=32hex) pulls that trace to score steps/cost.
#
# Tuned for the browser-use 0.13.1 API (Agent/ChatOpenAI/BrowserProfile top-level, Agent(browser_profile=...), chromium via cdp_use).
import asyncio
import os
import re
import secrets
import time
import traceback
import urllib.request

from aiohttp import web

MODEL = os.environ.get("BROWSERUSE_MODEL", "gpt-5.4-mini")
MAX_STEPS = int(os.environ.get("BROWSERUSE_MAX_STEPS", "6"))
BASE_URL = os.environ.get("OPENAI_BASE_URL", "http://host.docker.internal:4000/v1")
API_KEY = os.environ.get("OPENAI_API_KEY", "x")
OTLP_URL = os.environ.get("OTLP_URL", "http://localhost:4318/v1/traces")
VISION = os.environ.get("BROWSERUSE_VISION", "") in ("1", "true", "True")  # when on: include final screenshot base64 (for VLM judge)
RESTRICT_DOMAIN = os.environ.get("BROWSERUSE_RESTRICT_DOMAIN", "") in ("1", "true", "True")  # when on: restrict to the task site


def domains_from_task(task):
    # Domain of the task's first http(s) URL → allowed_domains (prevents leaving the site — so the agent doesn't wander off to
    # Bing etc. in WebVoyager). Allows the root domain + subdomain glob.
    m = re.search(r"https?://([^/\s]+)", task or "")
    if not m:
        return None
    host = m.group(1).split(":")[0]
    parts = host.split(".")
    root = ".".join(parts[-2:]) if len(parts) >= 2 else host
    return [host, root, f"*.{root}"]

_last = {"url": "", "dom": "", "result": "", "error": "", "steps": 0, "actions": [], "tokens": {}, "trace_id": "", "screenshot": ""}
_lock = asyncio.Lock()


def make_llm():
    try:
        from browser_use.llm import ChatOpenAI  # type: ignore

        return ChatOpenAI(model=MODEL, base_url=BASE_URL, api_key=API_KEY)
    except Exception:
        pass
    try:
        from browser_use import ChatOpenAI  # type: ignore

        return ChatOpenAI(model=MODEL, base_url=BASE_URL, api_key=API_KEY)
    except Exception:
        pass
    from langchain_openai import ChatOpenAI as LCChatOpenAI  # type: ignore

    return LCChatOpenAI(model=MODEL, base_url=BASE_URL, api_key=API_KEY, temperature=0.0)


def chromium_path():
    import glob

    for pat in (
        "/ms-playwright/chromium-*/chrome-linux/chrome",
        "/ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell",
    ):
        g = sorted(glob.glob(pat))
        if g:
            return g[-1]
    return None


def make_browser_kwargs(cdp_url, allowed_domains=None):
    # browser-use 0.13: Agent(browser_profile=...). Force headless + no-sandbox in docker (root),
    # use the base image's chromium via executable_path (avoids a runtime download). If cdp_url is given, attach to an external browser.
    # If allowed_domains is given, restrict the agent to those domains (prevents leaving the site).
    args = ["--no-sandbox", "--disable-dev-shm-usage"]
    try:
        from browser_use import BrowserProfile  # type: ignore

        kw = {"headless": True, "args": args}
        exe = chromium_path()
        if exe:
            kw["executable_path"] = exe
        if cdp_url:
            kw["cdp_url"] = cdp_url
        if allowed_domains:
            try:
                return {"browser_profile": BrowserProfile(**kw, allowed_domains=allowed_domains)}
            except Exception:
                pass  # this browser-use version doesn't support allowed_domains → fall back without restriction
        return {"browser_profile": BrowserProfile(**kw)}
    except Exception:
        return {}


def last_screenshot(history):
    # browser-use 0.13: with use_vision, a screenshot is saved per step → history.screenshots() (base64) or screenshot_paths() (files).
    import base64 as _b64

    try:
        shots = [s for s in (history.screenshots() or []) if s]
        if shots:
            s = shots[-1]
            if isinstance(s, str) and s.startswith("/") and os.path.exists(s):
                with open(s, "rb") as f:
                    return _b64.b64encode(f.read()).decode()
            return s
    except Exception:
        pass
    try:
        paths = [p for p in (history.screenshot_paths() or []) if p and os.path.exists(p)]
        if paths:
            with open(paths[-1], "rb") as f:
                return _b64.b64encode(f.read()).decode()
    except Exception:
        pass
    return ""


def summarize(history):
    url, dom = "", ""
    try:
        us = history.urls()
        url = (us[-1] if us else "") or ""
    except Exception:
        pass
    try:
        ec = history.extracted_content()
        dom = "\n".join(x for x in ec if x)
    except Exception:
        pass
    if not dom:
        try:
            dom = history.final_result() or ""
        except Exception:
            dom = ""
    return url, dom


def model_price(model):
    # Per-token unit price ($/token) for computing USD cost. First choice: LiteLLM /model/info (the real price the operator set on the proxy),
    # fallback: operator-specified env (BROWSERUSE_PRICE_IN/OUT — reference price when the proxy has none set). If neither, 0.
    pin = float(os.environ.get("BROWSERUSE_PRICE_IN", "0") or 0)
    pout = float(os.environ.get("BROWSERUSE_PRICE_OUT", "0") or 0)
    try:
        import json as _json

        root = BASE_URL.rsplit("/v1", 1)[0]
        req = urllib.request.Request(f"{root}/model/info", headers={"Authorization": f"Bearer {API_KEY}"})
        data = _json.loads(urllib.request.urlopen(req, timeout=6).read())
        for m in data.get("data", []):
            if m.get("model_name") == model:
                mi = m.get("model_info") or {}
                ic = float(mi.get("input_cost_per_token") or 0)
                oc = float(mi.get("output_cost_per_token") or 0)
                if ic or oc:
                    return ic, oc
    except Exception:
        pass
    return pin, pout


def _attr(k, v):
    if isinstance(v, bool):
        return {"key": k, "value": {"boolValue": v}}
    if isinstance(v, int):
        return {"key": k, "value": {"intValue": str(v)}}
    if isinstance(v, float):
        return {"key": k, "value": {"doubleValue": v}}
    return {"key": k, "value": {"stringValue": str(v)}}


def _span(trace_hex, name, start_ns, end_ns, attrs):
    return {
        "traceId": trace_hex,
        "spanId": secrets.token_hex(8),
        "name": name,
        "kind": 1,
        "startTimeUnixNano": str(start_ns),
        "endTimeUnixNano": str(end_ns),
        "attributes": attrs,
    }


def emit_otlp(trace_hex, model, actions, ptok, ctok, cost, result=""):
    # Real token usage → one llm_call span (gen_ai.*), real action list → one tool_call span per action (gen_ai.tool.name),
    # final answer → message span (output.value). spansToTraceEvents maps these to llm_call(costGrader)/tool_call(stepsGrader)/
    # message(answer-match grader) respectively — WebVoyager-style answer-match scoring reads the final answer from the trace.
    now = time.time_ns()
    spans = [
        _span(
            trace_hex, "browser-use llm", now, now + 1_000_000,
            [
                _attr("gen_ai.request.model", model),
                _attr("gen_ai.usage.input_tokens", int(ptok)),
                _attr("gen_ai.usage.output_tokens", int(ctok)),
                _attr("gen_ai.usage.cost", float(cost)),
            ],
        )
    ]
    for i, name in enumerate(actions):
        s = now + (i + 1) * 1_000_000
        spans.append(_span(trace_hex, name, s, s + 500_000, [_attr("gen_ai.tool.name", name)]))
    if result:
        e = now + (len(actions) + 1) * 1_000_000
        spans.append(_span(trace_hex, "browser-use answer", e, e + 500_000, [_attr("output.value", str(result))]))
    payload = {
        "resourceSpans": [
            {
                "resource": {"attributes": [_attr("service.name", "everdict-browseruse")]},
                "scopeSpans": [{"scope": {"name": "browseruse"}, "spans": spans}],
            }
        ]
    }
    import json as _json

    req = urllib.request.Request(
        OTLP_URL, data=_json.dumps(payload).encode(), headers={"content-type": "application/json"}, method="POST"
    )
    urllib.request.urlopen(req, timeout=8).read()


async def run_handler(request):
    body = await request.json()
    task = body.get("task", "")
    cdp_url = body.get("browser_cdp_url") or ""
    thread_id = body.get("thread_id", "") or ""
    trace_hex = (re.sub(r"[^0-9a-f]", "", thread_id.lower())[:32] or secrets.token_hex(16)).rjust(32, "0")
    async with _lock:
        _last.update(url="", dom="", result="", error="", steps=0, actions=[], tokens={}, trace_id=trace_hex)
        try:
            from browser_use import Agent  # type: ignore
            from browser_use.tokens.service import TokenCost  # type: ignore

            tc = TokenCost(include_cost=False)  # track real token counts (proxy model price unknown → skip cost computation).
            llm = tc.register_llm(make_llm())
            allowed = domains_from_task(task) if RESTRICT_DOMAIN else None
            agent = Agent(task=task, llm=llm, use_vision=VISION, **make_browser_kwargs(cdp_url, allowed))
            history = await agent.run(max_steps=MAX_STEPS)

            result = ""
            try:
                result = history.final_result() or ""
            except Exception:
                result = str(history)[:500]
            url, dom = summarize(history)
            try:
                actions = list(history.action_names())
            except Exception:
                actions = []
            ptok = ctok = 0
            try:
                s = await tc.get_usage_summary()
                ptok, ctok = s.total_prompt_tokens, s.total_completion_tokens
            except Exception:
                pass
            pin, pout = model_price(MODEL)  # real tokens × configured unit price = real USD (price from LiteLLM or operator env)
            cost = ptok * pin + ctok * pout

            try:
                emit_otlp(trace_hex, MODEL, actions, ptok, ctok, cost, result)
            except Exception as e:  # noqa: BLE001
                _last["error"] = f"otlp emit failed (scoring continues): {e}"

            _last.update(
                url=url, dom=dom, result=result, steps=len(actions), actions=actions,
                tokens={"input": int(ptok), "output": int(ctok), "cost": float(cost)},
                screenshot=(last_screenshot(history) if VISION else ""),
            )
            try:
                await agent.close()
            except Exception:
                pass
            return web.json_response({"result": result, "url": url, "steps": len(actions), "trace_id": trace_hex})
        except Exception as e:  # noqa: BLE001
            _last["error"] = f"{e}\n{traceback.format_exc()[:1800]}"
            return web.json_response({"error": str(e), "trace": _last["error"]}, status=500)


async def observe_handler(_request):
    return web.json_response(dict(_last))


async def health_handler(_request):
    return web.json_response({"ok": True})


async def form_handler(_request):
    # Interactive multi-step target (served directly by the container) — forces navigate→input→click.
    return web.Response(
        content_type="text/html",
        text="""<!doctype html><html><head><title>Everdict Search</title></head><body>
<h1>Everdict Search</h1>
<form action="/result" method="get">
  <input id="q" name="q" placeholder="search query">
  <button id="go" type="submit">Search</button>
</form></body></html>""",
    )


async def result_handler(request):
    q = request.rel_url.query.get("q", "")
    safe = re.sub(r"[<>]", "", q)
    return web.Response(
        content_type="text/html",
        text=f"<!doctype html><html><head><title>Results</title></head><body>"
        f"<h1>Results for {safe}</h1><p>Found 3 results for {safe}.</p></body></html>",
    )


def main():
    app = web.Application(client_max_size=8 * 1024 * 1024)
    app.add_routes(
        [
            web.get("/health", health_handler),
            web.post("/runs", run_handler),
            web.get("/observe", observe_handler),
            web.get("/form", form_handler),
            web.get("/result", result_handler),
        ]
    )
    web.run_app(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))


if __name__ == "__main__":
    main()
