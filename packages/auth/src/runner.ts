import type { RunnerStore } from "@everdict/db";
import type { Authenticator } from "./principal.js";

export interface RunnerAuthOptions {
  runnerStore: RunnerStore;
}

// Self-hosted runner pairing token (rnr_) authenticator — for the `everdict runner` client. token hash → {owner, workspace, runnerId}.
// Least privilege: roles=["runner"] (not a workspace member role). Uses only runner-specific tools like lease/result/heartbeat.
// The control plane excludes via="runner" from active-workspace bootstrap so it isn't promoted to the owner's membership role.
export function runnerAuthenticator(opts: RunnerAuthOptions): Authenticator {
  return {
    async authenticate(bearer) {
      if (!bearer.startsWith("rnr_")) return undefined;
      const r = await opts.runnerStore.resolveByToken(bearer);
      if (!r) return undefined;
      return { subject: r.owner, workspace: r.workspace, roles: ["runner"], via: "runner", runnerId: r.runnerId };
    },
  };
}
