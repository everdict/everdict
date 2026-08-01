"""The session registry — the single place that decides how many browsers may exist.

Capacity is reserved BEFORE a browser is launched, because a launch takes seconds (profile creation +
extension load + the remote-mode click-through) and the session id only exists at the very end. Counting
registered sessions alone would let two concurrent batch requests both pass the check and then both
launch, overshooting the cap by a whole batch.
"""

from __future__ import annotations

import asyncio

from .errors import CapacityExceeded, DuplicateSession, SessionNotFound
from .session import BrowserSession


class SessionRegistry:
    def __init__(self, max_browsers: int) -> None:
        self._sessions: dict[str, BrowserSession] = {}
        self._reserved = 0
        self._max_browsers = max_browsers
        self._lock = asyncio.Lock()

    @property
    def max_browsers(self) -> int:
        return self._max_browsers

    async def snapshot(self) -> list[BrowserSession]:
        async with self._lock:
            return list(self._sessions.values())

    async def occupancy(self) -> tuple[int, int]:
        """(registered, reserved-but-not-yet-registered) — what /health and /state report."""
        async with self._lock:
            return len(self._sessions), self._reserved

    async def reserve(self, count: int) -> None:
        """Claim `count` slots or raise. Every reserve MUST be paired with a release (see release())."""
        async with self._lock:
            in_use = len(self._sessions) + self._reserved
            if in_use + count > self._max_browsers:
                raise CapacityExceeded(
                    "Not enough capacity for the requested browsers.",
                    requested=count,
                    active=len(self._sessions),
                    reserved=self._reserved,
                    max_browsers=self._max_browsers,
                )
            self._reserved += count

    async def release(self, count: int) -> None:
        """Give back slots that were reserved. Called for every reserved slot — whether the launch
        failed or succeeded (a successful launch converts its reservation into a registration)."""
        async with self._lock:
            self._reserved = max(0, self._reserved - count)

    async def add(self, session: BrowserSession) -> None:
        async with self._lock:
            if session.session_id in self._sessions:
                raise DuplicateSession(
                    "A session with this id is already registered.", session_id=session.session_id
                )
            self._sessions[session.session_id] = session

    async def get(self, session_id: str) -> BrowserSession:
        async with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise SessionNotFound("No such session.", session_id=session_id)
        return session

    async def remove(self, session_id: str) -> BrowserSession | None:
        async with self._lock:
            return self._sessions.pop(session_id, None)

    async def set_max_browsers(self, value: int) -> None:
        """Resize the cap. Shrinking below what is already running is refused rather than applied
        lazily: a cap that does not describe the current state is worse than no cap, because the next
        reader believes it."""
        async with self._lock:
            in_use = len(self._sessions) + self._reserved
            if value < in_use:
                raise CapacityExceeded(
                    "The new cap is below the number of browsers already running.",
                    requested_max=value,
                    active=len(self._sessions),
                    reserved=self._reserved,
                )
            self._max_browsers = value
