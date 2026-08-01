"""Driving spica-client's side panel into remote mode and reading back the session id.

This is the part of the server that is not a Playwright wrapper. A caller asks for "a browser"; what it
gets back is an id the extension issued, which is only produced by walking the panel UI:

    open the panel -> menu -> remote view -> start -> a work tab opens -> the panel shows the id

Every step is a selector from config, so a panel redesign is an env change. Failures name the step and
the selector, because "activation failed" without that is unactionable in a container with no display.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional

from ..config import RemoteModeConfig
from ..core.errors import ActivationFailed

if TYPE_CHECKING:
    from playwright.async_api import BrowserContext, Page

SESSION_ID_ATTRIBUTE = "data-session-id"


@dataclass
class RemoteSession:
    session_id: str
    panel_page: "Page"
    work_page: Optional["Page"]


async def _click(page: "Page", selector: str, step: str, timeout_ms: int) -> None:
    try:
        await page.locator(selector).first.click(timeout=timeout_ms)
    except Exception as exc:
        raise ActivationFailed(
            f"Remote-mode activation stalled at '{step}'.", step=step, selector=selector, cause=str(exc)
        ) from exc


async def _read_session_id(panel: "Page", selector: str, timeout_ms: int) -> str:
    """The id is read from an attribute when the panel exposes one, else from the element's text —
    an attribute survives copy/formatting changes that would break a text read."""
    locator = panel.locator(selector).first
    try:
        await locator.wait_for(state="attached", timeout=timeout_ms)
        value = await locator.get_attribute(SESSION_ID_ATTRIBUTE)
        if not value:
            value = await locator.inner_text()
    except Exception as exc:
        raise ActivationFailed(
            "Remote mode started but the panel never showed a session id.",
            step="read_session_id",
            selector=selector,
            cause=str(exc),
        ) from exc
    session_id = (value or "").strip()
    if not session_id:
        raise ActivationFailed(
            "The panel's session id element is empty.", step="read_session_id", selector=selector
        )
    return session_id


async def activate(context: "BrowserContext", extension_id: str, cfg: RemoteModeConfig) -> RemoteSession:
    timeout = cfg.activation_timeout_ms
    panel = await context.new_page()
    panel_url = f"chrome-extension://{extension_id}/{cfg.panel_path.lstrip('/')}"
    try:
        await panel.goto(panel_url, timeout=timeout)
    except Exception as exc:
        raise ActivationFailed(
            "Could not open the extension's side panel — is the extension loaded under this id?",
            step="open_panel",
            url=panel_url,
            cause=str(exc),
        ) from exc

    await _click(panel, cfg.menu_selector, "open_menu", timeout)
    await _click(panel, cfg.remote_view_selector, "open_remote_view", timeout)

    # The start click is what opens the work tab, so the wait has to be armed before the click — a tab
    # that opens between the click and a later wait would never be seen.
    work_page: Optional["Page"] = None
    try:
        async with context.expect_page(timeout=timeout) as opened:
            await _click(panel, cfg.start_selector, "start_remote_mode", timeout)
        work_page = await opened.value
    except ActivationFailed:
        raise
    except Exception:
        # Remote mode may report its id without opening a tab; the id, not the tab, is what a caller
        # asked for, so keep going and let the read below decide whether activation actually worked.
        work_page = None

    session_id = await _read_session_id(panel, cfg.session_id_selector, timeout)
    return RemoteSession(session_id=session_id, panel_page=panel, work_page=work_page)
