import { deadlineFetch } from "@everdict/contracts";
// ── AN INTERNAL AGENT CALL IS STILL AN OUTBOUND CALL (perf review) ──────────────────────────────────
//
// The control plane dials its own agent service over HTTP for approvals, activations, discussion turns and
// schedule reports. "Our own service" is not a deadline: it is a separate process behind a URL, and a hung
// one holds the caller exactly as long as a hung third party would.
//
// It gets its OWN budget rather than `DEFAULT_OUTBOUND_TIMEOUT_MS`, because what is on the other end is an
// AGENT TURN — a model call, tools, possibly several minutes — and a deadline shorter than the legitimate
// work turns a working feature into an intermittent failure. Five minutes is "this turn is not coming back",
// not "this turn is slow".
export const AGENT_CALL_TIMEOUT_MS = 300_000;
export const agentFetch = deadlineFetch(undefined, AGENT_CALL_TIMEOUT_MS);
