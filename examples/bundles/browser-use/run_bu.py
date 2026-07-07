"""browser-use eval entrypoint for Everdict (command harness).

Runs one web task with browser-use against an OpenAI-compatible endpoint
(OPENAI_API_BASE / OPENAI_API_KEY — e.g. a LiteLLM proxy) and prints the
agent's final result to stdout. Everdict's trace:none extraction turns the
stdout tail into the final assistant message, which answer/judge graders read.

Pinned against browser-use 0.13.x (ChatOpenAI top-level export, BrowserProfile
executable_path/headless/chromium_sandbox, Agent(browser_profile=, use_vision=)).
"""

import argparse
import asyncio
import os
import sys


def build_llm(model: str):
    from browser_use import ChatOpenAI

    base_url = os.environ.get("OPENAI_API_BASE") or os.environ.get("OPENAI_BASE_URL")
    kwargs = {"model": model, "api_key": os.environ.get("OPENAI_API_KEY", "sk-noop")}
    if base_url:
        kwargs["base_url"] = base_url
    return ChatOpenAI(**kwargs)


def build_profile():
    from browser_use.browser.profile import BrowserProfile

    executable = os.environ.get("BROWSER_USE_EXECUTABLE_PATH", "/usr/bin/chromium")
    return BrowserProfile(
        executable_path=executable,
        headless=True,
        chromium_sandbox=False,  # root inside the eval container
        args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    )


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("task")
    parser.add_argument("--model", default="gpt-5.4-mini")
    parser.add_argument("--max-steps", type=int, default=20)
    args = parser.parse_args()

    from browser_use import Agent

    use_vision = os.environ.get("BU_USE_VISION", "false").lower() == "true"
    agent = Agent(
        task=args.task,
        llm=build_llm(args.model),
        browser_profile=build_profile(),
        use_vision=use_vision,
    )
    history = await agent.run(max_steps=args.max_steps)

    final = None
    final_fn = getattr(history, "final_result", None)
    if callable(final_fn):
        final = final_fn()
    steps_fn = getattr(history, "number_of_steps", None)
    success_fn = getattr(history, "is_successful", None)

    print("\n=== BROWSER_USE_RESULT ===")
    print(f"final_result: {final if final is not None else '(none)'}")
    if callable(steps_fn):
        print(f"steps: {steps_fn()}")
    if callable(success_fn):
        print(f"self_reported_success: {success_fn()}")
    print("=== END_RESULT ===")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
