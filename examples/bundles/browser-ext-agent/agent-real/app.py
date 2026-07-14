# A REAL LLM-driven browser agent (ReAct loop). The LLM is IN the loop: it observes the page's interactive elements,
# DECIDES one browser action (goto / type / click / read / finish), the agent executes it over CDP, re-observes, and
# repeats until it answers. NOTHING about the task steps is scripted — the model drives the browser itself.
import json, os, re, uuid
from fastapi import FastAPI
from pydantic import BaseModel
from playwright.sync_api import sync_playwright
from langchain_openai import ChatOpenAI

MODEL = os.environ.get("MODEL", "gpt-5.4-mini")
MAX_STEPS = int(os.environ.get("MAX_STEPS", "10"))
llm = ChatOpenAI(model=MODEL, base_url=os.environ.get("OPENAI_BASE_URL", "http://172.17.0.1:4000/v1"),
                 api_key=os.environ.get("OPENAI_API_KEY", "x"), temperature=0, timeout=40, max_retries=1)
app = FastAPI()


def log(m):
    print(f"[agent] {m}", flush=True)


class Req(BaseModel):
    task: str
    browser_cdp_url: str | None = None
    thread_id: str | None = None


def observe(page):
    # Give the model a compact, indexed view of what it can act on + the visible text (so it sees masked vs revealed).
    # For fields we also show the CURRENT value so the model knows what it has already typed (else it re-types forever).
    els = page.query_selector_all("a, button, input, textarea, select, [id]")
    listing, handles = [], []
    for e in els:
        try:
            tag = e.evaluate("el => el.tagName.toLowerCase()")
            if tag not in ("a", "button", "input", "textarea", "select") and not e.get_attribute("id"):
                continue
            idx = len(handles)
            desc = tag
            for a in ("id", "name", "placeholder", "type", "href"):
                v = e.get_attribute(a)
                if v:
                    desc += f' {a}="{v[:40]}"'
            if tag in ("input", "textarea", "select"):
                val = (e.input_value() or "").strip() if tag != "select" else (e.evaluate("el => el.value") or "")
                desc += f' value="{val[:40]}"'
            txt = (e.inner_text() or "").strip().replace("\n", " ")[:50] if tag in ("a", "button") else ""
            listing.append(f"[{idx}] <{desc}>" + (f' "{txt}"' if txt else ""))
            handles.append(e)
        except Exception:
            continue
    body = (page.inner_text("body") or "").strip().replace("\n", " ")[:800]
    return listing, handles, body


SYS = (
    "You are a web agent controlling a browser. Each turn you see the current URL, the visible page text, and an "
    "indexed list of interactive elements. Respond with ONE JSON action and nothing else:\n"
    '  {"thought": "...", "action": "goto", "url": "http://..."}\n'
    '  {"thought": "...", "action": "type", "index": N, "text": "..."}\n'
    '  {"thought": "...", "action": "click", "index": N}\n'
    '  {"thought": "...", "action": "read", "index": N}   (returns that element\'s text)\n'
    '  {"thought": "...", "action": "finish", "answer": "..."}\n'
    "Decide the next single step to accomplish the task. When you know the answer, use finish."
)


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/runs")
def run(req: Req):
    run_id = req.thread_id or uuid.uuid4().hex
    trace, answer, err = [], None, None
    if not req.browser_cdp_url:
        return {"run_id": run_id, "output": "", "error": "no browser", "trace": trace}
    try:
        log(f"run {run_id}: connecting CDP {req.browser_cdp_url}")
        with sync_playwright() as pw:
            browser = pw.chromium.connect_over_cdp(req.browser_cdp_url, timeout=20000)
            page = (browser.contexts[0] if browser.contexts else browser.new_context()).new_page()
            log("connected; page ready")
            obs_note = ""
            for step in range(MAX_STEPS):
                listing, handles, body = observe(page)
                log(f"step {step}: url={page.url} els={len(handles)} -> asking LLM")
                prompt = (
                    f"Task: {req.task}\n\nCurrent URL: {page.url}\nVisible text: {body}\n\n"
                    f"Interactive elements:\n" + "\n".join(listing) + (f"\n\n{obs_note}" if obs_note else "")
                )
                raw = llm.invoke([("system", SYS), ("user", prompt)]).content
                m = re.search(r"\{.*\}", raw, re.S)
                act = json.loads(m.group(0)) if m else {"action": "finish", "answer": raw[:200]}
                log(f"step {step}: decided {json.dumps(act)[:120]}")
                trace.append({"step": step, "url": page.url, "action": act})
                a = act.get("action")
                obs_note = ""
                if a == "goto":
                    page.goto(act["url"], wait_until="load", timeout=30000)
                    obs_note = f'You navigated to {page.url}.'
                elif a == "type":
                    handles[act["index"]].fill(act.get("text", ""))
                    obs_note = (
                        f'You typed "{act.get("text", "")}" into element [{act["index"]}]. It now holds that value — '
                        "do NOT type it again; click the submit/search button next."
                    )
                elif a == "click":
                    handles[act["index"]].click(); page.wait_for_timeout(1500)
                    obs_note = f'You clicked element [{act["index"]}]. The page is now at {page.url}.'
                elif a == "read":
                    obs_note = f'You read element [{act["index"]}]: "{handles[act["index"]].inner_text()}"'
                elif a == "finish":
                    answer = act.get("answer", "")
                    break
            browser.close()
        log(f"run {run_id}: done answer={answer!r} steps={len(trace)}")
    except Exception as e:
        err = str(e)[:300]
        log(f"run {run_id}: ERROR {err}")
    return {"run_id": run_id, "output": answer or "", "steps": len(trace), "trace": trace, "error": err}
