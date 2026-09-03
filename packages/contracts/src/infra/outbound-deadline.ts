// ── AN OUTBOUND CALL WITH NO DEADLINE IS A REQUEST HANDLER WITH NO DEADLINE (perf review) ────────────
//
// The control plane dials other people's software on the REQUEST PATH: an identity provider during login, a
// tenant's MLflow/Langfuse during pull-ingest and connect-probes, GitHub while a CI link is being set up, an
// orchestrator while a job is placed, our own agent service during an approval. Every one of those was
// `fetch(url, init)` with no `signal`, so the remote decided how long OUR request lasted — and "forever" is
// one of the answers a hung TCP connection gives.
//
// That is the same shape as the Postgres pool's missing `statement_timeout`, one layer out: the resource held
// is a connection from a pool every other route shares, so one unreachable third party degrades endpoints
// that never touch it. `docs/architecture/control-plane-read-budget.md` is the whole argument.
//
// The idiom already existed and was applied twice — `PROBE_TIMEOUT_MS` in the registry reader and the
// Mattermost client — which is exactly the tell rule `protocol` names: a safety decision every new lane must
// REMEMBER to import is a convention, and the lane written after the lesson is the one that never learned it.
// So it lives here, beside `refuseUnsafeOutboundUrl` (arch-review 124), which is here for the same reason and
// passes the same admission test: no I/O of its own (the transport is injected), no store, no workspace
// policy, total, and consumed beneath the domain cone.
//
//     refuseUnsafeOutboundUrl   —   WHERE we are willing to dial
//     deadlineFetch             —   HOW LONG we are willing to wait
//
// ⚠️ NOT FOR A STREAMING BODY. An `AbortSignal` aborts the whole request, body included, so wrapping a
// transport that streams a long LLM completion or tails a log would cut the stream at the deadline rather
// than bounding the handshake. Those lanes bound themselves (an idle timeout, a heartbeat) or accept a
// deadline sized for the work; `@everdict/llm` is deliberately not wrapped.

// 30s is a HANDSHAKE-and-answer budget, not a work budget: every lane wrapped here is asking another service
// a question it already knows the answer to. A lane whose legitimate work is longer passes its own value —
// the point is that the value EXISTS, never that this one is right for everybody.
export const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;

// Wrap a fetch so every call it makes carries a deadline.
//
// `inner` is taken rather than assumed so the wrapper composes with the injectable-transport idiom this repo
// already uses (`fetchImpl ?? fetch`): a test's fake is wrapped too, which is what makes the wrapper the
// CHOKE POINT rather than one more thing a caller may forget. A fake that ignores `init` is unaffected, and a
// fake that reads it sees the same shape production sends.
//
// A caller that already passes its own `signal` keeps it: the two are COMPOSED, so an abort from either side
// aborts the request. Replacing the caller's signal would silently break cancellation — the caller's signal
// is usually the one carrying "the client went away", which is the abort that matters most.
//
// ⚠️ THE GLOBAL IS RESOLVED PER CALL, NOT CAPTURED AT CONSTRUCTION (perf review, caught by a real suite).
// The first version read `const transport = inner ?? fetch` once, when the module loaded — which silently
// unbinds the wrapper from anything that instruments `globalThis.fetch` LATER: a test's `vi.stubGlobal`, an
// OTel auto-instrumentation, an undici dispatcher swap. Seven counterexamples went red the moment a lane
// moved onto this helper, and they were right: every `fetchImpl ?? fetch` site it replaces resolved the
// global at call time, so capturing it is a behaviour change nobody asked for.
//
// A pending deadline does NOT hold the process open — `AbortSignal.timeout`'s timer is unref'd — so wrapping
// a short-lived CLI's one call does not delay its exit by the full budget. Checked rather than assumed: a
// process issuing one wrapped call under a 30 s deadline exits in ~34 ms.
export function deadlineFetch(inner?: typeof fetch, timeoutMs: number = DEFAULT_OUTBOUND_TIMEOUT_MS): typeof fetch {
  return (input, init) => {
    const transport = inner ?? fetch;
    const deadline = AbortSignal.timeout(timeoutMs);
    const caller = init?.signal;
    // `AbortSignal.any` is the composition; `?? undefined` is not a silent default — a caller that passed no
    // signal has nothing to compose with, and the deadline alone IS the signal.
    const signal = caller === undefined || caller === null ? deadline : AbortSignal.any([caller, deadline]);
    return transport(input, { ...init, signal });
  };
}
