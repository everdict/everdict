import { type IncomingMessage, type RequestOptions, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  AppError,
  type FrontDoorCompletion,
  type FrontDoorCorrelate,
  InternalError,
  type StatusMatch,
  UpstreamError,
} from "@everdict/contracts";

// A cancelled front-door drive (a user stopped the scorecard mid-run). "CANCELLED" matches backends `dispatchAborted`,
// so the runner-loop classifies it the same way. Thrown by the loops/primitives the moment the drive signal aborts.
function driveCancelled(): InternalError {
  return new InternalError("CANCELLED", { reason: "front-door-aborted" }, "Front-door drive aborted (run cancelled).");
}
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw driveCancelled();
}
// Reject `p` the moment `signal` aborts (for a primitive that can't itself be aborted, e.g. a rendezvous wait) — so a
// cancelled drive returns promptly instead of waiting out the completion deadline. Detaches the listener on settle.
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(driveCancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(driveCancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// A resolved multipart file part (G2) — the field name + filename + the raw content (resolved from the case env by the backend).
export interface FrontDoorFilePart {
  field: string;
  filename: string;
  content: string;
}

// front-door request options — method (from the submit verb; defaults to POST) + headers (values interpolated) + timeoutMs (socket idle timeout).
// timeoutMs: for sync completion, no data flows while the server holds the response, so the socket no-flow cap is effectively the completion deadline.
// encoding/files (G2): "form" sends multipart/form-data (payload → text parts, files → file parts) instead of JSON — for agents whose submit is multipart with attachments.
export interface FrontDoorRequestOpts {
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  encoding?: "json" | "form";
  files?: FrontDoorFilePart[];
  // Cancellation — when it aborts, the in-flight request is destroyed/aborted (frees the held socket) and the call
  // rejects with a CANCELLED error. Threaded from the dispatch signal so a user stop ends the drive mid-flight.
  signal?: AbortSignal;
}

// Encode the request body per the encoding: JSON (default) or multipart/form-data (payload fields → text parts, files →
// file parts). Returns the body buffer + the content-type header to set. Pure/deterministic — the boundary is derived
// from the content so tests are stable (no random/time).
export function encodeBody(
  payload: Record<string, unknown>,
  opts?: FrontDoorRequestOpts,
): { body: Buffer; contentType: string } {
  const multipart = opts?.encoding === "form" || (opts?.files?.length ?? 0) > 0;
  if (!multipart) return { body: Buffer.from(JSON.stringify(payload)), contentType: "application/json" };
  const boundary = `----everdictFormBoundary${Buffer.from(JSON.stringify(payload)).length.toString(36)}`;
  const parts: Buffer[] = [];
  const push = (s: string): number => parts.push(Buffer.from(s, "utf8"));
  for (const [k, v] of Object.entries(payload)) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n`);
    push(`${typeof v === "string" ? v : JSON.stringify(v)}\r\n`);
  }
  for (const f of opts?.files ?? []) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    parts.push(Buffer.from(f.content, "utf8"));
    push("\r\n");
  }
  push(`--${boundary}--\r\n`);
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
// Function that POSTs task+wiring to the front-door — returns the response body (JSON) (for extracting a trace-id in returned correlation).
// Injectable in tests. (injected correlation doesn't need the body, so a void return is also allowed.)
export type SubmitFn = (
  frontDoorUrl: string,
  payload: Record<string, unknown>,
  opts?: FrontDoorRequestOpts,
) => Promise<unknown>;
// GET for status polling — returns the JSON response as-is.
export type GetJsonFn = (url: string) => Promise<unknown>;
// Streaming submit (stream completion model) — returns the POST response (SSE/JSON-lines) as an async sequence of parsed events.
// timeoutMs is for a socket hard-abort (the logical timeout is checked separately by the driver via now() per event). Tests inject a fake async iterable.
export type OpenStreamFn = (
  url: string,
  payload: Record<string, unknown>,
  opts?: FrontDoorRequestOpts & { timeoutMs?: number },
) => AsyncIterable<unknown>;

// Default submit — a direct node:http/https request (bypassing global fetch=undici).
// Why: undici's headersTimeout (default 300s) cuts off sync-completion harnesses — the server holds the response for
// minutes until the agent's N steps finish, and undici aborts that as a header timeout. node http has no such cap.
// Instead we set opts.timeoutMs as a socket idle timeout — no data flows while the response is held, so this value
// effectively becomes the completion deadline (only no-flow is cut; normal waiting is allowed indefinitely). Unset = no idle timeout (the parent run timeout is the cap).
const fetchSubmit: SubmitFn = (url, payload, opts) =>
  new Promise<unknown>((resolve, reject) => {
    if (opts?.signal?.aborted) return reject(driveCancelled()); // pre-cancelled — don't even open the socket
    const target = new URL(url);
    const { body, contentType } = encodeBody(payload, opts); // JSON (default) or multipart/form-data (G2)
    const options: RequestOptions = {
      method: opts?.method ?? "POST", // from the submit verb ("POST /runs") — defaults to POST
      // Declared headers (Authorization etc.) go above content-type; content-length is always exact, based on the actual body.
      headers: { "content-type": contentType, ...opts?.headers, "content-length": Buffer.byteLength(body) },
    };
    const onResponse = (res: IncomingMessage): void => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        // Even if the response isn't JSON or is empty, injected mode doesn't need the body → parse leniently.
        try {
          resolve(text ? JSON.parse(text) : undefined);
        } catch {
          resolve(undefined);
        }
      });
    };
    const req =
      target.protocol === "https:"
        ? httpsRequest(target, options, onResponse)
        : httpRequest(target, options, onResponse);
    // TCP keepalive — a sync-completion peer that dies while holding the response open (no data flowing, no FIN) is
    // otherwise invisible until the wall-clock. Keepalive probes surface a dead peer (RST) earlier, so a client-control
    // stream death fails the drive instead of hanging.
    req.on("socket", (socket) => {
      socket.setKeepAlive(true, 30_000);
    });
    if (opts?.timeoutMs !== undefined) {
      req.setTimeout(opts.timeoutMs, () => {
        req.destroy(
          new UpstreamError(
            "UPSTREAM_ERROR",
            { url, timeoutMs: opts.timeoutMs },
            "Timed out waiting for the front-door submit response (socket no-flow).",
          ),
        );
      });
    }
    // Cancellation — a sync-completion submit holds the response for minutes; on abort destroy the request (freeing
    // the socket) with a CANCELLED error so the drive rejects promptly instead of waiting out the run.
    const onAbort = (): void => {
      req.destroy(driveCancelled());
    };
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    // Remap node socket errors (ECONNREFUSED / socket timeout etc.) to our AppError — don't let a raw error escape the
    // boundary. An AppError (our timeout / the cancelled destroy) is preserved as-is.
    req.on("error", (err: Error) => {
      opts?.signal?.removeEventListener("abort", onAbort);
      reject(
        err instanceof AppError
          ? err
          : new UpstreamError("UPSTREAM_ERROR", { url }, `front-door submit failed: ${err.message}`),
      );
    });
    req.end(body);
  });
// Default JSON GET — the base primitive for poll completion + egress sink retrieval (used unless injected).
export const fetchJson: GetJsonFn = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  return res.json();
};

// Default SSE streaming submit — POST, then JSON-parse and yield the text/event-stream body per event (\n\n-separated, data: lines).
// Non-JSON data is skipped. With timeoutMs, cut the socket via AbortController (stall prevention). Used by the stream model unless injected.
export const fetchStream: OpenStreamFn = async function* (url, payload, opts) {
  const ctrl = new AbortController();
  const timer = opts?.timeoutMs !== undefined ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : undefined;
  // Cancellation — a user stop aborts the SSE fetch (frees the stream socket); the driver loop then throws CANCELLED.
  const onAbort = (): void => ctrl.abort();
  opts?.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const { body, contentType } = encodeBody(payload, opts); // JSON (default) or multipart/form-data (G2)
    const res = await fetch(url, {
      method: opts?.method ?? "POST",
      headers: { "content-type": contentType, accept: "text/event-stream", ...opts?.headers },
      body,
      signal: ctrl.signal,
    });
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf("\n\n");
      while (sep !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (data) {
          try {
            yield JSON.parse(data);
          } catch {
            // ignore non-JSON data events (comments / keep-alive etc.)
          }
        }
        sep = buf.indexOf("\n\n");
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onAbort);
  }
};

// "POST /runs" → { method: "POST", path: "/runs" }. If there's no method token, assume POST.
export function methodPath(spec: string): { method: string; path: string } {
  const parts = spec.split(" ");
  if (parts.length > 1) return { method: parts[0] ?? "POST", path: parts[1] ?? spec };
  return { method: "POST", path: spec };
}
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
// Replace {var} tokens with wiring values (single braces — same as the existing front-door path convention {id}). Unmatched keys keep the original.
export function interpolatePath(path: string, vars: Record<string, string>): string {
  return path.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);
}
// Interpolate {{var}} tokens in a single string with wiring values (double-brace convention, same as the body template).
// Unmatched tokens keep the original. Used for header values + the contextId correlation coordinate template.
export function interpolateString(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole);
}
// Interpolate {{var}} in header values (double-brace convention, same as the body template). Keys stay as-is; unmatched tokens keep the original.
export function interpolateHeaders(
  headers: Record<string, string>,
  vars: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = interpolateString(v, vars);
  return out;
}

// Body-template interpolation (#1) — recursively walk the JSON and replace {{var}} tokens in string values with wiring
// (double braces — the CommandHarness {{task}} convention). Unmatched tokens keep the original. Non-strings (number/boolean/null) stay as-is.
function interpolateValue(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return value.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole);
  if (Array.isArray(value)) return value.map((v) => interpolateValue(v, vars));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateValue(v, vars);
    return out;
  }
  return value;
}
export function interpolateTemplate(
  template: Record<string, unknown>,
  vars: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template)) out[k] = interpolateValue(v, vars);
  return out;
}

// Safely read a dot-path field from the status-response JSON (no eval). sentinel observation extraction reuses this too.
export function getField(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}
function statusMatches(match: StatusMatch, body: unknown): boolean {
  const value = getField(body, match.field);
  if (match.equals !== undefined) return value === match.equals;
  if (match.oneOf !== undefined) return match.oneOf.some((v) => v === value);
  return false;
}

// Determine the correlation key (traceRef) — injected (the injected runId, current) vs returned (dot-path extracted from the submit response).
function resolveTraceRef(correlate: FrontDoorCorrelate | undefined, injected: string, response: unknown): string {
  if (!correlate || correlate.mode === "injected") return injected;
  const value = getField(response, correlate.path);
  if (typeof value !== "string" || value === "") {
    // The agent response doesn't match the declared correlation contract — fail explicitly rather than silently (external-contract error).
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { path: correlate.path, got: value },
      `Could not find the trace-id (${correlate.path}) in the front-door submit response.`,
    );
  }
  return value;
}

// Read the completion model's timeoutMs — sync's is optional (undefined = unbounded here; the backend per-case budget
// EvalCase.timeoutSec is the real cap). Passed as the submit socket idle timeout: for sync no data flows while the
// server holds the response, so this value is the effective max wait, cutting a dead agent instead of hanging.
function completionTimeoutMs(completion: FrontDoorCompletion | undefined): number | undefined {
  return completion?.timeoutMs;
}

export type DriveStatus = "done" | "failed" | "timeout";
export interface DriveOutcome {
  // Correlation key to pull the trace by. In this slice, injected (= everdict runId); generalized to returned (the agent's own id) in #3.
  traceRef: string;
  status: DriveStatus;
  // Result-channel body — for sync the submit response, for poll the completed (done) status body. sentinel observation retrieval extracts from here.
  // optional: also allows custom drivers with no response (fire-and-forget etc.) (in which case sentinel retrieval fails explicitly on format mismatch).
  response?: unknown;
}

export interface FrontDoorDriveRequest {
  base: string; // front-door service base URL
  submit: string; // spec.frontDoor.submit (e.g. "POST /runs")
  payload: Record<string, unknown>;
  completion: FrontDoorCompletion | undefined; // unset = sync
  correlate: FrontDoorCorrelate | undefined; // unset = injected
  wiring: Record<string, string>; // statusPath interpolation variables ({run_id} etc.)
  traceRef: string; // default correlation key for injected correlation (= everdict runId)
  headers?: Record<string, string>; // submit/stream/callback request headers (interpolated; unset = none)
  encoding?: "json" | "form"; // body encoding (G2) — "form" = multipart/form-data (for attachment submits)
  files?: FrontDoorFilePart[]; // resolved attachments (from the case env) for the multipart submit (G2)
  // Cancellation — aborts the in-flight submit/poll/stream/callback so a user stop ends the drive mid-flight
  // (throws CANCELLED, freeing the socket where the primitive supports it). Threaded from the dispatch signal.
  signal?: AbortSignal;
}

// Abstraction for front-door driving (HOW) — submit then wait per the completion model. The sibling of the infra-agnostic TopologyRuntime (WHERE).
export interface FrontDoorDriver {
  drive(req: FrontDoorDriveRequest): Promise<DriveOutcome>;
}

// Rendezvous for the callback completion model — Everdict exposes a per-run callback URL ({{callback_url}}) and waits for the agent's inbound POST.
// A seam split out of the driver (injectable): in-process (self-hosted/dev) | control-plane endpoint (SaaS). The inbound counterpart of egress observation.
export interface CallbackRendezvous {
  url(runId: string): string; // the {{callback_url}} value (per-run — the receiver correlates by runId)
  wait(runId: string, timeoutMs: number): Promise<{ body: unknown } | undefined>; // the next inbound POST body (undefined = timeout if none)
}

export interface HttpFrontDoorDriverIo {
  submit?: SubmitFn;
  getJson?: GetJsonFn;
  openStream?: OpenStreamFn; // the SSE-consuming primitive for the stream completion model (fetchStream unless injected)
  callbackRendezvous?: CallbackRendezvous; // the inbound-wait seam for the callback completion model (a callback model with none fails explicitly)
  sleep?: (ms: number) => Promise<void>; // inject a no-op in tests (so polling intervals aren't actually awaited)
  now?: () => number; // inject a fake clock in tests (timeout determinism)
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Default HTTP driver — submit (POST) then wait for completion per the completion model.
export class HttpFrontDoorDriver implements FrontDoorDriver {
  private readonly submit: SubmitFn;
  private readonly getJson: GetJsonFn;
  private readonly openStream: OpenStreamFn;
  private readonly callbackRendezvous: CallbackRendezvous | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  constructor(io: HttpFrontDoorDriverIo = {}) {
    this.submit = io.submit ?? fetchSubmit;
    this.getJson = io.getJson ?? fetchJson;
    this.openStream = io.openStream ?? fetchStream;
    this.callbackRendezvous = io.callbackRendezvous;
    this.sleep = io.sleep ?? realSleep;
    this.now = io.now ?? Date.now;
  }

  async drive(req: FrontDoorDriveRequest): Promise<DriveOutcome> {
    // stream: the submit response is itself the event stream — not request/response, so a separate path (correlate on the first event, decide on the terminal event).
    if (req.completion?.mode === "stream") return this.driveStream(req, req.completion);
    // callback: fire-and-forget submit, then wait for the agent's inbound POST at the rendezvous.
    if (req.completion?.mode === "callback") return this.driveCallback(req, req.completion);
    const mp = methodPath(req.submit); // verb + path — method from submit ("POST /runs"), headers from req
    // Pass the completion model's timeoutMs as the submit socket idle timeout — for sync (unset) there's none (holding the response is normal).
    const timeoutMs = completionTimeoutMs(req.completion);
    const response = await this.submit(joinUrl(req.base, mp.path), req.payload, {
      method: mp.method,
      headers: req.headers,
      ...(req.encoding ? { encoding: req.encoding } : {}),
      ...(req.files ? { files: req.files } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    });
    throwIfAborted(req.signal); // cancelled while the submit was held (sync completion) → stop before polling/trace work
    // Correlation (#3): injected = the injected runId (current), returned = the agent's own id returned in the response.
    const traceRef = resolveTraceRef(req.correlate, req.traceRef, response);
    // For returned, overwrite run_id with that id so the poll statusPath is also interpolated with the agent id (for injected it's the same value → no-op).
    const wiring = { ...req.wiring, run_id: traceRef };
    const completion = await this.awaitCompletion(req.completion, req.base, wiring, req.signal);
    // Result-channel body: for poll the completed status body, for sync the submit response. sentinel retrieval reads this.
    return { traceRef, status: completion.status, response: completion.body ?? response };
  }

  // stream: consume the submit POST response as an event stream. Correlate on the first event (extract the agent id for returned),
  // then StatusMatch each event in failed→done order. The terminal event is the result-channel body (sentinel retrieval target).
  private async driveStream(
    req: FrontDoorDriveRequest,
    completion: Extract<FrontDoorCompletion, { mode: "stream" }>,
  ): Promise<DriveOutcome> {
    const mp = methodPath(req.submit);
    const url = joinUrl(req.base, mp.path);
    const start = this.now();
    let traceRef = req.traceRef;
    let correlated = false;
    let last: unknown;
    try {
      for await (const event of this.openStream(url, req.payload, {
        timeoutMs: completion.timeoutMs,
        method: mp.method,
        headers: req.headers,
        ...(req.encoding ? { encoding: req.encoding } : {}),
        ...(req.files ? { files: req.files } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      })) {
        throwIfAborted(req.signal); // cancelled mid-stream → stop consuming events (the fetch is already aborting)
        if (!correlated) {
          // Correlate on the first event — A2A issues Task.id up front, so the first event carries its own id (returned). injected is a no-op.
          traceRef = resolveTraceRef(req.correlate, req.traceRef, event);
          correlated = true;
        }
        last = event;
        if (completion.failed && statusMatches(completion.failed, event))
          return { traceRef, status: "failed", response: event };
        if (statusMatches(completion.done, event)) return { traceRef, status: "done", response: event };
        if (this.now() - start >= completion.timeoutMs) return { traceRef, status: "timeout", response: last };
      }
    } catch (err) {
      // A cancel aborts the SSE fetch, so the reader throws — surface it as our CANCELLED, not a raw abort DOMException.
      if (req.signal?.aborted) throw driveCancelled();
      throw err;
    }
    // The stream ended with no terminal match → completion can't be confirmed (treated as timeout → dispatch fails the run).
    return { traceRef, status: "timeout", response: last };
  }

  // callback: fire-and-forget submit → wait at the rendezvous for the inbound POST the agent sends to {{callback_url}}.
  // The rendezvous returns the next POST per run — repeat until a done/failed match (interim updates are let through), timeout if the deadline passes.
  // Rendezvous key = req.traceRef (= the injected runId; the value embedded in callback_url). DriveOutcome.traceRef is the correlation result (for trace fetch).
  private async driveCallback(
    req: FrontDoorDriveRequest,
    completion: Extract<FrontDoorCompletion, { mode: "callback" }>,
  ): Promise<DriveOutcome> {
    if (!this.callbackRendezvous) {
      throw new InternalError(
        "HARNESS_RUN_FAILED",
        { mode: "callback" },
        "Missing the rendezvous required for the callback completion model.",
      );
    }
    const runKey = req.traceRef; // the key embedded in callback_url (= the injected runId)
    const mp = methodPath(req.submit);
    const response = await this.submit(joinUrl(req.base, mp.path), req.payload, {
      method: mp.method,
      headers: req.headers,
      ...(req.encoding ? { encoding: req.encoding } : {}),
      ...(req.files ? { files: req.files } : {}),
      timeoutMs: completion.timeoutMs, // fire-and-forget submit — a socket cap to avoid a hang (the response comes right back)
      ...(req.signal ? { signal: req.signal } : {}),
    });
    const traceRef = resolveTraceRef(req.correlate, req.traceRef, response);
    const start = this.now();
    while (this.now() - start < completion.timeoutMs) {
      throwIfAborted(req.signal); // cancelled between callbacks → stop waiting
      // Race the rendezvous wait against the cancel signal so a stop ends promptly instead of waiting out the deadline.
      const result = await raceAbort(
        this.callbackRendezvous.wait(runKey, completion.timeoutMs - (this.now() - start)),
        req.signal,
      );
      if (!result) return { traceRef, status: "timeout", response: undefined };
      const body = result.body;
      if (completion.failed && statusMatches(completion.failed, body))
        return { traceRef, status: "failed", response: body };
      if (!completion.done || statusMatches(completion.done, body)) return { traceRef, status: "done", response: body };
      // done is specified but didn't match → interim callback (working etc.). Wait for the next POST.
    }
    return { traceRef, status: "timeout", response: undefined };
  }

  private async awaitCompletion(
    completion: FrontDoorCompletion | undefined,
    base: string,
    wiring: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ status: DriveStatus; body: unknown }> {
    // If not poll (sync/unset): the submit response is completion — current behavior. The result body uses the caller's submit response (body=undefined).
    // (stream is handled by drive() on a separate path, so it never reaches here.)
    if (!completion || completion.mode !== "poll") return { status: "done", body: undefined };
    // poll: poll the status endpoint until the terminal condition (done/failed) or timeout. Return the completed body via the result channel.
    const statusUrl = joinUrl(base, interpolatePath(methodPath(completion.statusPath).path, wiring));
    const start = this.now();
    while (this.now() - start < completion.timeoutMs) {
      throwIfAborted(signal); // cancelled between polls → stop promptly (the status GET is short-lived)
      const body = await this.getJson(statusUrl);
      if (statusMatches(completion.done, body)) return { status: "done", body };
      if (completion.failed && statusMatches(completion.failed, body)) return { status: "failed", body };
      await this.sleep(completion.intervalMs);
    }
    return { status: "timeout", body: undefined };
  }
}
