import type { SecretStore } from "@everdict/db";

// The two secret-resolution closures the dispatch builder produces and the run/scorecard builders consume. They are
// thin adapters over the SecretStore, so their types are derived from it (no deep contracts-record import needed).

// Shared workspace secrets (owner=''): model/provider keys injected into a tenant's job env.
export type RuntimeSecretsFn = SecretStore["entries"];

// Shared (owner='') + the submitter's personal (owner=subject) secrets — resolves harness env {secretRef} just
// before dispatch. subject is optional at the closure boundary (buildDispatch defaults it to "").
export type ScopedSecretsFn = (tenant: string, subject?: string) => ReturnType<SecretStore["scopedEntries"]>;
