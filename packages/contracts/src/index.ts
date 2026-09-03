// @everdict/contracts — contracts only. The dependency root.
// Every contract is paired with a Zod schema (the schema is the source of truth; the type is z.infer).
export * from "./errors.js";
export * from "./version.js";
export * from "./execution/execution-id.js";
export * from "./job-result-wire.js";
export { evalContainerSecretEnv } from "./execution/eval-container-env.js";
export { refuseUnenforceableNetwork } from "./execution/network-enforcement.js";
export {
  assertPublicOutboundTarget,
  isPrivateAddress,
  type OutboundPolicy,
  refuseUnsafeOutboundUrl,
} from "./infra/outbound-target.js";
export * from "./execution/verifier-job.js";
export {
  type ExpectedVerifierIdentity,
  VERIFIER_RESULT_SENTINEL,
  type VerifierResultEnvelope,
  VerifierResultEnvelopeSchema,
  encodeVerifierResult,
  parseVerifierResult,
} from "./execution/verifier-result-wire.js";
export {
  type ActivationDecision,
  type ActivationRequest,
  decideActivation,
} from "./execution/dispatch-activation.js";
export {
  type ProvisionedWorldProof,
  ProvisionedWorldProofSchema,
  worldProofCovers,
} from "./execution/provisioned-world.js";
export * from "./artifact-ref.js";
export * from "./execution/trace.js";
export * from "./execution/span.js";
export * from "./execution/semconv.js";
export * from "./execution/trace-sink.js";
export * from "./execution/trace-source.js";
export * from "./execution/image-registry-probe.js";
export * from "./execution/adopted-result.js";
export * from "./execution/job-payload-transport.js";
export * from "./execution/image-provenance.js";
export * from "./execution/trace-probe.js";
export * from "./execution/compute.js";
export * from "./execution/file-execution.js";
export * from "./execution/case-failure.js";
export * from "./execution/case-key.js";
export * from "./execution/build-recipe.js";
export * from "./execution/session-acquire.js";
export * from "./execution/environment.js";
export * from "./harness/harness.js";
export * from "./harness/auth-env.js";
export * from "./execution/grader.js";
export * from "./execution/verdict-policy.js";
export * from "./execution/eval-case.js";
export * from "./execution/recording.js";
export * from "./execution/case-job.js";
export * from "./execution/attempt-ref.js";
export * from "./execution/runtime-work-ref.js";
export * from "./execution/dispatch-intent.js";
export * from "./execution/read-result.js";
export * from "./execution/kill-outcome.js";
export * from "./infra/trust-zone.js";
export * from "./infra/capability.js";
export * from "./harness/harness-spec.js";
export * from "./harness/harness-diff.js";
export * from "./infra/image-ref.js";
export * from "./infra/image-store.js";
export * from "./harness/harness-template.js";
export * from "./execution/suite.js";
export * from "./execution/dataset.js";
export * from "./harness/rubric-spec.js";
export * from "./harness/judge-spec.js";
export * from "./harness/judge-diff.js";
export * from "./harness/model-spec.js";
export * from "./harness/agent-spec.js";
export * from "./infra/runtime-spec.js";
export * from "./infra/spec-transport.js";
export * from "./infra/no-proxy.js";
export * from "./infra/nomad-placement.js";
export * from "./infra/world.js";
export * from "./execution/git-auth.js";
export * from "./execution/shell.js";
export * from "./records/index.js";
export * from "./knowledge/index.js";
