"""Request/response models. Field names are the wire contract — keep them stable."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class SessionView(BaseModel):
    session_id: str
    status: str
    uptime_seconds: float
    close_failure_count: int
    created_at: float
    user_data_dir: str
    # Present only when SPICA_CDP_EXPOSE=1: the address an outside observer can attach to. This is the
    # field a watcher (e.g. Everdict's `acquire.cdpBase`) reads to look at what the session is doing.
    cdp_url: Optional[str] = None


class StartBrowserRequest(BaseModel):
    count: int = Field(default=1, ge=1, description="How many browsers to start as one all-or-nothing batch.")


class StartBrowserResponse(BaseModel):
    session_ids: list[str]
    sessions: list[SessionView]


class StopBrowserResponse(BaseModel):
    session_id: str
    stopped: bool
    forced: bool


class NavigateRequest(BaseModel):
    session_id: str
    url: str = Field(description="Absolute http:// or https:// URL.")


class NavigateResponse(BaseModel):
    session_id: str
    url: str


class BrowsersResponse(BaseModel):
    count: int
    sessions: list[SessionView]


class HealthResponse(BaseModel):
    status: str
    uptime_seconds: float
    active_browsers: int
    reserved: int
    max_browsers: int


class StateResponse(BaseModel):
    max_browsers: int
    session_timeout_minutes: int
    cleanup_interval_minutes: int
    active_browsers: int
    reserved: int
    extension_path: str
    user_data_dir: str
    cdp_exposed: bool


class StatePatchRequest(BaseModel):
    max_browsers: Optional[int] = Field(default=None, ge=1)
    session_timeout_minutes: Optional[int] = Field(default=None, ge=1)
    cleanup_interval_minutes: Optional[int] = Field(default=None, ge=1)


class ProcessesResponse(BaseModel):
    processes: list[dict]
    orphan_profiles: list[str]


class ErrorResponse(BaseModel):
    code: str
    message: str
    details: dict = Field(default_factory=dict)
