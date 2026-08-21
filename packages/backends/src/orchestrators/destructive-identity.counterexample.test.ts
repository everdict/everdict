import type { CaseJob, RegistryAuth } from "@everdict/contracts";
import { registryAuthSecretName } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { buildK8sJob, k8sRegistryAuthSecret, runLabelValue } from "./k8s.js";

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

  it("names the pull Secret after the GRANT, so two dispatches cannot overwrite each other", () => {
    const a: RegistryAuth = { host: "ghcr.io", username: "u", password: "grant-a" };
    const b: RegistryAuth = { host: "ghcr.io", username: "u", password: "grant-b" };
    expect(registryAuthSecretName(a), "two dispatches with different grants share one Secret").not.toBe(
      registryAuthSecretName(b),
    );
    // …and the same grant is the same Secret, so an idempotent apply stays idempotent.
    expect(registryAuthSecretName(a)).toBe(registryAuthSecretName({ ...a }));
  });

  it("makes the Job reference the Secret its own grant produced", () => {
    // The two halves have to agree, or the pod references a Secret nobody applied — which is a pull failure
    // rather than a wrong credential, but it is the same defect: a name decided in two places.
    const auth: RegistryAuth = { host: "ghcr.io", username: "u", password: "grant-a" };
    const spec = buildK8sJob(job(auth), { image: "runner:1" }, "evd-c1", "ns");
    const applied = k8sRegistryAuthSecret(auth, "ns") as { metadata: { name: string } };
    expect(pullSecretOf(spec), "the pod references a Secret this dispatch did not apply").toBe(applied.metadata.name);
  });
});
