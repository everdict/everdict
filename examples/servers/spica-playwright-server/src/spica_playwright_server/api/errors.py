"""Domain error -> HTTP. The only place in the server that knows about status codes."""

from __future__ import annotations

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from ..core.errors import (
    ActivationFailed,
    CapacityExceeded,
    DuplicateSession,
    InvalidRequest,
    SessionNotFound,
    SpicaServerError,
    StopFailed,
)

STATUS_BY_ERROR: dict[type[SpicaServerError], int] = {
    InvalidRequest: 400,
    SessionNotFound: 404,
    # Both are conflicts with the server's current state, not bad input: too many browsers already
    # running, or an id that is already taken.
    CapacityExceeded: 409,
    DuplicateSession: 409,
    # The session is still there and still running — the caller resolves it by retrying with force.
    StopFailed: 409,
    # The browser came up but the extension did not cooperate — a failure of a dependency, not of the
    # request, so it must not read as a client error.
    ActivationFailed: 502,
}


def status_for(error: SpicaServerError) -> int:
    for error_type, status in STATUS_BY_ERROR.items():
        if isinstance(error, error_type):
            return status
    return 500


def install(app) -> None:
    @app.exception_handler(SpicaServerError)
    async def _handle(_: Request, error: SpicaServerError) -> JSONResponse:
        return JSONResponse(
            status_code=status_for(error),
            content={"code": error.code, "message": error.message, "details": _jsonable(error.details)},
        )

    @app.exception_handler(RequestValidationError)
    async def _handle_validation(_: Request, error: RequestValidationError) -> JSONResponse:
        # FastAPI answers schema failures with its own 422 `{detail: [...]}` shape. Left alone, this
        # server would have two error contracts — one for "count must be >= 1" and another for every
        # rejection it raises itself — and a client would have to parse both to say what went wrong.
        problems = error.errors()
        summary = "; ".join(f"{'.'.join(str(p) for p in e['loc'][1:])}: {e['msg']}" for e in problems)
        return JSONResponse(
            status_code=400,
            content={
                "code": InvalidRequest.code,
                "message": summary or "The request body is invalid.",
                "details": {"fields": [".".join(str(p) for p in e["loc"][1:]) for e in problems]},
            },
        )


def _jsonable(details: dict[str, object]) -> dict[str, object]:
    return {key: (value if isinstance(value, (str, int, float, bool, type(None))) else str(value)) for key, value in details.items()}
