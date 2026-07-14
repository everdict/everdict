# A multi-step browser agent that DEPENDS on a client extension. It: (1) opens the portal, (2) types a query into the
# search form and clicks Search (multi-step interaction), (3) reads the access code that the EXTENSION unmasked into
# #__ext_extracted (the page itself only shows bullets), and (4) answers via the LLM. Without the extension loaded,
# #__ext_extracted is absent and the code stays masked → the task cannot be completed.
import os, re, uuid
from fastapi import FastAPI
from pydantic import BaseModel
from playwright.sync_api import sync_playwright
from langchain_openai import ChatOpenAI

MODEL = os.environ.get("MODEL", "gpt-5.4-mini")
llm = ChatOpenAI(model=MODEL, base_url=os.environ.get("OPENAI_BASE_URL", "http://172.17.0.1:4000/v1"),
                 api_key=os.environ.get("OPENAI_API_KEY", "x"), temperature=0)
app = FastAPI()

class Req(BaseModel):
    task: str
    browser_cdp_url: str | None = None
    thread_id: str | None = None

@app.get("/health")
def health(): return {"ok": True}

@app.post("/runs")
def run(req: Req):
    run_id = req.thread_id or uuid.uuid4().hex
    base = (re.search(r"https?://[^\s'\",)]+", req.task) or [None])[0]
    query = (re.search(r"search for ['\"]([^'\"]+)['\"]", req.task, re.I) or [None, "everdict"])[1]
    steps, page_text, ext_extracted, masked, err = [], "", None, None, None
    if req.browser_cdp_url and base:
        try:
            with sync_playwright() as p:
                browser = p.chromium.connect_over_cdp(req.browser_cdp_url)
                page = (browser.contexts[0] if browser.contexts else browser.new_context()).new_page()
                page.goto(base, wait_until="load", timeout=30000); steps.append(f"goto {base}")
                page.fill("#q", query); steps.append(f"fill #q='{query}'")
                page.click("#go"); steps.append("click Search")
                page.wait_for_selector("#code", timeout=15000); steps.append("results loaded")
                # give the extension's content script a beat to unmask
                page.wait_for_timeout(1500)
                masked = page.inner_text("#code")
                el = page.query_selector("#__ext_extracted")
                ext_extracted = el.inner_text() if el else None; steps.append(f"read #__ext_extracted={ext_extracted}")
                page_text = page.inner_text("body")[:1500]
                browser.close()
        except Exception as e:
            err = str(e)[:300]
    out = llm.invoke(f"Answer the task using ONLY the page content below. Report the access code exactly.\nTask: {req.task}\nPage content:\n{page_text}").content
    return {"run_id": run_id, "output": out, "steps": steps, "ext_extracted": ext_extracted, "masked_on_page": masked, "error": err}
