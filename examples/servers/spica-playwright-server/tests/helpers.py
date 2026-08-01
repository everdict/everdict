"""Shared test fixtures — a config and an app wired to the real service, with no browser behind it."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI

from spica_playwright_server.api import errors as api_errors
from spica_playwright_server.api.routes import browsers, debug, health, state
from spica_playwright_server.config import CdpConfig, Config, Limits, Paths, RemoteModeConfig
from spica_playwright_server.core.registry import SessionRegistry
from spica_playwright_server.core.service import BrowserService


def build_config(tmp_path: Path, max_browsers: int = 2) -> Config:
    return Config(
        paths=Paths(extension_path=tmp_path / "ext", user_data_root=tmp_path / "profiles"),
        limits=Limits(max_browsers=max_browsers, session_timeout_minutes=15, cleanup_interval_minutes=1),
        remote_mode=RemoteModeConfig(
            panel_path="sidepanel.html",
            menu_selector="#menu",
            remote_view_selector="#remote",
            start_selector="#start",
            session_id_selector="[data-session-id]",
            activation_timeout_ms=5_000,
        ),
        cdp=CdpConfig(expose=False, port_base=9300, advertised_host="127.0.0.1"),
        browser_visible=False,
    )


def build_app(config: Config) -> tuple[FastAPI, SessionRegistry]:
    """The routes over the real service, without create_app's lifespan (which would start Playwright).
    playwright=None is safe: nothing asserted through this app reaches a launch."""
    registry = SessionRegistry(config.limits.max_browsers)
    service = BrowserService(None, config, registry)  # type: ignore[arg-type]
    app = FastAPI()
    api_errors.install(app)
    for module in (health, browsers, state, debug):
        app.include_router(module.router)
    app.state.config = config
    app.state.registry = registry
    app.state.service = service
    app.state.started_at = 0.0
    return app, registry
