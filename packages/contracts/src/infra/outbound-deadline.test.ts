import { describe, expect, it } from "vitest";
import { DEFAULT_OUTBOUND_TIMEOUT_MS, deadlineFetch } from "./outbound-deadline.js";

// ── EVERY OUTBOUND CALL CARRIES A DEADLINE, AND THE CALLER'S OWN SIGNAL SURVIVES (perf review) ───────
//
// The lanes this wraps dial other people's software from a request handler. Without a deadline the remote
// decides how long OUR request lasts, and it holds a connection from a pool every route shares while it
// decides. Two properties, and the second is the one a naive wrapper breaks:
//
//   a deadline is always attached          — never "only when the caller forgot"
//   the caller's signal is COMPOSED        — replacing it silently drops "the client went away"
//
// SEEN RED by neutralizing the wrapper to `return inner ?? fetch` (the pre-fix shape), observed:
//   AssertionError: an outbound call must carry a deadline: expected undefined not to be undefined
describe("deadlineFetch", () => {
  it("attaches a deadline to a call that carries no signal", async () => {
    // Given: a transport that records what it was handed
    let seen: RequestInit | undefined;
    const inner = (async (_input: URL | string | Request, init?: RequestInit) => {
      seen = init;
      return new Response("ok");
    }) as typeof fetch;

    // When: a caller dials without a signal of its own
    await deadlineFetch(inner)("https://example.test/x");

    // Then: the request is bounded
    expect(seen?.signal, "an outbound call must carry a deadline").not.toBe(undefined);
    expect(seen?.signal?.aborted).toBe(false);
  });

  it("composes with the caller's signal instead of replacing it", async () => {
    // Given: a caller that can cancel — usually "the client went away"
    const caller = new AbortController();
    let seen: AbortSignal | undefined;
    const inner = (async (_input: URL | string | Request, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Response("ok");
    }) as typeof fetch;

    // When: it dials and then cancels
    await deadlineFetch(inner)("https://example.test/x", { signal: caller.signal });
    caller.abort(new Error("client gone"));

    // Then: the abort reached the request — a wrapper that overwrote the signal would leave this false
    expect(seen?.aborted, "the caller's own cancellation was dropped").toBe(true);
  });

  it("aborts a transport that never answers, rather than waiting on it", async () => {
    // Given: a remote that hangs — the failure this exists for. Real time, deliberately: `AbortSignal.timeout`
    // owns its own timer and Vitest's fake clock does not reach it, so faking here would prove nothing while
    // looking like it did.
    // ⚠️ `aborted` IS CHECKED BEFORE THE LISTENER IS ATTACHED. `addEventListener("abort")` never fires on a
    // signal that has ALREADY aborted, and under load — a full `pnpm test` runs this beside twenty other
    // packages — the deadline can elapse between `AbortSignal.timeout` and this line. The first version
    // raced there and hung until Vitest's own timeout, which is a flake that costs somebody an afternoon
    // and says nothing about the subject.
    const inner = ((_input: URL | string | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) return;
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;

    // When: the deadline passes
    const settled = await deadlineFetch(
      inner,
      20,
    )("https://example.test/hang").then(
      () => "resolved",
      () => "aborted",
    );

    // Then: we stopped waiting
    expect(settled, "a hung remote held the request open").toBe("aborted");
  });

  it("resolves the global transport at CALL time, so later instrumentation still applies", async () => {
    // Given: a wrapper built BEFORE anything instruments the global — a module-level constant, which is how
    // the agent lane holds it
    const wrapped = deadlineFetch();
    const original = globalThis.fetch;
    const seen: string[] = [];

    // When: the global is replaced afterwards (a test stub, an OTel auto-instrumentation, a dispatcher swap)
    globalThis.fetch = (async (input: URL | string | Request) => {
      seen.push(String(input));
      return new Response("ok");
    }) as typeof fetch;
    try {
      await wrapped("https://example.test/late");
    } finally {
      globalThis.fetch = original;
    }

    // Then: the call went through the replacement. Capturing the global at construction would leave `seen`
    // empty and dial the real network instead — which is what seven counterexamples caught.
    expect(seen, "the wrapper captured the global at construction instead of resolving it per call").toEqual([
      "https://example.test/late",
    ]);
  });

  it("has a default that is a real number of milliseconds", () => {
    expect(DEFAULT_OUTBOUND_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_OUTBOUND_TIMEOUT_MS)).toBe(true);
  });
});
