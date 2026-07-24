import { z } from "zod";

// A registry entity's immutable version tag (harness/dataset/judge/runtime/rubric/model/agent/capability). Non-empty
// is an INVARIANT, not cosmetic: a bare `z.string()` lets "" through, and `compareVersions` treats a non-semver value
// as equal-to-everything (returns 0), so an empty version sorts to the tail on registration order → `resolveRef(latest)`
// resolves to it and `listMeta.latestVersion` reports it, corrupting `latest` and collapsing the version detail view.
// Reject it at the contract boundary; `VersionedStore.register` guards the non-route (seed/file) paths too. See the
// version algebra in `@everdict/domain` (version-algebra.ts) for the ordering rules this protects.
export const VersionSchema = z.string().min(1, "version must be a non-empty string");
