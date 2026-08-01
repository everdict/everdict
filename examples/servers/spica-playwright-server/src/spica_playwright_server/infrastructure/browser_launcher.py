"""Launching one extension-loaded Chromium."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from playwright.async_api import BrowserContext, Playwright

# Far enough off any real desktop that the window never appears, without the extension-breaking
# compromises of headless mode. Under Xvfb it changes nothing; on a developer's machine it is the
# difference between a quiet run and eight windows stealing focus.
OFFSCREEN_POSITION = "--window-position=-32000,-32000"


@dataclass(frozen=True)
class LaunchSpec:
    user_data_dir: Path
    extension_path: Path
    visible: bool
    cdp_port: Optional[int] = None


def chromium_args(spec: LaunchSpec) -> list[str]:
    ext = str(spec.extension_path)
    args = [
        # Both flags are required: --load-extension alone leaves other extensions enabled, and Chrome
        # refuses to load unpacked extensions in some builds unless they are also the only ones allowed.
        f"--disable-extensions-except={ext}",
        f"--load-extension={ext}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-dev-shm-usage",  # containers give /dev/shm 64MB by default; Chrome needs more
        "--no-sandbox",  # the sandbox needs user namespaces most container runtimes do not grant
    ]
    if spec.cdp_port is not None:
        args.append(f"--remote-debugging-port={spec.cdp_port}")
    if not spec.visible:
        args.append(OFFSCREEN_POSITION)
    return args


async def launch(playwright: "Playwright", spec: LaunchSpec) -> "BrowserContext":
    """A persistent context, because that is the only launch mode Chrome loads extensions in — and its
    profile directory is per-session, since Chrome holds an exclusive lock on a profile."""
    spec.user_data_dir.mkdir(parents=True, exist_ok=True)
    return await playwright.chromium.launch_persistent_context(
        str(spec.user_data_dir),
        headless=False,  # an extension's service worker does not start in headless Chromium
        args=chromium_args(spec),
        ignore_default_args=["--disable-extensions"],
    )
