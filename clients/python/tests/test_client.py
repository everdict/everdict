import json

import pytest

from everdict import EverdictClient, EverdictError


def fake_transport(responses):
    """A fake transport: return the queued (status, payload) responses in call order, recording each request."""
    calls = []
    state = {"i": 0}

    def transport(method, url, headers, body):
        calls.append({"method": method, "url": url, "headers": headers, "body": json.loads(body) if body else None})
        i = state["i"]
        state["i"] += 1
        if i >= len(responses):
            raise AssertionError(f"unexpected call #{i + 1}: {method} {url}")
        return responses[i]

    return transport, calls


def client(transport):
    return EverdictClient("http://cp.test/", "ak_test", workspace="acme", transport=transport, sleep=lambda s: None)


def test_evaluate_string_refs_submits_then_polls():
    transport, calls = fake_transport(
        [
            (202, {"id": "sc1", "status": "queued"}),
            (200, {"id": "sc1", "status": "running"}),
            (200, {"id": "sc1", "status": "succeeded", "summary": [{"metric": "tests_pass", "count": 2, "mean": 1, "passRate": 1}]}),
        ]
    )
    v = client(transport).evaluate("h@1", "d@2", poll={"interval_ms": 1})
    assert [f'{c["method"]} {c["url"]}' for c in calls] == [
        "POST http://cp.test/scorecards",
        "GET http://cp.test/scorecards/sc1",
        "GET http://cp.test/scorecards/sc1",
    ]
    assert calls[0]["body"] == {"dataset": {"id": "d", "version": "2"}, "harness": {"id": "h", "version": "1"}}
    assert calls[0]["headers"]["authorization"] == "Bearer ak_test"
    assert calls[0]["headers"]["x-everdict-workspace"] == "acme"
    assert v["status"] == "succeeded"
    assert v["pass_rate"] == 1


def test_evaluate_registers_inline_dataset():
    transport, calls = fake_transport(
        [
            (201, {"workspace": "acme", "id": "d", "version": "1.0.0"}),
            (202, {"id": "sc2", "status": "queued"}),
            (200, {"id": "sc2", "status": "succeeded"}),
        ]
    )
    client(transport).evaluate("scripted@0", {"id": "d", "version": "1.0.0", "cases": []}, poll={"interval_ms": 1})
    assert calls[0]["method"] == "POST" and calls[0]["url"] == "http://cp.test/datasets"
    assert calls[1]["url"] == "http://cp.test/scorecards"
    assert calls[1]["body"]["dataset"] == {"id": "d", "version": "1.0.0"}


def test_evaluate_threads_trials_and_reads_trial_summary():
    transport, calls = fake_transport(
        [
            (202, {"id": "sc3", "status": "queued"}),
            (
                200,
                {
                    "id": "sc3",
                    "status": "succeeded",
                    "summary": [{"metric": "tool_calls", "count": 3, "mean": 2}],
                    "trialSummary": {"cases": 1, "passAt1": 0.6, "k": 5, "passAtK": 1, "flakeRate": 1},
                },
            ),
        ]
    )
    v = client(transport).evaluate("h@1", "d@1", trials=5, poll={"interval_ms": 1})
    assert calls[0]["body"]["trials"] == 5
    assert v["pass_rate"] == 0.6 and v["pass_at_k"] == 1 and v["flake_rate"] == 1


def test_error_body_maps_to_everdict_error():
    transport, _ = fake_transport([(400, {"code": "BAD_REQUEST", "message": "no runtime"})])
    with pytest.raises(EverdictError) as exc:
        client(transport).evaluate("h@1", "d@1")
    assert exc.value.status == 400 and exc.value.code == "BAD_REQUEST"


def test_on_progress_fires_per_poll():
    transport, _ = fake_transport(
        [
            (202, {"id": "sc1", "status": "queued"}),
            (200, {"id": "sc1", "status": "running"}),
            (200, {"id": "sc1", "status": "succeeded"}),
        ]
    )
    seen = []
    client(transport).evaluate("h@1", "d@1", poll={"interval_ms": 1}, on_progress=lambda r: seen.append(r["status"]))
    assert seen == ["running", "succeeded"]


def test_diff_and_leaderboard_build_queries():
    transport, calls = fake_transport([(200, {"trials": {"regressions": []}})])
    client(transport).diff("sc-a", "sc-b", z=2.58)
    assert calls[0]["url"] == "http://cp.test/scorecards/diff?baseline=sc-a&candidate=sc-b&z=2.58"

    transport2, calls2 = fake_transport([(200, {"rows": []})])
    client(transport2).leaderboard("swe", metric="tests_pass", window="best")
    assert calls2[0]["url"] == "http://cp.test/scorecards/leaderboard?dataset=swe&metric=tests_pass&window=best"


def test_constructor_requires_base_url_and_api_key():
    with pytest.raises(ValueError):
        EverdictClient("", "k")
    with pytest.raises(ValueError):
        EverdictClient("http://x", "")
