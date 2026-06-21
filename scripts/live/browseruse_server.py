# 실제 browser-use 를 assay 서비스-토폴로지의 front-door 로 노출하는 최소 HTTP 서버.
# ServiceTopologyBackend 계약: POST /runs {task, browser_cdp_url, thread_id, ...} (완료까지 블록) → 200,
# 그 뒤 토폴로지 런타임이 per-case 브라우저를 snapshot. 여기선 browser-use 가 자기 브라우저를 띄워 LLM 으로
# 진짜 구동하고, 마지막 방문 URL/추출 텍스트를 /observe 로 노출 → assay 의 BrowserSnapshot(url/dom)로 매핑되어
# url-matches/dom-contains 그레이더가 결정론적으로 채점한다. LLM 은 OPENAI_BASE_URL(LiteLLM 프록시) 경유.
#
# browser-use 의 API 가 버전마다 흔들리므로(ChatOpenAI 위치, BrowserSession/Profile, history 접근자) 방어적으로 작성.
import asyncio
import os
import traceback

from aiohttp import web

MODEL = os.environ.get("BROWSERUSE_MODEL", "gpt-5.4-mini")
MAX_STEPS = int(os.environ.get("BROWSERUSE_MAX_STEPS", "6"))
BASE_URL = os.environ.get("OPENAI_BASE_URL", "http://host.docker.internal:4000/v1")
API_KEY = os.environ.get("OPENAI_API_KEY", "x")

_last = {"url": "", "dom": "", "result": "", "error": ""}
_lock = asyncio.Lock()


def make_llm():
    # browser-use 네이티브 ChatOpenAI → 재export → langchain 순으로 시도.
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
    # browser-use 0.13: Agent(browser_profile=...) 로 직접. docker(root)에서 headless + no-sandbox 강제,
    # executable_path 로 베이스 이미지의 chromium 을 써서 런타임 다운로드 회피. cdp_url 오면 외부 브라우저 attach.
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


async def run_handler(request):
    body = await request.json()
    task = body.get("task", "")
    cdp_url = body.get("browser_cdp_url") or ""
    async with _lock:
        _last.update(url="", dom="", result="", error="")
        try:
            from browser_use import Agent  # type: ignore

            llm = make_llm()
            agent = Agent(task=task, llm=llm, use_vision=False, **make_browser_kwargs(cdp_url))
            history = await agent.run(max_steps=MAX_STEPS)
            result = ""
            try:
                result = history.final_result() or ""
            except Exception:
                result = str(history)[:500]
            url, dom = summarize(history)
            _last.update(url=url, dom=dom, result=result)
            try:
                await agent.close()
            except Exception:
                pass
            return web.json_response({"result": result, "url": url})
        except Exception as e:  # noqa: BLE001
            _last.update(error=f"{e}\n{traceback.format_exc()[:1800]}")
            return web.json_response({"error": str(e), "trace": _last["error"]}, status=500)


async def observe_handler(_request):
    return web.json_response(dict(_last))


async def health_handler(_request):
    return web.json_response({"ok": True})


def main():
    app = web.Application(client_max_size=8 * 1024 * 1024)
    app.add_routes(
        [
            web.get("/health", health_handler),
            web.post("/runs", run_handler),
            web.get("/observe", observe_handler),
        ]
    )
    web.run_app(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))


if __name__ == "__main__":
    main()
