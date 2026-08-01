"""Browser session routes — start a batch, stop one, navigate, read status."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from ...core.session import BrowserSession
from ..schemas import (
    BrowsersResponse,
    NavigateRequest,
    NavigateResponse,
    SessionView,
    StartBrowserRequest,
    StartBrowserResponse,
    StopBrowserResponse,
)

router = APIRouter(tags=["browsers"])


def view(session: BrowserSession) -> SessionView:
    return SessionView(
        session_id=session.session_id,
        status=session.status.value,
        uptime_seconds=round(session.uptime_seconds(), 3),
        close_failure_count=session.close_failure_count,
        created_at=session.created_at,
        user_data_dir=str(session.user_data_dir),
        cdp_url=session.cdp_url,
    )


@router.post("/start-browser", response_model=StartBrowserResponse)
async def start_browser(body: StartBrowserRequest, request: Request) -> StartBrowserResponse:
    sessions = await request.app.state.service.start(body.count)
    return StartBrowserResponse(
        session_ids=[s.session_id for s in sessions], sessions=[view(s) for s in sessions]
    )


@router.post("/stop-browser/{session_id}", response_model=StopBrowserResponse)
async def stop_browser(
    session_id: str,
    request: Request,
    force: bool = Query(default=False, description="Kill the browser tree and drop the session even if it will not close."),
) -> StopBrowserResponse:
    await request.app.state.service.stop(session_id, force=force)
    return StopBrowserResponse(session_id=session_id, stopped=True, forced=force)


@router.post("/navigate", response_model=NavigateResponse)
async def navigate(body: NavigateRequest, request: Request) -> NavigateResponse:
    url = await request.app.state.service.navigate(body.session_id, body.url)
    return NavigateResponse(session_id=body.session_id, url=url)


@router.get("/status/{session_id}", response_model=SessionView)
async def status(session_id: str, request: Request) -> SessionView:
    return view(await request.app.state.service.get(session_id))


@router.get("/browsers", response_model=BrowsersResponse)
async def browsers(request: Request) -> BrowsersResponse:
    sessions = await request.app.state.service.list()
    return BrowsersResponse(count=len(sessions), sessions=[view(s) for s in sessions])
