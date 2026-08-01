"""A small client for the session API.

The context manager exists because the failure mode this server has is leaked browsers: a caller that
crashes between start and stop pins a slot until the sweeper notices, and with a cap of eight that is
felt immediately. Entering starts the batch, leaving force-stops it — including when the body raised.
"""

from __future__ import annotations

from types import TracebackType
from typing import Any, Optional

import httpx

DEFAULT_TIMEOUT_SECONDS = 180.0


class BrowserServerError(RuntimeError):
    """A non-2xx from the server, carrying its error envelope."""

    def __init__(self, status_code: int, code: str, message: str, details: dict[str, Any]) -> None:
        super().__init__(f"[{status_code} {code}] {message}")
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


class BrowserClient:
    def __init__(
        self,
        server_url: str,
        *,
        count: int = 1,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._base_url = server_url.rstrip("/")
        self._count = count
        self._owns_client = client is None
        self._http = client or httpx.AsyncClient(timeout=timeout)
        self.session_ids: list[str] = []

    # --- context management ------------------------------------------------------------------------

    async def __aenter__(self) -> "BrowserClient":
        try:
            self.session_ids = await self.start(self._count)
        except BaseException:
            if self._owns_client:
                await self._http.aclose()
            raise
        return self

    async def __aexit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc: Optional[BaseException],
        tb: Optional[TracebackType],
    ) -> None:
        try:
            for session_id in self.session_ids:
                # force: the caller is leaving regardless, and a browser that refuses a graceful close
                # would otherwise outlive the process that asked for it.
                try:
                    await self.stop(session_id, force=True)
                except Exception:
                    pass
            self.session_ids = []
        finally:
            if self._owns_client:
                await self._http.aclose()

    @property
    def session_id(self) -> str:
        """The single session, for the common count=1 case."""
        if not self.session_ids:
            raise RuntimeError("No session — use this inside `async with BrowserClient(...)`.")
        return self.session_ids[0]

    # --- calls -------------------------------------------------------------------------------------

    async def health(self) -> dict[str, Any]:
        return await self._request("GET", "/health")

    async def start(self, count: int = 1) -> list[str]:
        body = await self._request("POST", "/start-browser", json={"count": count})
        return list(body["session_ids"])

    async def stop(self, session_id: str, *, force: bool = False) -> dict[str, Any]:
        return await self._request(
            "POST", f"/stop-browser/{session_id}", params={"force": str(force).lower()}
        )

    async def navigate(self, url: str, session_id: Optional[str] = None) -> str:
        body = await self._request(
            "POST", "/navigate", json={"session_id": session_id or self.session_id, "url": url}
        )
        return str(body["url"])

    async def status(self, session_id: Optional[str] = None) -> dict[str, Any]:
        return await self._request("GET", f"/status/{session_id or self.session_id}")

    async def browsers(self) -> dict[str, Any]:
        return await self._request("GET", "/browsers")

    async def state(self) -> dict[str, Any]:
        return await self._request("GET", "/state")

    async def set_state(self, **changes: int) -> dict[str, Any]:
        return await self._request("PATCH", "/state", json=changes)

    async def processes(self) -> dict[str, Any]:
        return await self._request("GET", "/debug/processes")

    async def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        response = await self._http.request(method, f"{self._base_url}{path}", **kwargs)
        if response.status_code >= 400:
            raise _error_from(response)
        return response.json()


def _error_from(response: httpx.Response) -> BrowserServerError:
    try:
        body = response.json()
    except ValueError:
        body = {}
    return BrowserServerError(
        response.status_code,
        str(body.get("code", "HTTP_ERROR")),
        str(body.get("message", response.text[:200])),
        dict(body.get("details", {})),
    )
