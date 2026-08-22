import type { CaseJob, RegistryAuth } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { buildK8sJob, k8sRegistryAuthSecret, pullCredentialsFor, runLabelValue, workPullSecretName } from "./k8s.js";

// ── AN IDENTIFIER THAT DECIDES A DESTRUCTIVE OR CREDENTIAL SCOPE IS INJECTIVE (arch-review 59) ───────
//
// Two names in the K8s lane are used as if they identified one thing and do not.
//
// THE LABEL DIGEST. A run id longer than a label value gets truncated and a digest appended, and the digest
// was 8 hex characters — 32 bits. Its own comment called that "collision-free at any batch size we place",
// which is not a property 32 bits has: it is a birthday bound, not a guarantee, and this label is what the
// sibling sweep selects on to KILL. A collision there puts another run's jobs in the blast radius of a stop.
// The exact `RuntimeWorkRef.externalJobId` is the primary coordinate, which is why this is not a P0 — but a
// destructive selector is the last place to spend an identifier that is merely probably unique.
//
// THE PULL SECRET. `imagePullSecrets` referenced one fixed name per namespace, so two dispatches in one
// tenant namespace with different registry grants overwrite each other's Secret. The pod that pulls after
// the other's update pulls with the other's credential: the image fails, or it succeeds under an account
// that was never granted it, and a short-lived grant's recipient isolation is gone. Verifier fan-out makes
// this ordinary rather than rare, because it doubles the dispatch rate against the same namespace.
//
// Both are the same law in different clothes: a name that scopes an effect must be derived from what makes
// the effect distinct, not from what is convenient to write down.
//
// Seen RED before the widening and the per-grant name, observed:
//   a destructive selector spends a 32-bit digest: expected 32 to be greater than or equal to 128
//   two dispatches with different grants share one Secret: expected 'everdict-registry-auth' not to be
//   'everdict-registry-auth'

const LONG = `evd-${"x".repeat(80)}`;

const job = (auth?: RegistryAuth): CaseJob =>
  ({
    tenant: "acme",
    runId: "evd-run-r1",
    harness: { id: "h", version: "1" },
    evalCase: { id: "c1", task: "t", env: { kind: "prompt" }, graders: [], timeoutSec: 60, image: "ghcr.io/x/y:1" },
    ...(auth ? { registryAuths: [auth] } : {}),
  }) as unknown as CaseJob;

const pullSecretOf = (spec: unknown): string | undefined => {
  const s = spec as { spec: { template: { spec: { imagePullSecrets?: Array<{ name: string }> } } } };
  return s.spec.template.spec.imagePullSecrets?.[0]?.name;
};

describe("[R59 COUNTEREXAMPLE] a destructive or credential scope is named by what makes it distinct", () => {
  it("spends more than 32 bits on a label a sweep kills by", () => {
    const value = runLabelValue(LONG);
    const digest = value.slice(value.lastIndexOf("-") + 1);
    expect(digest.length * 4, "a destructive selector spends a 32-bit digest").toBeGreaterThanOrEqual(128);
    // …and still a legal label value, which is the constraint that made it short in the first place.
    expect(value.length).toBeLessThanOrEqual(63);
    expect(value).toMatch(/^[a-z0-9]([-a-z0-9_.]*[a-z0-9])?$/);
  });

  it("keeps the label INJECTIVE — two ids that truncate alike stay different", () => {
    expect(runLabelValue(`${LONG}-a`)).not.toBe(runLabelValue(`${LONG}-b`));
  });

  it("names the pull Secret after the WORK, so two dispatches cannot overwrite each other", () => {
    // R59 content-addressed this name, which closed the collision and left the LIFETIME open: nothing owned
    // the object, so a managed grant with a short-lived password minted a new digest per dispatch and the
    // namespace's Secret count grew without bound, expired credentials sitting in etcd (arch-review 60
    // P1-ops). Per-WORK is both properties at once — two grants can no more collide than two Jobs can, and
    // the Secret has an owner the cluster can collect it by.
    expect(
      workPullSecretName("everdict-c1-aaaa"),
      "two dispatches share one Secret, so a later grant re-credentials an earlier pod",
    ).not.toBe(workPullSecretName("everdict-c1-bbbb"));
    // …and it is still a legal object name derived only from the Job's, so one function answers on both sides.
    expect(workPullSecretName("everdict-c1-aaaa")).toMatch(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/);
  });

  it("makes the Job reference the Secret its own dispatch applies", () => {
    // The two halves have to agree, or the pod references a Secret nobody applied — a pull failure rather
    // than a wrong credential, but the same defect: a name decided in two places.
    const auth: RegistryAuth = { host: "ghcr.io", username: "u", password: "grant-a" };
    const spec = buildK8sJob(job(auth), { image: "runner:1" }, "evd-c1", "ns");
    const applied = k8sRegistryAuthSecret(auth, "ns", workPullSecretName("evd-c1")) as { metadata: { name: string } };
    expect(pullSecretOf(spec), "the pod references a Secret this dispatch did not apply").toBe(applied.metadata.name);
  });

  it("carries BOTH registries' credentials, not the first that matched", () => {
    // `pickRegistryAuth(a, main) ?? pickRegistryAuth(a, runner)` kept exactly ONE, so a private task image on
    // registry A beside a private runner image on registry B produced a docker config covering A only and an
    // init container in ImagePullBackOff (arch-review 61 P1). One docker config authenticates several hosts —
    // that is what `k8sRegistryAuthSecret` has always accepted and what this now hands it.
    const both = pullCredentialsFor(
      {
        registryAuths: [
          { host: "ghcr.io", username: "u", password: "task-grant" },
          { host: "internal.reg", username: "u", password: "runner-grant" },
        ],
      },
      "ghcr.io/acme/task:1",
      "internal.reg/everdict/runner:1",
    );
    expect(both.map((a) => a.host).sort(), "one registry's credential was dropped").toEqual([
      "ghcr.io",
      "internal.reg",
    ]);
    // …and the Secret really carries both hosts, or the pod authenticates to one of them.
    const secret = k8sRegistryAuthSecret(both, "ns", workPullSecretName("n")) as {
      data: Record<string, string>;
    };
    const config = JSON.parse(Buffer.from(secret.data[".dockerconfigjson"] ?? "", "base64").toString());
    expect(Object.keys(config.auths).sort()).toEqual(["ghcr.io", "internal.reg"]);
  });

  it("resolves a pull credential for the INIT image too, not only the agent's", () => {
    // The pod pulls two images: the agent's (possibly the tenant's own task image) and the init step's, which
    // is the runner image. Only the main one was consulted, so a private runner beside a private task image
    // left the init container in ImagePullBackOff and the case never started (arch-review 60 P1-ops).
    const runnerOnly = job({ host: "internal.reg", username: "u", password: "runner-grant" });
    const spec = buildK8sJob(runnerOnly, { image: "internal.reg/everdict/runner:1" }, "evd-c1", "ns");
    expect(pullSecretOf(spec), "the init container's registry was never resolved a credential").toBe(
      workPullSecretName("evd-c1"),
    );
  });
});
