"""Resolving the loaded extension's id — the prefix every panel URL needs."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from playwright.async_api import BrowserContext

EXTENSION_URL = re.compile(r"chrome-extension://([a-p]{32})/")


def unpacked_extension_id(extension_path: Path) -> str:
    """Chrome's id for an unpacked extension: sha256 of the absolute directory path, first 16 bytes,
    with each hex digit shifted into the a-p alphabet.

    This is a FALLBACK. It is derived from the path, so it silently disagrees with the browser whenever
    the path Chrome sees differs from the one we hash (a symlink, a bind mount, a trailing slash) — which
    is exactly why the service worker's own URL is preferred when one shows up.
    """
    digest = hashlib.sha256(str(extension_path).encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(char, 16)) for char in digest)


async def resolve_extension_id(context: "BrowserContext", extension_path: Path, timeout_ms: int) -> str:
    """Prefer the id the browser itself is using (read off the extension's service worker URL); fall
    back to deriving it from the path when no worker registers in time."""
    for worker in context.service_workers:
        match = EXTENSION_URL.match(worker.url)
        if match:
            return match.group(1)
    try:
        worker = await context.wait_for_event("serviceworker", timeout=timeout_ms)
    except Exception:
        return unpacked_extension_id(extension_path)
    match = EXTENSION_URL.match(worker.url)
    return match.group(1) if match else unpacked_extension_id(extension_path)
