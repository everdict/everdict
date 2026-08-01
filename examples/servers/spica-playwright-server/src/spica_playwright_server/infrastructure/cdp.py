"""Per-session DevTools Protocol exposure (opt-in, SPICA_CDP_EXPOSE=1).

Why a forwarder: Chrome binds its debugging port to 127.0.0.1 and ignores attempts to bind it wider, so
an address inside this container is useless to anything outside it. A `socat` process per session
republishes that port on 0.0.0.0, which is what makes the returned `cdp_url` an address a remote
observer (Everdict's live screen / environment recorder) can actually reach.
"""

from __future__ import annotations

import asyncio
import contextlib
import shutil
import socket
from dataclasses import dataclass
from typing import Optional


def free_port(preferred: Optional[int] = None) -> int:
    """A bindable TCP port — the preferred one when it is free, else whatever the OS hands out."""
    if preferred is not None:
        with contextlib.suppress(OSError), socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(("127.0.0.1", preferred))
            return preferred
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


@dataclass
class CdpEndpoint:
    internal_port: int
    published_port: int
    url: str
    _bridge: Optional[asyncio.subprocess.Process] = None

    async def close(self) -> None:
        bridge = self._bridge
        if bridge is None or bridge.returncode is not None:
            return
        bridge.terminate()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(bridge.wait(), timeout=5)
        if bridge.returncode is None:
            bridge.kill()


async def publish(internal_port: int, advertised_host: str, port_hint: Optional[int] = None) -> CdpEndpoint:
    """Republish a loopback-bound debugging port on all interfaces and return its outside address.

    Without socat the endpoint is still returned, pointing at the loopback port — honest for a caller in
    the same network namespace, and unreachable (rather than silently wrong) for anyone else.
    """
    socat = shutil.which("socat")
    if socat is None:
        return CdpEndpoint(
            internal_port=internal_port,
            published_port=internal_port,
            url=f"http://{advertised_host}:{internal_port}",
        )
    published = free_port(port_hint)
    bridge = await asyncio.create_subprocess_exec(
        socat,
        f"TCP-LISTEN:{published},fork,reuseaddr",
        f"TCP:127.0.0.1:{internal_port}",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    return CdpEndpoint(
        internal_port=internal_port,
        published_port=published,
        url=f"http://{advertised_host}:{published}",
        _bridge=bridge,
    )
