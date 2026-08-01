"""App composition — the only place the layers are wired together."""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from playwright.async_api import async_playwright

from ..config import Config
from ..core.cleanup import CleanupLoop
from ..core.registry import SessionRegistry
from ..core.service import BrowserService
from . import errors
from .routes import browsers, debug, health, state

log = logging.getLogger(__name__)


def create_app(config: Config | None = None) -> FastAPI:
    config = config or Config.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        config.paths.user_data_root.mkdir(parents=True, exist_ok=True)
        registry = SessionRegistry(config.limits.max_browsers)
        async with async_playwright() as playwright:
            service = BrowserService(playwright, config, registry)
            cleanup = CleanupLoop(service, config.limits)
            app.state.config = config
            app.state.registry = registry
            app.state.service = service
            app.state.started_at = time.time()
            cleanup.start()
            log.info(
                "spica-playwright-server ready — extension=%s max_browsers=%d timeout=%dm",
                config.paths.extension_path,
                config.limits.max_browsers,
                config.limits.session_timeout_minutes,
            )
            try:
                yield
            finally:
                # Order matters: stop sweeping first so it cannot race the shutdown, then take every
                # browser down. A container that exits with Chrome trees alive leaks them to the host.
                await cleanup.stop()
                await service.close_all()

    app = FastAPI(
        title="spica-playwright-server",
        version="0.1.0",
        summary="Start extension-loaded browsers, auto-activate spica remote mode, hand back session ids.",
        lifespan=lifespan,
    )
    errors.install(app)
    app.include_router(health.router)
    app.include_router(browsers.router)
    app.include_router(state.router)
    app.include_router(debug.router)
    return app
