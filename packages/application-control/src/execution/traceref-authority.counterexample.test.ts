import type { CaseResult, EvalCase, TraceSourceConfig } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { collectDeferredTrace } from "./collect-trace.js";

// ── [R122 COUNTEREXAMPLE] A PRODUCER MAY NOT NAME A SECRET AND WHERE TO SEND IT ─────────────────────
//
// `CaseResult.traceRef` is the deferred-collection target, and the control plane acts on it:
//
//     const secrets = await deps.secretsFor(tenant);
//     const auth = secrets[ref.authSecret];                      ← a name the PRODUCER chose
//     buildTraceSource({ endpoint: ref.endpoint, headers: { authorization: auth }, … })
//                                     ↑ a URL the PRODUCER chose
//
// `CaseResult` is parsed from producer surfaces — `submit_job_result`, and the `__EVERDICT_RESULT__` sentinel
// printed by a job-runner image the workspace supplies (`RuntimeSpec.image`). So anyone who can register a
// runtime or a harness could have the control plane resolve ANY workspace secret — provider keys, the GitHub
// App private key, a Mattermost bot token — and POST it to a URL of their choosing, without `settings:write`.
// On a managed dispatch the control plane is the sender, so the same lever reaches internal endpoints.
//
//     the producer echoed a coordinate   ≠   the platform authored it
//
// And the platform ALREADY KNOWS the right answer: the workspace registers its sources by name in Settings ›
// Observability, and the job builds `traceRef` from the harness's source (`deps.harness.traceSource?.()`) —
// which the control plane resolved and dispatched. The result merely echoes it back, and the control plane
// was reading the echo instead of its own registration. Rule `protocol` L3, in its purest form.
//
// So the registered pool is the authority: a `(endpoint, authSecret)` pair that no registered source declares
// is refused, and the secret is never resolved for it. The producer keeps what only it knows — the
// correlation `runId`.
//
// Seen RED before the fix: "a producer named a secret and where to send it: expected 'https://attacker.invalid/'
// not to be requested".
const REGISTERED = {
  name: "obs",
  kind: "otel" as const,
  endpoint: "https://obs.internal/api",
  authSecretName: "obs-token",
};

function harness(ref: CaseResult["traceRef"]): { result: CaseResult; evalCase: EvalCase } {
  return {
    result: {
      caseId: "c1",
      harness: "h@1.0.0",
      snapshot: { kind: "prompt", output: "" },
      trace: [],
      scores: [],
      ...(ref ? { traceRef: ref } : {}),
    } as CaseResult,
    evalCase: { id: "c1", timeoutSec: 60, graders: [] } as unknown as EvalCase,
  };
}

function deps(built: TraceSourceConfig[]) {
  return {
    secretsFor: async () => ({ "obs-token": "REAL-OBS-TOKEN", "github-app-key": "SUPER-SECRET-PRIVATE-KEY" }),
    registeredTraceSources: async () => [REGISTERED],
    buildTraceSource: (cfg: TraceSourceConfig) => {
      built.push(cfg);
      return {
        async fetch() {
          return [];
        },
      } as never;
    },
  };
}

describe("[R122 COUNTEREXAMPLE] the collection target is the workspace's registration, not the producer's word", () => {
  it("REFUSES an endpoint the workspace never registered — and never resolves the secret for it", async () => {
    const built: TraceSourceConfig[] = [];
    const { result, evalCase } = harness({
      kind: "otel",
      endpoint: "https://attacker.invalid/",
      runId: "r1",
      authSecret: "github-app-key",
    });

    await collectDeferredTrace(deps(built) as never, "acme", evalCase, result);

    expect(
      built.map((c) => c.endpoint),
      "a producer named a secret and where to send it",
    ).not.toContain("https://attacker.invalid/");
    const leaked = built.some((c) => JSON.stringify(c).includes("SUPER-SECRET-PRIVATE-KEY"));
    expect(leaked, "a workspace secret was handed to a producer-named endpoint").toBe(false);
  });

  it("REFUSES a secret the registered source does not declare, even at the right endpoint", async () => {
    const built: TraceSourceConfig[] = [];
    const { result, evalCase } = harness({
      kind: "otel",
      endpoint: REGISTERED.endpoint, // the real one…
      runId: "r1",
      authSecret: "github-app-key", // …with somebody else's credential
    });

    await collectDeferredTrace(deps(built) as never, "acme", evalCase, result);

    expect(
      built.some((c) => JSON.stringify(c).includes("SUPER-SECRET-PRIVATE-KEY")),
      "a producer swapped the credential on a registered endpoint",
    ).toBe(false);
  });

  it("still collects from a registered source with its own declared secret — the feature survives", async () => {
    const built: TraceSourceConfig[] = [];
    const { result, evalCase } = harness({
      kind: "otel",
      endpoint: REGISTERED.endpoint,
      runId: "r1",
      authSecret: REGISTERED.authSecretName,
    });

    await collectDeferredTrace(deps(built) as never, "acme", evalCase, result);

    expect(
      built.map((c) => c.endpoint),
      "a legitimate deferred collection was refused",
    ).toContain(REGISTERED.endpoint);
    expect(
      built.some((c) => JSON.stringify(c).includes("REAL-OBS-TOKEN")),
      "the registered source's own credential did not travel",
    ).toBe(true);
  });
});
