"""Server settings — read, and change at runtime."""

from __future__ import annotations

from fastapi import APIRouter, Request

from ..schemas import StatePatchRequest, StateResponse

router = APIRouter(tags=["state"])


async def _state(request: Request) -> StateResponse:
    config = request.app.state.config
    registry = request.app.state.registry
    active, reserved = await registry.occupancy()
    return StateResponse(
        max_browsers=registry.max_browsers,
        session_timeout_minutes=config.limits.session_timeout_minutes,
        cleanup_interval_minutes=config.limits.cleanup_interval_minutes,
        active_browsers=active,
        reserved=reserved,
        extension_path=str(config.paths.extension_path),
        user_data_dir=str(config.paths.user_data_root),
        cdp_exposed=config.cdp.expose,
    )


@router.get("/state", response_model=StateResponse)
async def get_state(request: Request) -> StateResponse:
    return await _state(request)


@router.patch("/state", response_model=StateResponse)
async def patch_state(body: StatePatchRequest, request: Request) -> StateResponse:
    config = request.app.state.config
    registry = request.app.state.registry
    if body.max_browsers is not None:
        # The registry owns the cap because it owns the count — it refuses (409) a cap below what is
        # already running rather than leaving the advertised limit disagreeing with reality.
        await registry.set_max_browsers(body.max_browsers)
        config.limits.max_browsers = body.max_browsers
    if body.session_timeout_minutes is not None:
        config.limits.session_timeout_minutes = body.session_timeout_minutes
    if body.cleanup_interval_minutes is not None:
        # Picked up on the sweeper's next tick, so a shortened interval takes at most one old interval.
        config.limits.cleanup_interval_minutes = body.cleanup_interval_minutes
    return await _state(request)
