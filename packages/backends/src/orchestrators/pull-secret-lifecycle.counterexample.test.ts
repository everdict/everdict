import type { CaseJob, RuntimeWorkRef } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { K8sBackend, k8sRegistryAuthSecret, workPullSecretName } from "./k8s.js";

// ── A CREDENTIAL IS NEVER UNOWNED, NOT EVEN FOR A MOMENT (arch-review 62 P1) ─────────────────────────
//
// The pull Secret was applied BESIDE the Job in a single `List` and given an owner one call afterwards, and
// both halves of that leaked:
//
//   the multi-object apply — a `List` that created the Secret and then failed left a dockerconfigjson with
//   nothing to reclaim it, and nothing in this lane reads back what a partial apply did make.
//
//   the owner patch — `patchOwnedByJob` returned `void` when the Job's uid could not be read, so the caller
//   went on believing an owner was attached. The Job was later deleted, its GC collected the objects it
//   owned, and the credential was not one of them.
//
// A leaked NetworkPolicy is inert. A leaked credential is a credential, and short-lived registry grants
// accumulating in a namespace is the failure mode.
//
// The repair is available because the Job is born INERT: `suspend: true` creates no pods, so the Job can
// exist BEFORE the Secret its pod will reference — which means the owner reference is in hand at the moment
// the credential is written. There is no unowned instant to compensate for, and a uid that cannot be read is
// a REFUSAL rather than a credential nothing will collect (the inert Job this attempt made is reclaimed by
// the same `finally`).
//
// Seen RED before the reorder, observed:
//   a pull credential was created before anything could own it: expected 'List' to be 'Job'
//   a credential was created with no owner after the Job's identity could not be read: expected 1 to be +0

const JOB = (): CaseJob =>
  ({
    tenant: "acme",
    runId: "evd-run-r1",
    harness: { id: "h", version: "1" },
    evalCase: {
      id: "c1",
      task: "t",
      env: { kind: "prompt" },
      graders: [],
      timeoutSec: 60,
      tags: [],
      image: "private.registry/task:1",
    },
    registryAuths: [{ host: "private.registry", username: "u", password: "p" }],
  }) as unknown as CaseJob;

const AUTHORITY = {
  reserve: async (work: RuntimeWorkRef) => ({ attemptId: "a1", work, persistedAt: new Date(0).toISOString() }),
  activate: async () => ({ kind: "activate" as const }),
};

// A cluster that records every object applied, in order, and can be told to lose the Job's identity.
function api(opts: { uid?: string; deleteStatus?: "stopped" | "failed"; applied: string[]; deleted: string[] }) {
  return {
    async ensureNamespace() {},
    async applyJob(m: { kind?: string; metadata?: { name?: string; ownerReferences?: unknown[] } }) {
      if (m.kind === "NetworkPolicy") return;
      opts.applied.push(
        `${m.kind}:${m.metadata?.name ?? "?"}:${(m.metadata?.ownerReferences ?? []).length > 0 ? "owned" : "orphan"}`,
      );
    },
    async jobUid() {
      return opts.uid;
    },
    async patchOwnedByJob() {},
    async resumeJob() {},
    async jobStatus(): Promise<{ succeeded: number; failed: number }> {
      throw new Error("stop once the objects exist");
    },
    async podLogs() {
      return "";
    },
    async deleteJob() {
      opts.deleted.push("Job");
      return opts.deleteStatus === "failed"
        ? { status: "failed" as const, reason: "the API server refused the delete" }
        : { status: "stopped" as const };
    },
    async deleteDependent(kind: string, name: string) {
      opts.deleted.push(`${kind}/${name}`);
      return { status: "stopped" as const };
    },
    async podFailureReason() {
      return undefined;
    },
    async podsForJob() {
      return [];
    },
    async namespaceEvents() {
      return [];
    },
  };
}

const dispatch = async (a: ReturnType<typeof api>) =>
  await new K8sBackend({ image: "runner:1", api: a, pollIntervalMs: 0, maxPolls: 2 } as never)
    .dispatch(JOB(), { authority: AUTHORITY })
    .catch(() => undefined);

describe("[R62 COUNTEREXAMPLE] a K8s pull credential is born owned or not born", () => {
  it("creates the JOB first, then the Secret WITH an owner", async () => {
    const applied: string[] = [];
    await dispatch(api({ uid: "uid-1", applied, deleted: [] }));

    expect(applied[0], "a pull credential was created before anything could own it").toMatch(/^Job:/);
    const secret = applied.find((a) => a.startsWith("Secret:"));
    expect(secret, "the Secret the pod references was never applied").toBeDefined();
    expect(secret, "the credential was written with no owner reference").toMatch(/:owned$/);
  });

  it("REFUSES to create a credential when the Job's identity cannot be read", async () => {
    // A uid that could not be established used to return silently from the owner patch, and the dispatch
    // carried on. Nothing will collect what nothing owns, so the honest outcome is no credential at all.
    const applied: string[] = [];
    const deleted: string[] = [];
    await dispatch(api({ uid: undefined, applied, deleted }));

    expect(
      applied.filter((a) => a.startsWith("Secret:")),
      "a credential was created with no owner after the Job's identity could not be read",
    ).toHaveLength(0);
    // …and the inert Job this attempt made is reclaimed, so the refusal leaves nothing behind either.
    expect(deleted).toContain("Job");
  });

  it("removes the credential DIRECTLY when the Job's own delete did not converge", async () => {
    // Owner-GC runs when the owner goes. A delete the API server refused means the owner is still there, so
    // nothing collects the dependents — "cleanup was attempted" is not "cleanup converged" (rule `protocol`
    // L5).
    const deleted: string[] = [];
    await dispatch(api({ uid: "uid-1", deleteStatus: "failed", applied: [], deleted }));

    // Asserted by SHAPE, not by restating the lane's naming rule here — a second spelling of an id is how
    // two components come to disagree about one object.
    const removed = deleted.filter((d) => d.startsWith("secret/"));
    expect(removed, "a credential was left to an owner that is still there, so nothing will collect it").toHaveLength(
      1,
    );
    // …and it is the Secret this dispatch created, named by the production function rather than by a second
    // spelling of the rule here.
    expect(removed[0]?.endsWith(workPullSecretName("").slice(1)), "a Secret other than the pull one was removed").toBe(
      true,
    );
  });

  it("still leaves the credential to owner-GC when the delete DID converge", async () => {
    // The control: deleting it twice is harmless but the assertion above would pass for a lane that always
    // deleted directly, which would make the owner reference decorative.
    const deleted: string[] = [];
    await dispatch(api({ uid: "uid-1", applied: [], deleted }));
    expect(deleted.filter((d) => d.startsWith("secret/"))).toHaveLength(0);
  });
});

describe("[R62] the secret builder carries the owner it is given", () => {
  it("writes an ownerReference naming the Job", () => {
    const secret = k8sRegistryAuthSecret([{ host: "h", username: "u", password: "p" }], "ns", "s", {
      name: "job-1",
      uid: "uid-1",
    }) as { metadata: { ownerReferences?: Array<{ name: string; uid: string; kind: string }> } };
    expect(secret.metadata.ownerReferences?.[0]).toMatchObject({ kind: "Job", name: "job-1", uid: "uid-1" });
  });

  it("writes none when it is given none — the caller decides, not this builder", () => {
    const secret = k8sRegistryAuthSecret([{ host: "h", username: "u", password: "p" }], "ns", "s") as {
      metadata: { ownerReferences?: unknown[] };
    };
    expect(secret.metadata.ownerReferences).toBeUndefined();
  });
});

// ── …AND THE VERIFIER LANE, WHICH HAD THE SAME TWO GAPS (arch-review 62 P1) ─────────────────────────
//
// The mutation for the block above passed on the first attempt, and the reason is the one arch-review 61
// wrote down: this file has TWO lanes spelled almost alike, and neutralizing the protocol hit whichever one
// came first in the source. The agent lane was covered and the verifier lane was not, so a guarantee that
// reads as closed was closed on one half of the cases — the judging half, which is the one holding the
// hidden tests and the registry grant for the task image.
//
// A lane that is fixed and a lane that is TESTED are different claims. Both, here.
const VERIFIER_JOB = {
  runId: "evd-sc-1-c1-t0",
  tenant: "acme",
  caseId: "c1",
  scorecardId: "sc-1",
  workdir: "/app",
  workspace: { kind: "repo", diff: "d", changedFiles: ["a"], headSha: "sha" },
  plan: { digest: "sha256:plan", graders: [{ id: "reward-file" }] },
  timeoutSec: 60,
  image: "private.registry/task:1",
  registryAuths: [{ host: "private.registry", username: "u", password: "p" }],
} as unknown as Parameters<K8sBackend["dispatchVerifier"]>[0];

const judge = async (a: ReturnType<typeof api>) =>
  await new K8sBackend({ image: "runner:1", api: a, pollIntervalMs: 0, maxPolls: 2 } as never)
    .dispatchVerifier(VERIFIER_JOB, { authority: AUTHORITY })
    .catch(() => undefined);

describe("[R62 COUNTEREXAMPLE] the verifier lane owns its credential too", () => {
  it("creates the JOB first, then the Secret WITH an owner", async () => {
    const applied: string[] = [];
    await judge(api({ uid: "uid-1", applied, deleted: [] }));

    expect(applied[0], "the verifier's credential was created before anything could own it").toMatch(/^Job:/);
    expect(
      applied.find((a) => a.startsWith("Secret:")),
      "the verifier's credential was written unowned",
    ).toMatch(/:owned$/);
  });

  it("REFUSES to create a credential when the Job's identity cannot be read", async () => {
    const applied: string[] = [];
    await judge(api({ uid: undefined, applied, deleted: [] }));
    expect(
      applied.filter((a) => a.startsWith("Secret:")),
      "the verifier created a credential with no owner after the Job's identity could not be read",
    ).toHaveLength(0);
  });

  it("removes the credential DIRECTLY when its own delete did not converge", async () => {
    const deleted: string[] = [];
    await judge(api({ uid: "uid-1", deleteStatus: "failed", applied: [], deleted }));
    expect(
      deleted.filter((d) => d.startsWith("secret/")),
      "the verifier left a credential to an owner that is still there",
    ).toHaveLength(1);
  });
});
