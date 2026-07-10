// L0 relocation (re-architecture P0a/P1e, docs/architecture/rearchitecture/00-target-architecture.md):
// The contracts (schemas/types/errors) live in @everdict/contracts and the kernel rules live in
// @everdict/domain. This package is a compat shell that keeps consumers unbroken until the P4 sweep.
// New code should import @everdict/contracts (shapes) or @everdict/domain (rules) directly.
export * from "@everdict/contracts";
// Kernel rules that used to live in core — re-exported by exact name (P1e).
export {
  assertHardenedIsolation,
  capabilitiesOfKind,
  capabilityKind,
  classifyFailure,
  classifyImageRef,
  collectHarnessImages,
  defaultRuntimeCapabilities,
  dockerAuthConfigJson,
  flattenEnv,
  functionalGate,
  type HarnessSecretMaps,
  imageRegistryPrefix,
  imageUsesRegistryHost,
  imageWarnings,
  isHardenedRuntime,
  parseImageRef,
  partitionCapabilities,
  referencesUserSecret,
  requiredCapabilities,
  resolveHarnessSecrets,
  runtimeSatisfies,
  stageForError,
  usageFromTrace,
} from "@everdict/domain";
