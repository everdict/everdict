"""Minimal browser agent (LangGraph) for the service-topology e2e.

Acts on a PER-CASE browser: connects to the CDP url Assay's ServiceTopologyBackend
provisions (via run config.configurable.browser_cdp_url), navigates to the URL in the
task, extracts page text, and answers via the configured model (our LiteLLM
gpt-5.4-mini). Assay then snapshots the same browser (DOM/URL) and grades it.
"""

import os
import re

from langchain.chat_models import init_chat_model
from langchain_core.messages import AIMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, MessagesState, StateGraph


async def act(state: MessagesState, config: RunnableConfig) -> dict:
    cfg = (config or {}).get("configurable", {})
    cdp = cfg.get("browser_cdp_url") or os.environ.get("BROWSER_CDP_URL", "")
    spec = os.environ.get("MODEL", "openai/gpt-5.4-mini")
    provider, mname = spec.split("/", 1)
    model = init_chat_model(mname, model_provider=provider)
    msgs = state["messages"]
    task = msgs[-1].content if msgs else ""
    task = task if isinstance(task, str) else str(task)

    url, page_text = "", ""
    m = re.search(r"https?://[^\s]+", task)
    if cdp and m:
        os.environ["HOME"] = "/tmp"  # 비루트 앱 사용자 HOME=/nonexistent → playwright 드라이버 캐시 쓰기용
        os.environ["XDG_CACHE_HOME"] = "/tmp/.cache"
        from playwright.async_api import async_playwright

        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp(cdp)
            bctx = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = bctx.pages[0] if bctx.pages else await bctx.new_page()
            await page.goto(m.group(0), wait_until="domcontentloaded", timeout=30000)
            url = page.url
            page_text = (await page.inner_text("body"))[:3000]
            # 원격 chromedp + 페이지 타깃은 Assay 스냅샷용으로 유지(close 안 함)

    prompt = (
        f"Task: {task}\n\nThe browser is at: {url}\nPage text:\n{page_text}\n\n"
        "Answer the task using the page content above. End your answer with the word DONE."
    )
    resp = await model.ainvoke([{"role": "user", "content": prompt}])
    return {"messages": [AIMessage(content=resp.content)]}


graph = StateGraph(MessagesState).add_node("act", act).add_edge(START, "act").add_edge("act", END).compile()
