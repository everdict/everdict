"""Stop and sweep — what happens when a browser will not die, and who reclaims the slot."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from spica_playwright_server.core.errors import StopFailed
from spica_playwright_server.core.registry import SessionRegistry
from spica_playwright_server.core.service import BrowserService
from spica_playwright_server.core.session import BrowserSession, SessionStatus
from tests.helpers import build_config


class FakeContext:
    """A browser context that closes cleanly, or refuses to."""

    def __init__(self, *, refuse_close: bool = False, pages: int = 1) -> None:
        self.refuse_close = refuse_close
        self.pages = [object()] * pages
        self.closed = False

    async def close(self) -> None:
        if self.refuse_close:
            raise RuntimeError("target closed")
        self.closed = True
        self.pages = []


def make_service(tmp_path: Path, max_browsers: int = 4) -> tuple[BrowserService, SessionRegistry]:
    config = build_config(tmp_path, max_browsers=max_browsers)
    registry = SessionRegistry(max_browsers)
    return BrowserService(None, config, registry), registry  # type: ignore[arg-type]


async def add_session(
    registry: SessionRegistry, tmp_path: Path, session_id: str, context: FakeContext, age_seconds: float = 0.0
) -> BrowserSession:
    profile = tmp_path / "profiles" / session_id
    profile.mkdir(parents=True, exist_ok=True)
    session = BrowserSession(
        session_id=session_id,
        user_data_dir=profile,
        context=context,  # type: ignore[arg-type]
        panel_page=object(),  # type: ignore[arg-type]
        work_page=None,
        created_at=time.time() - age_seconds,
    )
    await registry.add(session)
    return session


async def test_a_clean_stop_removes_the_session_and_its_profile(tmp_path: Path) -> None:
    service, registry = make_service(tmp_path)
    context = FakeContext()
    session = await add_session(registry, tmp_path, "s1", context)

    await service.stop("s1")

    assert context.closed
    assert await registry.snapshot() == []
    # The profile directory is reclaimed — leaving them behind fills the disk one session at a time.
    assert not session.user_data_dir.exists()


async def test_a_browser_that_refuses_to_close_stays_registered_until_forced(tmp_path: Path) -> None:
    service, registry = make_service(tmp_path)
    session = await add_session(registry, tmp_path, "s1", FakeContext(refuse_close=True))

    with pytest.raises(StopFailed):
        await service.stop("s1")

    # Still registered on purpose: it is holding a slot and a profile lock, so deregistering it here
    # would leak a live browser that nothing can name any more.
    assert [s.session_id for s in await registry.snapshot()] == ["s1"]
    assert session.close_failure_count == 1
    assert session.status is SessionStatus.ZOMBIE
    assert session.last_error


async def test_force_drops_the_session_even_when_the_close_failed(tmp_path: Path) -> None:
    service, registry = make_service(tmp_path)
    session = await add_session(registry, tmp_path, "s1", FakeContext(refuse_close=True))

    await service.stop("s1", force=True)

    assert await registry.snapshot() == []
    assert session.close_failure_count == 1
    assert not session.user_data_dir.exists()


async def test_the_sweeper_reclaims_slots_from_timed_out_sessions(tmp_path: Path) -> None:
    service, registry = make_service(tmp_path)
    config_timeout = 15 * 60
    await add_session(registry, tmp_path, "fresh", FakeContext(), age_seconds=10)
    await add_session(registry, tmp_path, "stale", FakeContext(), age_seconds=config_timeout + 60)

    swept = await service.sweep()

    # Without this the cap silently shrinks: every abandoned session keeps a slot forever.
    assert swept == ["stale"]
    assert [s.session_id for s in await registry.snapshot()] == ["fresh"]


async def test_the_sweeper_also_reclaims_a_session_whose_browser_is_already_gone(tmp_path: Path) -> None:
    service, registry = make_service(tmp_path)
    await add_session(registry, tmp_path, "crashed", FakeContext(pages=0))

    assert await service.sweep() == ["crashed"]
    assert await registry.snapshot() == []


async def test_closing_everything_leaves_no_session_behind(tmp_path: Path) -> None:
    service, registry = make_service(tmp_path)
    await add_session(registry, tmp_path, "s1", FakeContext())
    await add_session(registry, tmp_path, "s2", FakeContext(refuse_close=True))

    await service.close_all()

    assert await registry.snapshot() == []
