"""Capacity + duplicate rules — the invariants that keep the cap honest. No browser is launched here."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest

from spica_playwright_server.core.errors import CapacityExceeded, DuplicateSession, SessionNotFound
from spica_playwright_server.core.registry import SessionRegistry
from spica_playwright_server.core.session import BrowserSession, SessionStatus


def session(session_id: str) -> BrowserSession:
    return BrowserSession(
        session_id=session_id,
        user_data_dir=Path(f"/tmp/{session_id}"),
        context=object(),  # type: ignore[arg-type] - the registry never touches the browser
        panel_page=object(),  # type: ignore[arg-type]
        work_page=None,
        created_at=time.time(),
    )


async def test_reservations_are_counted_so_concurrent_batches_cannot_overshoot_the_cap() -> None:
    registry = SessionRegistry(max_browsers=4)

    # Given two batches asking for 3 each, only one can be admitted — even though nothing is registered
    # yet, because a launch takes seconds and the second batch would otherwise pass the same check.
    await registry.reserve(3)
    with pytest.raises(CapacityExceeded):
        await registry.reserve(3)

    await registry.release(3)
    await registry.reserve(3)  # the slots came back


async def test_a_repeated_session_id_is_refused_rather_than_aliasing_two_browsers() -> None:
    registry = SessionRegistry(max_browsers=4)
    await registry.add(session("s1"))
    with pytest.raises(DuplicateSession):
        await registry.add(session("s1"))


async def test_shrinking_the_cap_below_what_is_running_is_refused() -> None:
    registry = SessionRegistry(max_browsers=4)
    await registry.add(session("s1"))
    await registry.add(session("s2"))

    with pytest.raises(CapacityExceeded):
        await registry.set_max_browsers(1)
    assert registry.max_browsers == 4  # unchanged — a cap that lies is worse than the old one

    await registry.set_max_browsers(2)  # exactly what is running is allowed
    assert registry.max_browsers == 2


async def test_reading_or_removing_an_unknown_session() -> None:
    registry = SessionRegistry(max_browsers=1)
    with pytest.raises(SessionNotFound):
        await registry.get("nope")
    assert await registry.remove("nope") is None


async def test_concurrent_reservations_never_exceed_the_cap() -> None:
    registry = SessionRegistry(max_browsers=5)
    results = await asyncio.gather(*(registry.reserve(2) for _ in range(5)), return_exceptions=True)
    admitted = [r for r in results if not isinstance(r, BaseException)]
    _, reserved = await registry.occupancy()
    assert reserved == len(admitted) * 2 <= 5


async def test_session_expiry_and_uptime_are_measured_from_creation() -> None:
    s = session("s1")
    s.created_at = time.time() - 120
    assert s.uptime_seconds() >= 120
    assert s.is_expired(timeout_seconds=60)
    assert not s.is_expired(timeout_seconds=600)
    assert s.status is SessionStatus.ACTIVE
