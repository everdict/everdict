import { BadRequestError, type HarnessInstanceSpec } from "@everdict/contracts";
import { z } from "zod";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";

// Durable re-pin — merge the requested pins over the base instance's pins and register a "new instance version".
// The headless path where CI (dev/main merge) swaps only its own service slots: same meaning as the web "Create new version (re-pin)" flow.
// Idempotent: if the merge equals the base, respond unchanged without registering (no version spam on re-firing the same commit).
// Design: docs/architecture/github-actions-trigger.md (D2).

export const RepinBodySchema = z.object({
  // slot→image ref. Monorepo CI puts all changed services in one call to make exactly one version (vN+1).
  pins: z.record(z.string().min(1)).refine((p) => Object.keys(p).length > 0, "pins is empty."),
  version: z.string().min(1).optional(), // explicit version (e.g. "dev-<sha>"). If unset, auto (semver patch bump / -r<n>)
  base: z.string().min(1).optional(), // base instance version (default latest)
  // Digest pins are enforced by default (@sha256:…) — tags move and break scorecard reproducibility / leaderboard comparison. Only an explicit opt-out is allowed.
  allowTags: z.boolean().default(false),
});
export type RepinBody = z.infer<typeof RepinBodySchema>;

export interface RepinResult {
  workspace: string;
  id: string;
  version: string; // the registered (or unchanged base) instance version
  base: string; // the instance version used as the merge base
  unchanged: boolean; // true = the merge equals the base → registration skipped (idempotent)
  pins: Record<string, string>; // all pins after the merge
}

const DIGEST_RE = /@sha256:[0-9a-f]{64}$/;

// Auto version: if the base is semver, patch bump (keep +1 on collision), else a "-r<n>" suffix. An explicit version always wins.
function nextVersion(base: string, taken: ReadonlySet<string>): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
  if (m) {
    let patch = Number(m[3]) + 1;
    while (taken.has(`${m[1]}.${m[2]}.${patch}`)) patch += 1;
    return `${m[1]}.${m[2]}.${patch}`;
  }
  let n = 2;
  while (taken.has(`${base}-r${n}`)) n += 1;
  return `${base}-r${n}`;
}

export async function repinHarnessImages(
  instances: HarnessInstanceRegistry,
  tenant: string,
  subject: string | undefined,
  id: string,
  body: RepinBody,
): Promise<RepinResult> {
  if (!body.allowTags) {
    for (const [slot, image] of Object.entries(body.pins)) {
      if (!DIGEST_RE.test(image)) {
        throw new BadRequestError(
          "BAD_REQUEST",
          { slot, image },
          `pin '${slot}' is not in digest form (needs @sha256:…). Tags move and break reproducibility — pass allowTags:true if intended.`,
        );
      }
    }
  }

  const base = await instances.getInstance(tenant, id, body.base ?? "latest"); // 404 if absent
  // Verify the merge resolves (unknown slot / missing pin) before registering — on failure, nothing is registered.
  await instances.resolveWithPins(tenant, id, base.version, body.pins);

  const merged = { ...base.pins, ...body.pins };
  const unchanged = Object.keys(merged).every((k) => base.pins[k] === merged[k]);
  if (unchanged && body.version === undefined) {
    return { workspace: tenant, id, version: base.version, base: base.version, unchanged: true, pins: merged };
  }

  const taken = new Set(await instances.versions(tenant, id));
  const version = body.version ?? nextVersion(base.version, taken);
  const next: HarnessInstanceSpec = { ...base, version, pins: merged };
  await instances.register(tenant, next, subject); // re-registering the same content = no-op, different content at the same version = 409 (immutable)
  return { workspace: tenant, id, version, base: base.version, unchanged: false, pins: merged };
}
