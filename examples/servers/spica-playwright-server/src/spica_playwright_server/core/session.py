"""The session aggregate — one extension-loaded browser, addressed by the id its remote mode issued."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:  # playwright types are only needed for annotations
    from playwright.async_api import BrowserContext, Page


class SessionStatus(str, Enum):
    STARTING = "starting"
    ACTIVE = "active"
    CLOSING = "closing"
    # Past its timeout or backed by a browser that is gone: it still occupies a slot, so the cleanup
    # loop force-removes it rather than waiting for a well-behaved stop that is never coming.
    ZOMBIE = "zombie"


@dataclass
class BrowserSession:
    session_id: str
    user_data_dir: Path
    context: "BrowserContext"
    panel_page: "Page"
    work_page: Optional["Page"]
    created_at: float
    status: SessionStatus = SessionStatus.ACTIVE
    # How many times a graceful close failed. Surfaced on the status read because a session that will
    # not die is the signal that the container is leaking browsers, and it is otherwise invisible.
    close_failure_count: int = 0
    last_error: Optional[str] = None
    cdp_port: Optional[int] = None
    cdp_url: Optional[str] = None
    # Side processes the session owns and must take down with it (currently the CDP forwarder). Keyed
    # rather than typed so infrastructure can attach things core does not need to know about.
    resources: dict[str, object] = field(default_factory=dict)

    def uptime_seconds(self, now: Optional[float] = None) -> float:
        return max(0.0, (now if now is not None else time.time()) - self.created_at)

    def is_expired(self, timeout_seconds: float, now: Optional[float] = None) -> bool:
        return self.uptime_seconds(now) > timeout_seconds

    def target_page(self) -> "Page":
        """Where navigation goes: the work tab remote mode opened, falling back to the panel page only
        when the work tab is gone (navigating the panel at least fails visibly instead of silently)."""
        page = self.work_page
        if page is not None and not page.is_closed():
            return page
        return self.panel_page
