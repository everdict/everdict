"""The background sweeper.

Callers crash, networks drop, agents hang — so "the client will stop its browser" cannot be the only way
a slot comes back. This loop is what makes the concurrency cap a real limit rather than a high-water mark.
"""

from __future__ import annotations

import asyncio
import logging

from ..config import Limits
from .service import BrowserService

log = logging.getLogger(__name__)


class CleanupLoop:
    def __init__(self, service: BrowserService, limits: Limits) -> None:
        self._service = service
        self._limits = limits
        self._task: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()

    def start(self) -> None:
        if self._task is None:
            self._stopping.clear()
            self._task = asyncio.create_task(self._run(), name="spica-cleanup")

    async def stop(self) -> None:
        self._stopping.set()
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _run(self) -> None:
        while not self._stopping.is_set():
            # Read the interval each pass so PATCH /state takes effect on the next tick rather than
            # after a restart.
            interval = self._limits.cleanup_interval_seconds
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=interval)
                return  # stop() was requested
            except asyncio.TimeoutError:
                pass
            try:
                swept = await self._service.sweep()
                if swept:
                    log.info("cleanup swept %d session(s): %s", len(swept), ", ".join(swept))
            except Exception as exc:  # a sweep failure must not end the loop — it runs forever by design
                log.warning("cleanup pass failed: %s", exc)
