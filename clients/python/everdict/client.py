"""The one-call Everdict client for Python — mirror of @everdict/sdk's evaluate().

Zero-dependency (stdlib only). The client never runs compute; it drives the control plane, which places work on
your own runtime. See docs/architecture/one-call-sdk.md.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

# Authoritative-first metric order for a single headline pass rate (mirrors the server's caseVerdict ranking).
_PASS_RATE_METRICS = ["tests_pass", "state", "answer_match", "url_matches", "dom_contains", "judge"]

# A transport is (method, url, headers, body_bytes) -> (status_int, parsed_json_or_None). Injectable for tests.
Transport = Callable[[str, str, dict, Optional[bytes]], "tuple[int, Any]"]


class EverdictError(Exception):
    """A control-plane error (a {code, message} body), carrying the HTTP status."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code


def _urllib_transport(method: str, url: str, headers: dict, body: Optional[bytes]) -> "tuple[int, Any]":
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:  # noqa: S310 (caller supplies the base URL)
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as err:
        raw = err.read()
        return err.code, (json.loads(raw) if raw else None)


def _parse_ref(ref: str) -> dict:
    """'id@version' -> {'id', 'version'} (version defaults to 'latest')."""
    at = ref.rfind("@")
    if at <= 0:
        return {"id": ref, "version": "latest"}
    return {"id": ref[:at], "version": ref[at + 1 :] or "latest"}


def _headline_pass_rate(record: dict) -> Optional[float]:
    ts = record.get("trialSummary")
    if ts:
        return ts.get("passAt1")
    summary = record.get("summary") or []
    for metric in _PASS_RATE_METRICS:
        for s in summary:
            if s.get("metric") == metric and s.get("passRate") is not None:
                return s["passRate"]
    for s in summary:
        if s.get("passRate") is not None:
            return s["passRate"]
    return None


class EverdictClient:
    """Thin, zero-dependency client. evaluate() composes register -> submit -> poll into one call -> a verdict dict."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        workspace: Optional[str] = None,
        transport: Optional[Transport] = None,
        sleep: Optional[Callable[[float], None]] = None,
    ) -> None:
        if not base_url:
            raise ValueError("EverdictClient requires a base_url.")
        if not api_key:
            raise ValueError("EverdictClient requires an api_key.")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.workspace = workspace
        self._transport = transport or _urllib_transport
        self._sleep = sleep or time.sleep

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> Any:
        headers = {"authorization": f"Bearer {self.api_key}"}
        if self.workspace:
            headers["x-everdict-workspace"] = self.workspace
        data = None
        if body is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(body).encode()
        status, payload = self._transport(method, self.base_url + path, headers, data)
        if not (200 <= status < 300):
            env = payload or {}
            raise EverdictError(status, env.get("code", "ERROR"), env.get("message", f"HTTP {status}"))
        return payload

    def register_dataset(self, dataset: dict) -> dict:
        return self._request("POST", "/datasets", dataset)

    def register_harness(self, harness: dict) -> dict:
        return self._request("POST", "/harnesses", harness)

    def submit_scorecard(self, body: dict) -> dict:
        return self._request("POST", "/scorecards", body)

    def get_scorecard(self, scorecard_id: str) -> dict:
        return self._request("GET", f"/scorecards/{scorecard_id}")

    def evaluate(
        self,
        harness,
        dataset,
        trials: Optional[int] = None,
        judges: Optional[list] = None,
        runtime: Optional[str] = None,
        poll: Optional[dict] = None,
        on_progress: Optional[Callable[[dict], None]] = None,
    ) -> dict:
        """Reproduce env + N trials + score -> a verdict, in one call."""
        ds = _parse_ref(dataset) if isinstance(dataset, str) else self.register_dataset(dataset)
        hn = _parse_ref(harness) if isinstance(harness, str) else self.register_harness(harness)
        body: dict = {"dataset": {"id": ds["id"], "version": ds["version"]}, "harness": {"id": hn["id"], "version": hn["version"]}}
        if trials is not None:
            body["trials"] = trials
        if judges:
            body["judges"] = judges
        if runtime:
            body["runtime"] = runtime
        submitted = self.submit_scorecard(body)
        record = self.poll(submitted["id"], poll, on_progress)
        ts = record.get("trialSummary") or {}
        return {
            "scorecard_id": record["id"],
            "status": record.get("status"),
            "pass_rate": _headline_pass_rate(record),
            "pass_at_1": ts.get("passAt1"),
            "pass_at_k": ts.get("passAtK"),
            "flake_rate": ts.get("flakeRate"),
            "summary": record.get("summary") or [],
            "record": record,
        }

    def poll(
        self,
        scorecard_id: str,
        opts: Optional[dict] = None,
        on_progress: Optional[Callable[[dict], None]] = None,
    ) -> dict:
        opts = opts or {}
        interval = opts.get("interval_ms", 2000) / 1000.0
        timeout = opts.get("timeout_ms", 30 * 60 * 1000) / 1000.0
        terminal = {"succeeded", "failed", "superseded"}
        waited = 0.0
        while True:
            record = self.get_scorecard(scorecard_id)
            if on_progress:
                on_progress(record)
            if record.get("status") in terminal:
                return record
            if waited >= timeout:
                raise EverdictError(408, "TIMEOUT", f"scorecard {scorecard_id} did not finish in time")
            self._sleep(interval)
            waited += interval

    def diff(self, baseline: str, candidate: str, z: Optional[float] = None) -> dict:
        query = f"baseline={baseline}&candidate={candidate}"
        if z is not None:
            query += f"&z={z}"
        return self._request("GET", f"/scorecards/diff?{query}")

    def leaderboard(
        self,
        dataset: str,
        metric: Optional[str] = None,
        harness: Optional[str] = None,
        model: Optional[str] = None,
        judge_model: Optional[str] = None,
        window: Optional[str] = None,
    ) -> dict:
        params = [f"dataset={dataset}"]
        if metric:
            params.append(f"metric={metric}")
        if harness:
            params.append(f"harness={harness}")
        if model:
            params.append(f"model={model}")
        if judge_model:
            params.append(f"judgeModel={judge_model}")
        if window:
            params.append(f"window={window}")
        return self._request("GET", "/scorecards/leaderboard?" + "&".join(params))

    def usage(self) -> dict:
        """The workspace's metered billing usage (LLM cost for orchestration + verdict)."""
        return self._request("GET", "/usage")
