"""Process-level introspection.

The gap this closes: sessions can look clean in the registry while Chrome trees survive underneath. This
is the read that shows both at once — every browser process, which session's profile it holds, and the
profile directories nobody claims.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request

from ...infrastructure.processes import describe_processes, orphan_profiles
from ..schemas import ProcessesResponse

router = APIRouter(tags=["debug"])


@router.get("/debug/processes", response_model=ProcessesResponse)
async def processes(request: Request) -> ProcessesResponse:
    config = request.app.state.config
    dirs = await request.app.state.service.profile_dirs()
    rows = await asyncio.to_thread(describe_processes, dirs)
    orphans = await asyncio.to_thread(orphan_profiles, list(dirs.values()), config.paths.user_data_root)
    return ProcessesResponse(processes=rows, orphan_profiles=[str(path) for path in orphans])
