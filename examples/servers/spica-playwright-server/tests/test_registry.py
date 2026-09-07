"""Capacity + duplicate rules — the invariants that keep the cap honest. No browser is launched here."""

from __future__ import annotations

import contextlib
import inspect
import sys
from pathlib import Path

# Executed as a script by `pnpm python`, not collected by a runner that would have arranged the path.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import asyncio
import time
from pathlib import Path


from spica_playwright_server.core.errors import CapacityExceeded, DuplicateSession, SessionNotFound
from spica_playwright_server.core.registry import SessionRegistry
from spica_playwright_server.core.session import BrowserSession, SessionStatus


@contextlib.contextmanager
def raises(exc_type):
    """`pytest.raises`, in the standard library. Yields a holder whose `.value` is the caught exception."""
    holder = type("Raised", (), {"value": None})()
    try:
        yield holder
    except exc_type as err:  # noqa: PERF203 — one guarded block, not a loop
        holder.value = err
        return
    raise AssertionError(f"expected {exc_type.__name__} and nothing was raised")


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
    with raises(CapacityExceeded):
        await registry.reserve(3)

    await registry.release(3)
    await registry.reserve(3)  # the slots came back


async def test_a_repeated_session_id_is_refused_rather_than_aliasing_two_browsers() -> None:
    registry = SessionRegistry(max_browsers=4)
    await registry.add(session("s1"))
    with raises(DuplicateSession):
        await registry.add(session("s1"))


async def test_shrinking_the_cap_below_what_is_running_is_refused() -> None:
    registry = SessionRegistry(max_browsers=4)
    await registry.add(session("s1"))
    await registry.add(session("s2"))

    with raises(CapacityExceeded):
        await registry.set_max_browsers(1)
    assert registry.max_browsers == 4  # unchanged — a cap that lies is worse than the old one

    await registry.set_max_browsers(2)  # exactly what is running is allowed
    assert registry.max_browsers == 2


async def test_reading_or_removing_an_unknown_session() -> None:
    registry = SessionRegistry(max_browsers=1)
    with raises(SessionNotFound):
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


if __name__ == "__main__":
    # Collect and run every test in this module, awaiting the async ones. A failure exits non-zero, which is
    # what `pnpm python` reads; names are printed so a red run says WHICH claim broke.
    import asyncio as _asyncio

    failures = 0
    for _name, _fn in sorted(dict(globals()).items()):
        if not _name.startswith("test_") or not callable(_fn):
            continue
        try:
            _result = _fn()
            if inspect.isawaitable(_result):
                _asyncio.run(_result)
            print(f"  ok   {_name}")
        except Exception as _err:  # noqa: BLE001 — a test runner reports, it does not re-raise
            failures += 1
            print(f"  FAIL {_name}: {type(_err).__name__}: {_err}")
    _ran = sum(1 for _n, _f in globals().items() if _n.startswith("test_") and callable(_f))
    print(f"{'FAIL' if failures else 'PASS'} {Path(__file__).name}: {_ran} test(s), {failures} failure(s)")
    sys.exit(1 if failures else 0)
