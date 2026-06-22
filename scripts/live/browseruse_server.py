# 실제 browser-use 를 assay 서비스-토폴로지의 front-door 로 노출하는 최소 HTTP 서버.
# ServiceTopologyBackend 계약: POST /runs {task, browser_cdp_url, thread_id, ...} (완료까지 블록) → 200,
# 그 뒤 토폴로지 런타임이 per-case 브라우저를 snapshot. browser-use 가 자기 브라우저를 띄워 LLM 으로 진짜 구동하고,
# 마지막 방문 URL/추출 텍스트를 /observe 로 노출 → assay 의 BrowserSnapshot(url/dom) 로 매핑 → url-matches/dom-contains.
#
# 추가:
#  - GET /form, GET /result?q= : 컨테이너가 직접 서빙하는 *인터랙티브* 페이지(navigate→input→click 멀티스텝 태스크용).
#  - OTLP 배출: run 마다 실제 토큰사용량(TokenCost)+실제 액션열(action_names)을 Jaeger(:4318)로 스팬 전송. trace_id 는
#    thread_id("run-<32hex>")에서 추출 → assay 의 OtelTraceSource.fetch(runId=32hex) 가 그 trace 를 끌어와 steps/cost 채점.
#
# browser-use 0.13.1 API 에 맞춤(Agent/ChatOpenAI/BrowserProfile top-level, Agent(browser_profile=...), cdp_use 로 chromium).
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

_last = {"url": "", "dom": "", "result": "", "error": "", "steps": 0, "actions": [], "tokens": {}, "trace_id": ""}
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


def make_browser_kwargs(cdp_url):
    # browser-use 0.13: Agent(browser_profile=...). docker(root)에서 headless + no-sandbox 강제,
    # executable_path 로 베이스 이미지의 chromium 사용(런타임 다운로드 회피). cdp_url 오면 외부 브라우저 attach.
    args = ["--no-sandbox", "--disable-dev-shm-usage"]
    try:
        from browser_use import BrowserProfile  # type: ignore

        kw = {"headless": True, "args": args}
        exe = chromium_path()
        if exe:
            kw["executable_path"] = exe
        if cdp_url:
            kw["cdp_url"] = cdp_url
        return {"browser_profile": BrowserProfile(**kw)}
    except Exception:
        return {}


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


def emit_otlp(trace_hex, model, actions, ptok, ctok, cost):
    # 실 토큰사용량 → llm_call 스팬 1개(gen_ai.*), 실 액션열 → 액션당 tool_call 스팬(gen_ai.tool.name).
    # spansToTraceEvents 가 전자→llm_call(costGrader), 후자→tool_call(stepsGrader) 로 매핑.
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
    payload = {
        "resourceSpans": [
            {
                "resource": {"attributes": [_attr("service.name", "assay-browseruse")]},
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

            tc = TokenCost(include_cost=False)  # 실 토큰 카운트 추적(프록시 모델 가격 미상 → cost 계산은 생략).
            llm = tc.register_llm(make_llm())
            agent = Agent(task=task, llm=llm, use_vision=False, **make_browser_kwargs(cdp_url))
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
            cost = 0.0
            try:
                s = await tc.get_usage_summary()
                ptok, ctok, cost = s.total_prompt_tokens, s.total_completion_tokens, s.total_cost
            except Exception:
                pass

            try:
                emit_otlp(trace_hex, MODEL, actions, ptok, ctok, cost)
            except Exception as e:  # noqa: BLE001
                _last["error"] = f"otlp emit 실패(채점은 진행): {e}"

            _last.update(
                url=url, dom=dom, result=result, steps=len(actions), actions=actions,
                tokens={"input": int(ptok), "output": int(ctok), "cost": float(cost)},
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
    # 인터랙티브 멀티스텝 타깃(컨테이너가 직접 서빙) — navigate→input→click 를 강제.
    return web.Response(
        content_type="text/html",
        text="""<!doctype html><html><head><title>Assay Search</title></head><body>
<h1>Assay Search</h1>
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
