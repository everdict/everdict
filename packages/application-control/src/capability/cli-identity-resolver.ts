import {
  BadRequestError,
  type CapabilityRecord,
  ConflictError,
  type EnvValue,
  NotFoundError,
} from "@everdict/contracts";
import { canConsumeCapability, chooseCliIdentity, resolveEnvValues } from "@everdict/domain";
import type { HarnessSecretMaps } from "@everdict/domain";
import type { CapabilityStore } from "../ports/capability-store.js";
import type { ResolvedCliIdentity } from "../session/sandbox-session-service.js";

// ── WHO THE CLI RUNS AS ──────────────────────────────────────────────────────────────────────────────
//
// The submitter's OWN registered identity for the CLI about to run, or the one the caller named. This is a
// use-case — a store read, a consume gate and secret resolution — so it lives here rather than in the
// composition root, which only says which stores it reads.
//
// Deliberately not the workspace's identity by default: the mechanism this replaces resolved
// `secrets.workspace[name] ?? secrets.user[name]`, so a team secret silently outranked every member's own
// login, which is the opposite of what registering one is for. A workspace-visible identity is something a
// caller NAMES.

export interface CliIdentityResolverDeps {
  capabilities: CapabilityStore;
  scopedSecretsFor: (tenant: string, subject: string) => Promise<HarnessSecretMaps>;
}

export function cliIdentityResolver(deps: CliIdentityResolverDeps) {
  return async (
    tenant: string,
    subject: string,
    want: { cli: string; ref?: { source?: string; id: string; version?: string } },
  ) => {
    const secrets = await deps.scopedSecretsFor(tenant, subject);
    const missing = new Set<string>();

    const resolve = (record: CapabilityRecord): ResolvedCliIdentity => {
      if (record.spec.type !== "cli-identity")
        throw new BadRequestError(
          "BAD_REQUEST",
          { identity: record.id, type: record.spec.type },
          `'${record.id}' is a ${record.spec.type} capability, not a CLI identity.`,
        );
      const env = resolveEnvValues(record.spec.env, secrets, missing);
      const home = record.spec.home.map((file) => {
        if ("content" in file) return { path: file.path, content: file.content };
        const ref: EnvValue = { secretRef: file.secretRef, ...(file.scope ? { scope: file.scope } : {}) };
        return { path: file.path, content: resolveEnvValues({ v: ref }, secrets, missing).v ?? "" };
      });
      // Refused by NAME, at open, beside the profile's own missing-secret refusal. A CLI handed an empty
      // credential file does not fail — it runs as nobody and the session reports success.
      if (missing.size > 0)
        throw new BadRequestError(
          "BAD_REQUEST",
          { identity: record.id, missing: [...missing] },
          `CLI identity '${record.id}' needs secret(s) that are not set: ${[...missing].join(", ")}.`,
        );
      return { ref: { source: record.tenant, id: record.id, version: record.version }, env, home };
    };

    if (want.ref !== undefined) {
      const record = await deps.capabilities.get(want.ref.source ?? tenant, want.ref.id, want.ref.version);
      // No existence leak: an identity the caller may not consume answers exactly like one that is not there.
      // Anything else tells a member that a colleague has registered a credential, and under what name.
      if (!record || !canConsumeCapability(record, { tenant, subject }))
        throw new NotFoundError(
          "NOT_FOUND",
          { identity: want.ref.id },
          `No CLI identity '${want.ref.id}' this workspace can use.`,
        );
      return { kind: "explicit" as const, identity: resolve(record) };
    }

    // The implicit half: MINE, for this CLI. `listVisible` also returns the workspace's and what other
    // workspaces shared here, so the `createdBy` filter is the whole thing keeping "my account" from being
    // outranked by a team one — the precedence this record exists to replace.
    const mine = (await deps.capabilities.listVisible(tenant, subject)).filter(
      (c) => c.spec.type === "cli-identity" && c.spec.cli === want.cli && c.createdBy === subject,
    );
    const chosen = chooseCliIdentity({ mine: mine.map((c) => ({ id: c.id, version: c.version })), cli: want.cli });
    if (chosen.kind === "none") return { kind: "none" as const };
    const record = mine.find((c) => c.id === chosen.identity.id);
    if (!record)
      throw new ConflictError(
        "CONFLICT",
        { identity: chosen.identity.id },
        "the chosen identity was removed between the listing and the read — open the session again.",
      );
    return { kind: "mine" as const, identity: resolve(record) };
  };
}
