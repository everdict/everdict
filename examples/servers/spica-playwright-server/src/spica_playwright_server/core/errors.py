"""Domain errors. The API layer owns the HTTP mapping — nothing here knows about status codes."""

from __future__ import annotations


class SpicaServerError(Exception):
    """Base for everything this server refuses to do, carrying a machine-readable code."""

    code = "SERVER_ERROR"

    def __init__(self, message: str, **details: object) -> None:
        super().__init__(message)
        self.message = message
        self.details = details


class SessionNotFound(SpicaServerError):
    code = "SESSION_NOT_FOUND"


class DuplicateSession(SpicaServerError):
    """Two browsers reported the same session id. The id is issued by the extension, so this means the
    remote-mode activation is handing out a shared/stale id — accepting it would silently alias sessions."""

    code = "DUPLICATE_SESSION"


class CapacityExceeded(SpicaServerError):
    """Starting these browsers would exceed max_browsers, or a new cap is below what is already running."""

    code = "CAPACITY_EXCEEDED"


class ActivationFailed(SpicaServerError):
    """The browser started but remote mode never yielded a session id (panel flow changed / extension
    not loaded / the work tab never opened)."""

    code = "ACTIVATION_FAILED"


class StopFailed(SpicaServerError):
    """The browser would not close and force was not requested. The session stays registered — it is
    still holding a slot and a profile lock, so deregistering it would leak it invisibly."""

    code = "STOP_FAILED"


class InvalidRequest(SpicaServerError):
    code = "INVALID_REQUEST"
