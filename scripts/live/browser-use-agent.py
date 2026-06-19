# 라이브: 실 browser-use 라이브러리(자율 멀티스텝 브라우저 에이전트)를 우리 모델(gpt-5.4-mini via LiteLLM)+
# CDP 브라우저(chromedp)로 구동한다. 에이전트가 스스로 navigate/extract 를 반복해 과업을 수행 → 결과/스텝 출력.
# 환경: OPENAI_API_KEY, OPENAI_BASE_URL(LiteLLM, OpenAI 호환), CDP_URL, BU_MODEL, BU_TASK, BU_MAX_STEPS.
# 사용: <venv>/bin/python scripts/live/browser-use-agent.py   (browser-use 0.13.x 필요)
import asyncio
import json
import os

from browser_use import Agent, BrowserSession, ChatOpenAI

API_KEY = os.environ["OPENAI_API_KEY"]
BASE_URL = os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:4000/v1")
CDP_URL = os.environ.get("CDP_URL", "http://127.0.0.1:9222")
MODEL = os.environ.get("BU_MODEL", "gpt-5.4-mini")
TASK = os.environ.get(
    "BU_TASK",
    "Go to https://example.com and return the exact text of the page's main heading (the h1). Then finish.",
)
MAX_STEPS = int(os.environ.get("BU_MAX_STEPS", "6"))


async def main():
    llm_timeout = int(os.environ.get("BU_LLM_TIMEOUT", "75"))  # 느린 LiteLLM 엔드포인트면 늘린다
    step_timeout = int(os.environ.get("BU_STEP_TIMEOUT", "180"))
    no_struct = os.environ.get("BU_NO_STRUCT", "") == "1"  # 강제 structured-output 비활성(느린 경로 회피 시도)
    llm = ChatOpenAI(
        model=MODEL,
        base_url=BASE_URL,
        api_key=API_KEY,
        timeout=llm_timeout + 30,
        dont_force_structured_output=no_struct,
    )
    session = BrowserSession(cdp_url=CDP_URL)  # 기존 chromedp CDP 에 연결(자체 브라우저 미기동)
    agent = Agent(  # gpt-5.4-mini = DOM-only(use_vision=False)
        task=TASK,
        llm=llm,
        browser_session=session,
        use_vision=False,
        llm_timeout=llm_timeout,
        step_timeout=step_timeout,
    )
    history = await agent.run(max_steps=MAX_STEPS)
    print(
        "BU_RESULT="
        + json.dumps(
            {
                "final": history.final_result(),
                "steps": history.number_of_steps(),
                "actions": history.action_names(),
                "urls": [u for u in history.urls() if u],
                "done": history.is_done() if hasattr(history, "is_done") else None,
            },
            ensure_ascii=False,
        )
    )


asyncio.run(main())
