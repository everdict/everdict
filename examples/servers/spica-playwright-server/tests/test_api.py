"""HTTP contract — status codes and shapes, exercised against the real service.

No browser is launched: every path asserted here is refused (or answered) before a launch would happen,
which is exactly the set of behaviours that must not regress silently.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from tests.helpers import build_app, build_config


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    app, _ = build_app(build_config(tmp_path))
    return TestClient(app)


def test_health_reports_occupancy_against_the_cap(client: TestClient) -> None:
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["active_browsers"] == 0
    assert body["max_browsers"] == 2


def test_asking_for_more_browsers_than_the_cap_is_a_conflict_not_a_partial_batch(client: TestClient) -> None:
    response = client.post("/start-browser", json={"count": 5})
    assert response.status_code == 409
    assert response.json()["code"] == "CAPACITY_EXCEEDED"
    # Nothing was launched, so nothing is registered — a rejected batch leaves no residue.
    assert client.get("/browsers").json()["count"] == 0


def test_only_http_urls_may_be_navigated_to(client: TestClient) -> None:
    for url in ("file:///etc/passwd", "chrome://settings", "chrome-extension://abc/panel.html"):
        response = client.post("/navigate", json={"session_id": "s1", "url": url})
        # Rejected on the scheme alone — before the session is even looked up, so a bad URL can never
        # reach a browser through an existing session.
        assert response.status_code == 400, url
        assert response.json()["code"] == "INVALID_REQUEST"


def test_an_unknown_session_is_a_404_on_every_session_scoped_call(client: TestClient) -> None:
    assert client.get("/status/nope").status_code == 404
    assert client.post("/stop-browser/nope").status_code == 404
    assert client.post("/navigate", json={"session_id": "nope", "url": "https://example.com"}).status_code == 404


def test_state_is_readable_and_patchable_at_runtime(client: TestClient) -> None:
    before = client.get("/state").json()
    assert before["max_browsers"] == 2

    after = client.patch("/state", json={"max_browsers": 5, "session_timeout_minutes": 30}).json()
    assert after["max_browsers"] == 5
    assert after["session_timeout_minutes"] == 30
    # The cap the registry enforces moved too — otherwise /state would report a limit nothing applies.
    assert client.get("/health").json()["max_browsers"] == 5


async def test_a_cap_below_what_is_already_claimed_is_refused(tmp_path: Path) -> None:
    # Async end to end (one event loop): the registry's lock is loop-bound, so reserving from a
    # different loop than the request would be testing something the server never does.
    app, registry = build_app(build_config(tmp_path))
    await registry.reserve(2)  # a batch of 2 is mid-launch

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.patch("/state", json={"max_browsers": 1})

    assert response.status_code == 409
    assert response.json()["code"] == "CAPACITY_EXCEEDED"
    assert registry.max_browsers == 2  # refused, not partially applied


def test_debug_processes_lists_browsers_and_unclaimed_profiles(client: TestClient) -> None:
    body = client.get("/debug/processes").json()
    assert "processes" in body and "orphan_profiles" in body


def test_schema_failures_use_the_same_error_envelope_as_everything_else(client: TestClient) -> None:
    response = client.post("/start-browser", json={"count": 0})
    # FastAPI's own 422 shape would give this server two error contracts, so a client would have to
    # parse both to report what went wrong.
    assert response.status_code == 400
    body = response.json()
    assert body["code"] == "INVALID_REQUEST"
    assert body["details"]["fields"] == ["count"]
