"""Capture the browser-use Chromium's current screen as a base64 PNG on stdout — Everdict live screen.

Everdict's self-hosted runner execs this in the case container every couple of seconds while the agent runs
(harness liveScreen.captureCmd); the frame is pushed to the control plane and shown on the run detail page.

It attaches to the agent's already-running Chromium over CDP (run_bu.py launches it with
--remote-debugging-port=9222) using Playwright's connect_over_cdp — a read-only screenshot of the page the agent
is already driving. CDP permits multiple clients, and this never closes the browser, so the agent is undisturbed.

Best-effort by contract: any failure (browser not up yet, no page, port mismatch) prints nothing and exits
non-zero. Everdict treats a non-zero/empty capture as "no frame this tick" — the eval outcome is never affected.
"""

import base64
import os
import sys


def main() -> int:
    port = os.environ.get("BU_CDP_PORT", "9222")
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        return 1
    try:
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
            # The page the agent is driving — the first page of the first context. connect_over_cdp only attaches, so
            # we must NOT close the browser (that would tear down the agent's session); we just read one screenshot.
            context = browser.contexts[0] if browser.contexts else None
            page = context.pages[0] if context and context.pages else None
            if page is None:
                return 1
            png = page.screenshot(type="png")
    except Exception:
        return 1
    if not png:
        return 1
    sys.stdout.write(base64.b64encode(png).decode("ascii"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
