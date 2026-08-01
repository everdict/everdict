"""Server configuration — env-derived, with the three operator knobs kept mutable at runtime."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_EXTENSION_PATH = "/ext"
DEFAULT_USER_DATA_DIR = "/tmp/spica-profiles"
DEFAULT_MAX_CONCURRENT_BROWSERS = 8
DEFAULT_SESSION_TIMEOUT_MINUTES = 15
DEFAULT_CLEANUP_INTERVAL_MINUTES = 1
DEFAULT_CDP_PORT_BASE = 9300


def _int_env(name: str, default: int, *, minimum: int = 1) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc
    if value < minimum:
        raise ValueError(f"{name} must be >= {minimum}, got {value}")
    return value


def _bool_env(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Paths:
    """Filesystem layout. Each session gets its own profile directory under `user_data_root`:
    Chrome takes an exclusive lock on a profile, so sharing one across concurrent browsers fails."""

    extension_path: Path
    user_data_root: Path


@dataclass
class Limits:
    """The knobs `PATCH /state` may change while the server runs."""

    max_browsers: int
    session_timeout_minutes: int
    cleanup_interval_minutes: int

    @property
    def session_timeout_seconds(self) -> float:
        return self.session_timeout_minutes * 60.0

    @property
    def cleanup_interval_seconds(self) -> float:
        return self.cleanup_interval_minutes * 60.0


@dataclass(frozen=True)
class RemoteModeConfig:
    """Where the session id lives in spica-client's side panel.

    These selectors are the ONE thing that has to track the extension's UI. They are configurable so a
    panel redesign is an env change rather than a server release; the defaults describe the flow this
    server was written against (menu -> remote view -> start -> a work tab opens).
    """

    panel_path: str
    menu_selector: str
    remote_view_selector: str
    start_selector: str
    session_id_selector: str
    activation_timeout_ms: int


@dataclass(frozen=True)
class CdpConfig:
    """Per-session Chrome DevTools Protocol exposure.

    Off by default: it only matters when something OUTSIDE this container wants to watch the session
    (Everdict's live screen / environment recorder). Chrome binds its debugging port to 127.0.0.1, so
    reaching it from another host needs a per-session forwarder — see infrastructure/cdp.py.
    """

    expose: bool
    port_base: int
    advertised_host: str


@dataclass(frozen=True)
class Config:
    paths: Paths
    limits: Limits
    remote_mode: RemoteModeConfig
    cdp: CdpConfig
    browser_visible: bool

    @staticmethod
    def from_env() -> Config:
        return Config(
            paths=Paths(
                extension_path=Path(os.environ.get("EXTENSION_PATH", DEFAULT_EXTENSION_PATH)).resolve(),
                user_data_root=Path(os.environ.get("USER_DATA_DIR", DEFAULT_USER_DATA_DIR)),
            ),
            limits=Limits(
                max_browsers=_int_env("MAX_CONCURRENT_BROWSERS", DEFAULT_MAX_CONCURRENT_BROWSERS),
                session_timeout_minutes=_int_env("SESSION_TIMEOUT_MINUTES", DEFAULT_SESSION_TIMEOUT_MINUTES),
                cleanup_interval_minutes=_int_env("CLEANUP_INTERVAL_MINUTES", DEFAULT_CLEANUP_INTERVAL_MINUTES),
            ),
            remote_mode=RemoteModeConfig(
                panel_path=os.environ.get("SPICA_PANEL_PATH", "sidepanel.html"),
                menu_selector=os.environ.get("SPICA_MENU_SELECTOR", "[data-testid='menu-button']"),
                remote_view_selector=os.environ.get("SPICA_REMOTE_VIEW_SELECTOR", "[data-testid='remote-view-link']"),
                start_selector=os.environ.get("SPICA_START_SELECTOR", "[data-testid='remote-start-button']"),
                session_id_selector=os.environ.get("SPICA_SESSION_ID_SELECTOR", "[data-session-id]"),
                activation_timeout_ms=_int_env("SPICA_ACTIVATION_TIMEOUT_MS", 60_000, minimum=1000),
            ),
            cdp=CdpConfig(
                expose=_bool_env("SPICA_CDP_EXPOSE"),
                port_base=_int_env("SPICA_CDP_PORT_BASE", DEFAULT_CDP_PORT_BASE, minimum=1024),
                advertised_host=os.environ.get("SPICA_CDP_ADVERTISED_HOST", "127.0.0.1"),
            ),
            browser_visible=_bool_env("SPICA_PLAYWRIGHT_BROWSER_VISIBLE"),
        )
