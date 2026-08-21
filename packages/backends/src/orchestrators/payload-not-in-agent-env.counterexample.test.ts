import type { CaseJob } from "@everdict/contracts";
import { JOB_PAYLOAD_FILE_ENV } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { buildK8sJob } from "./k8s.js";
import { buildNomadJob } from "./nomad.js";

// ── THE PAYLOAD IS NOT IN THE ENVIRONMENT THE AGENT IS EXEC'D WITH (arch-review 59 follow-through) ───
//
// `takeJobPayload` (arch-review 58) deleted the payload variable at the moment it was read, which closed
// INHERITANCE. It did not close `/proc`: `delete process.env.X` edits this process's copy, while
// `/proc/<pid>/environ` reports what the process was EXECVE'd with and keeps reporting it. Verified by
// execution, and the deciding result is that a child exec'd with a COMPLETELY clean environment — an explicit
// allowlist, no inheritance at all — reads it out of the parent anyway:
//
//     tr '\0' '\n' < /proc/1/environ | grep EVERDICT_CASE_JOB
//
// So nothing done at the exec site closes it, and the payload — the workspace's repo token, its registry
// passwords, the judge key resolved for this dispatch, and `evalCase.graders`, which in an evaluation product
// is the answer key — must not arrive in the initial environment at all.
//
// This is the MANIFEST half: whatever each lane does, the container that runs the agent may not be handed the
// bytes. Asserted over both lanes in one file, because it is one invariant that has to hold in two places and
// an invariant written twice grows its next exception in one of them — the shape rule `backends` names.
//
// Seen RED before the transport moved, observed:
//   the agent's container is exec'd with the job payload in its environment: expected 'eyJ0ZW5hbnQiOiJhY21…'
//   to be undefined

const SECRETS = ["sk-repo-token-must-not-leak", "sk-judge-must-not-leak", "sk-registry-must-not-leak"];

const JOB = (): CaseJob =>
  ({
    tenant: "acme",
    runId: "evd-run-r1",
    harness: { id: "h", version: "1" },
    evalCase: { id: "c1", task: "t", env: { kind: "prompt" }, graders: [], timeoutSec: 60, tags: [] },
    repoToken: SECRETS[0],
    judgeAuth: { apiKey: SECRETS[1] },
    registryAuths: [{ host: "ghcr.io", username: "u", password: SECRETS[2] }],
  }) as unknown as CaseJob;

const agentEnvK8s = (m: unknown): Record<string, string> => {
  const spec = (
    m as { spec: { template: { spec: { containers: Array<{ env?: Array<{ name: string; value?: string }> }> } } } }
  ).spec.template.spec;
  return Object.fromEntries((spec.containers[0]?.env ?? []).map((e) => [e.name, e.value ?? ""]));
};

const agentEnvNomad = (spec: ReturnType<typeof buildNomadJob>): Record<string, string> =>
  (spec.Job.TaskGroups[0]?.Tasks[0]?.Env ?? {}) as Record<string, string>;

const containsSecret = (v: unknown): boolean => {
  const s = JSON.stringify(v ?? "");
  return SECRETS.some((secret) => s.includes(secret));
};

describe("[R59 COUNTEREXAMPLE] no lane hands the agent's container the job payload", () => {
  it("K8s: the agent's env carries a PATH, and no secret", () => {
    const env = agentEnvK8s(buildK8sJob(JOB(), { image: "runner:1" }, "evd-c1", "ns"));
    expect(
      env.EVERDICT_CASE_JOB,
      "the agent's container is exec'd with the job payload in its environment",
    ).toBeUndefined();
    expect(env[JOB_PAYLOAD_FILE_ENV.case], "the runner was told no path, so it cannot find its payload").toBe(
      "/run/everdict/case",
    );
    expect(containsSecret(env), "a secret from the payload reached the agent's environment by another name").toBe(
      false,
    );
  });

  it("Nomad: the same, and the payload rides a TEMPLATE instead", () => {
    const spec = buildNomadJob(JOB(), { addr: "http://n:4646", image: "runner:1" }, "j1");
    const env = agentEnvNomad(spec);
    expect(env.EVERDICT_CASE_JOB, "the agent's container is exec'd with the job payload in its environment").toBe(
      undefined,
    );
    expect(env[JOB_PAYLOAD_FILE_ENV.case]).toBe("/local/case");
    expect(containsSecret(env)).toBe(false);

    // …and the payload really is somewhere, or this test proves only that the lane forgot to send it.
    const template = spec.Job.TaskGroups[0]?.Tasks[0]?.Templates?.[0];
    expect(template?.DestPath, "the payload was not rendered anywhere the runner can reach").toBe("local/case");
    expect(containsSecret(Buffer.from(template?.EmbeddedTmpl ?? "", "base64").toString("utf8"))).toBe(true);
    expect(template?.Perms).toBe("0600");
  });

  it("K8s: the payload is on the INIT container, which has exited before the agent starts", () => {
    // Where it went, not merely that it left. The init step still holds it in an environment — that is
    // unavoidable, something must write the bytes — but it is a process that no longer exists by the time
    // there is an agent to read `/proc` with.
    const spec = (
      buildK8sJob(JOB(), { image: "runner:1" }, "evd-c1", "ns") as {
        spec: { template: { spec: { initContainers?: Array<{ env?: Array<{ value?: string }> }> } } };
      }
    ).spec.template.spec;
    const initEnv = spec.initContainers?.[0]?.env?.[0]?.value;
    expect(containsSecret(Buffer.from(initEnv ?? "", "base64").toString("utf8"))).toBe(true);
  });

  it("the VERIFIER payload — the hidden tests themselves — is not in an environment either", () => {
    // The one whose disclosure matters most: this payload carries the task's private `tests/` bytes.
    const env = agentEnvK8s(
      buildK8sJob(JOB(), { image: "runner:1" }, "n", "ns", undefined, "dmVyaWZpZXItcGF5bG9hZA=="),
    );
    expect(env.EVERDICT_VERIFIER_JOB, "the verifier's container is exec'd with the hidden tests").toBeUndefined();
    expect(env[JOB_PAYLOAD_FILE_ENV.verifier]).toBe("/run/everdict/verifier");

    const nomad = buildNomadJob(JOB(), { addr: "http://n:4646", image: "runner:1" }, "j1", "dmVyaWZpZXItcGF5bG9hZA==");
    expect(agentEnvNomad(nomad).EVERDICT_VERIFIER_JOB).toBeUndefined();
    expect(nomad.Job.TaskGroups[0]?.Tasks[0]?.Templates?.[0]?.DestPath).toBe("local/verifier");
  });

  it("the fixture really does carry secrets — otherwise every assertion above is vacuous", () => {
    // rule `testing`: a fixture that never reaches the predicate makes an "is it absent?" assertion pass over
    // nothing. The payload must actually contain what this file claims is being kept out of the environment.
    const nomad = buildNomadJob(JOB(), { addr: "http://n:4646", image: "runner:1" }, "j1");
    const payload = Buffer.from(nomad.Job.TaskGroups[0]?.Tasks[0]?.Templates?.[0]?.EmbeddedTmpl ?? "", "base64");
    for (const secret of SECRETS) expect(payload.toString("utf8"), secret).toContain(secret);
    // …and it is base64, which is what makes rendering it through consul-template safe: no `{{` to interpret.
    expect(nomad.Job.TaskGroups[0]?.Tasks[0]?.Templates?.[0]?.EmbeddedTmpl).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});
