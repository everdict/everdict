# A minimal browser-use-style agent: it connects (Playwright, connect_over_cdp) to a per-case browser that Everdict
# provisioned WITH a client extension loaded, navigates to the task URL, reads the page, and answers via an LLM.
# It also reports whether the client extension is active (the content script prefixes titles with EXT-LOADED:).
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
    url = (re.search(r"https?://[^\s]+", req.task) or [None])[0] if req.browser_cdp_url else None
    page_text, ext_active, err = "", False, None
    if req.browser_cdp_url:
        try:
            with sync_playwright() as p:
                # connect to the extension-loaded browser Everdict provisioned for this case.
                browser = p.chromium.connect_over_cdp(req.browser_cdp_url)
                ctx = browser.contexts[0] if browser.contexts else browser.new_context()
                page = ctx.new_page()
                if url:
                    page.goto(url, wait_until="load", timeout=30000)
                page_text = page.inner_text("body")[:2000]
                ext_active = page.title().startswith("EXT-LOADED:")  # the client extension's content script ran
                browser.close()
        except Exception as e:
            err = str(e)[:300]
    prompt = f"Answer the task using ONLY the page content.\nTask: {req.task}\nPage content:\n{page_text}"
    out = llm.invoke(prompt).content
    return {"run_id": run_id, "output": out, "extension_active": ext_active, "page_chars": len(page_text), "error": err}
