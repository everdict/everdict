import type { BrowserProfileStore } from "@everdict/application-control";
import type { CaseJob } from "@everdict/contracts";
import type { SecretCipher } from "@everdict/db";
import { type StorageState, seedStorageState } from "@everdict/topology";

// Saved-profile injection for browser evals (browser-profiles S5). Resolves the profile referenced by a service
// harness's target, owner-gates it against the run submitter, decrypts its captured storageState, and seeds the
// cookies into the per-case eval browser BEFORE the agent connects — so the eval runs already authenticated. Wired
// into the topology backend (ServiceTopologyBackend.seedProfile). Best-effort at the seam: this throws on a hard
// failure, but the backend swallows it so injection never fails the run. The decrypted blob stays server-side.
export interface ProfileInjectorDeps {
  store: BrowserProfileStore;
  cipher: SecretCipher;
  seed?: (cdpBase: string, state: StorageState) => Promise<void>; // injectable (tests); default = real CDP seed
}

export function makeProfileSeeder(
  deps: ProfileInjectorDeps,
): (profileId: string, cdpBase: string, job: CaseJob) => Promise<void> {
  const seed = deps.seed ?? ((cdpBase, state) => seedStorageState(cdpBase, state));
  return async (profileId, cdpBase, job) => {
    const tenant = job.tenant ?? "default";
    // Owner gate — a profile referenced in a spec is only injected for the run submitter that owns it (a mismatch /
    // absence silently skips injection, leaving the eval unauthenticated). No submitter identity ⇒ can't gate ⇒ skip.
    const profile = await deps.store.get(tenant, profileId);
    if (!profile || !job.submittedBy || profile.createdBy !== job.submittedBy) return;

    const blob = await deps.store.loadState(tenant, profileId);
    if (!blob) return; // no login captured into this profile yet (S3) — nothing to inject
    const state = JSON.parse(deps.cipher.decrypt(JSON.parse(blob))) as StorageState;
    await seed(cdpBase, state);
  };
}
