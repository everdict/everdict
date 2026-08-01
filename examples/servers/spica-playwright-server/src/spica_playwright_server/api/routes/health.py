"""Liveness — also the container healthcheck, so it must stay cheap and never touch a browser."""

from __future__ import annotations

import time

from fastapi import APIRouter, Request

from ..schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    registry = request.app.state.registry
    active, reserved = await registry.occupancy()
    return HealthResponse(
        status="ok",
        uptime_seconds=round(time.time() - request.app.state.started_at, 3),
        active_browsers=active,
        reserved=reserved,
        max_browsers=registry.max_browsers,
    )
