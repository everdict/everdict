"""Browser session use-cases — start a batch, stop one, navigate, report.

The batch is the interesting case. Starting eight browsers is eight independent multi-second launches,
any of which can fail; a partial batch is worse than none, because the caller asked for eight parallel
agents and would otherwise have to discover the shortfall itself. So a failed batch rolls back to zero.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import time
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Optional
from urllib.parse import urlparse

from ..config import Config
from ..infrastructure import cdp as cdp_bridge
from ..infrastructure.browser_launcher import LaunchSpec, launch
from ..infrastructure.extension import resolve_extension_id
from ..infrastructure.processes import kill_profile_browsers
from ..infrastructure.remote_mode import activate
from .errors import ActivationFailed, InvalidRequest, SpicaServerError, StopFailed
from .registry import SessionRegistry
from .session import BrowserSession, SessionStatus

if TYPE_CHECKING:
    from playwright.async_api import Playwright

log = logging.getLogger(__name__)

ALLOWED_SCHEMES = {"http", "https"}
CLOSE_TIMEOUT_SECONDS = 15.0


class BrowserService:
    def __init__(self, playwright: "Playwright", config: Config, registry: SessionRegistry) -> None:
        self._playwright = playwright
        self._config = config
        self._registry = registry

    # --- reads -------------------------------------------------------------------------------------

    async def get(self, session_id: str) -> BrowserSession:
        return await self._registry.get(session_id)

    async def list(self) -> list[BrowserSession]:
        return await self._registry.snapshot()

    async def profile_dirs(self) -> dict[str, Path]:
        return {session.session_id: session.user_data_dir for session in await self._registry.snapshot()}

    # --- start -------------------------------------------------------------------------------------

    async def start(self, count: int) -> list[BrowserSession]:
        if count < 1:
            raise InvalidRequest("count must be at least 1.", count=count)
        await self._registry.reserve(count)
        try:
            results = await asyncio.gather(
                *(self._start_one() for _ in range(count)), return_exceptions=True
            )
            failures = [r for r in results if isinstance(r, BaseException)]
            started = [r for r in results if isinstance(r, BrowserSession)]
            if failures:
                await self._rollback(started)
                first = failures[0]
                raise first if isinstance(first, SpicaServerError) else ActivationFailed(str(first))
            try:
                # Registration is part of the batch: a duplicate id means the extension handed the same
                # session to two browsers, which would alias them for every later call. It also has to
                # roll back like any other batch failure — the browsers are already running.
                for session in started:
                    await self._registry.add(session)
            except Exception:
                await self._rollback(started)
                raise
            return started
        finally:
            await self._registry.release(count)

    async def _start_one(self) -> BrowserSession:
        # The profile directory cannot be named after the session: the id only exists once remote mode
        # has been walked, and a live Chrome profile cannot be renamed underneath it.
        user_data_dir = self._config.paths.user_data_root / f"profile-{uuid.uuid4().hex[:12]}"
        cdp_port = cdp_bridge.free_port() if self._config.cdp.expose else None
        context = None
        endpoint: Optional[cdp_bridge.CdpEndpoint] = None
        try:
            context = await launch(
                self._playwright,
                LaunchSpec(
                    user_data_dir=user_data_dir,
                    extension_path=self._config.paths.extension_path,
                    visible=self._config.browser_visible,
                    cdp_port=cdp_port,
                ),
            )
            extension_id = await resolve_extension_id(
                context, self._config.paths.extension_path, self._config.remote_mode.activation_timeout_ms
            )
            remote = await activate(context, extension_id, self._config.remote_mode)
            if cdp_port is not None:
                # No preferred port. Handing every session the same base means a closed session's address is
                # immediately handed to the next one, and an observer holding that address then watches a
                # DIFFERENT case's browser — one case's screen and network trace attributed to another, which is
                # worse than no observability at all.
                endpoint = await cdp_bridge.publish(cdp_port, self._config.cdp.advertised_host)
            session = BrowserSession(
                session_id=remote.session_id,
                user_data_dir=user_data_dir,
                context=context,
                panel_page=remote.panel_page,
                work_page=remote.work_page,
                created_at=time.time(),
                status=SessionStatus.ACTIVE,
                cdp_port=endpoint.published_port if endpoint else None,
                cdp_url=endpoint.url if endpoint else None,
            )
            if endpoint is not None:
                session.resources["cdp_endpoint"] = endpoint
            return session
        except Exception:
            if endpoint is not None:
                await endpoint.close()
            await self._teardown(context, user_data_dir)
            raise

    async def _rollback(self, started: list[BrowserSession]) -> None:
        for session in started:
            await self._registry.remove(session.session_id)
            await self._destroy(session, force=True)

    # --- stop --------------------------------------------------------------------------------------

    async def stop(self, session_id: str, force: bool = False) -> BrowserSession:
        session = await self._registry.get(session_id)
        session.status = SessionStatus.CLOSING
        closed = await self._destroy(session, force=force)
        if closed or force:
            await self._registry.remove(session_id)
            return session
        # A stop that did not stop anything must not deregister the session: the browser is still
        # holding a slot and a profile lock, and forgetting it here is how a container leaks browsers
        # invisibly. The caller retries with ?force=true, which kills the tree.
        session.status = SessionStatus.ZOMBIE
        raise StopFailed(
            "The browser did not close; retry with force=true to kill it.",
            session_id=session_id,
            close_failure_count=session.close_failure_count,
            last_error=session.last_error,
        )

    async def _destroy(self, session: BrowserSession, *, force: bool) -> bool:
        """Close the browser and reclaim its profile. Returns whether it is actually gone."""
        try:
            await asyncio.wait_for(session.context.close(), timeout=CLOSE_TIMEOUT_SECONDS)
            gone = True
        except Exception as exc:
            session.close_failure_count += 1
            session.last_error = str(exc)
            log.warning("graceful close failed for %s: %s", session.session_id, exc)
            gone = False
        endpoint = session.resources.pop("cdp_endpoint", None)
        if isinstance(endpoint, cdp_bridge.CdpEndpoint):
            await endpoint.close()
        if not gone and not force:
            return False
        # Backstop even after a clean close: Chrome occasionally leaves a child behind, and the profile
        # is unusable (and the disk unreclaimed) until the whole tree is gone.
        await asyncio.to_thread(kill_profile_browsers, session.user_data_dir)
        await asyncio.to_thread(shutil.rmtree, session.user_data_dir, True)
        return True

    async def close_all(self) -> None:
        for session in await self._registry.snapshot():
            await self._registry.remove(session.session_id)
            await self._destroy(session, force=True)

    # --- act ---------------------------------------------------------------------------------------

    async def navigate(self, session_id: str, url: str) -> str:
        scheme = urlparse(url).scheme.lower()
        if scheme not in ALLOWED_SCHEMES:
            # Anything else reaches inside the container (file://, chrome://, chrome-extension://) —
            # navigation is a caller-supplied string, so the allowlist is the boundary.
            raise InvalidRequest("Only http and https URLs may be navigated to.", url=url, scheme=scheme)
        session = await self._registry.get(session_id)
        page = session.target_page()
        try:
            await page.goto(url)
        except Exception as exc:
            raise SpicaServerError("Navigation failed.", session_id=session_id, url=url, cause=str(exc)) from exc
        return page.url

    # --- maintenance -------------------------------------------------------------------------------

    async def sweep(self) -> list[str]:
        """Force-remove sessions past their timeout or whose browser is already gone. Returns their ids.

        A timed-out session is not merely idle — it is holding one of a small number of slots, so the
        cap silently shrinks until the container can serve nobody. Sweeping is what keeps the advertised
        capacity true.
        """
        timeout_seconds = self._config.limits.session_timeout_seconds
        now = time.time()
        swept: list[str] = []
        for session in await self._registry.snapshot():
            expired = session.is_expired(timeout_seconds, now)
            dead = self._looks_dead(session)
            if not (expired or dead):
                continue
            session.status = SessionStatus.ZOMBIE
            await self._registry.remove(session.session_id)
            await self._destroy(session, force=True)
            swept.append(session.session_id)
            log.info("swept session %s (expired=%s dead=%s)", session.session_id, expired, dead)
        return swept

    @staticmethod
    def _looks_dead(session: BrowserSession) -> bool:
        """A session with no pages left has lost its browser. Reading `pages` on an already-closed
        context raises, which is the same verdict — so both answer 'dead'."""
        if session.status is SessionStatus.STARTING:
            return False
        try:
            return not session.context.pages
        except Exception:
            return True

    async def _teardown(self, context, user_data_dir: Path) -> None:
        if context is not None:
            try:
                await asyncio.wait_for(context.close(), timeout=CLOSE_TIMEOUT_SECONDS)
            except Exception:  # the kill below is the real cleanup
                pass
        await asyncio.to_thread(kill_profile_browsers, user_data_dir)
        await asyncio.to_thread(shutil.rmtree, user_data_dir, True)
