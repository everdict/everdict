import type { CaseJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { buildK8sJob } from "./k8s.js";
import { buildNomadJob } from "./nomad.js";

// ── THE AGENT UNDER TEST DOES NOT GET THE WORKSPACE'S SECRETS (arch-review 58 follow-through) ────────
//
// The managed lanes injected `secretsFor(tenant)` — the tenant's ENTIRE secret tier — into the eval job's
// environment. That tier is every secret the workspace ever stored: its GitHub App token, its Mattermost
// bot token, its registry passwords, whatever a member saved for an integration. The process that runs in
// that container is arbitrary code being evaluated, `LocalDriver` execs it with `{ ...process.env }`, and
// reading all of it was one `env` away.
//
// It was never a decision — it was a default that outlived its reason. Every channel it used to stand in
// for now exists per job: a harness's DECLARED env is resolved into the job before dispatch, a judge's
// provider key rides as `judgeAuth`, and the runner reads only `HARNESS_AUTH_ENV_VARS` from its own
// environment. So the tier is filtered to that vocabulary and nothing else crosses.
//
// This is the third of the three exposures found in this wave, and the only one that was deliberate. The
// other two — the job payload left in the environment, and `withJobEnv` putting the provider key on every
// exec — are recorded beside their own changes.
//
// Seen RED with the filter neutralized (the whole tier spread back in), observed:
//   the workspace's GitHub token was handed to the agent under test: expected 'ghp_secret' to be undefined

const TIER = {
  ANTHROPIC_API_KEY: "sk-ant-for-the-agent",
  GITHUB_TOKEN: "ghp_secret",
  MATTERMOST_BOT_TOKEN: "mm_secret",
  ACME_INTERNAL_DB_PASSWORD: "hunter2",
};

const job = (): CaseJob =>
  ({
    tenant: "acme",
    runId: "evd-run-r1",
    harness: { id: "h", version: "1" },
    evalCase: { id: "c1", task: "t", env: { kind: "prompt" }, graders: [] },
  }) as unknown as CaseJob;

const envOf = (spec: ReturnType<typeof buildNomadJob>): Record<string, string> => {
  const task = spec.Job.TaskGroups[0]?.Tasks[0];
  if (!task) throw new Error("no task in the job spec");
  return task.Env as Record<string, string>;
};

describe("[R58 COUNTEREXAMPLE] an eval container gets model auth, not the workspace's secrets", () => {
  it("REFUSES to hand over a secret the harness has no business reading", () => {
    const env = envOf(buildNomadJob(job(), { addr: "http://n:4646", image: "runner:1", secretEnv: TIER }));
    expect(env.GITHUB_TOKEN, "the workspace's GitHub token was handed to the agent under test").toBeUndefined();
    expect(env.MATTERMOST_BOT_TOKEN).toBeUndefined();
    expect(env.ACME_INTERNAL_DB_PASSWORD, "an arbitrary workspace secret reached the agent").toBeUndefined();
  });

  it("still hands over the model credential the harness runs on", () => {
    // The filter must not break the thing the tier was injected FOR. A harness with no key cannot run at
    // all, which would turn a security fix into an outage.
    const env = envOf(buildNomadJob(job(), { addr: "http://n:4646", image: "runner:1", secretEnv: TIER }));
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-for-the-agent");
  });

  it("lets the per-job judge credential still win over the tier", () => {
    // `judgeAuthEnv` is applied after the tier on purpose — a key resolved for THIS dispatch beats a
    // workspace default. Filtering must not reorder that.
    const withJudge = {
      ...job(),
      judge: { provider: "anthropic", model: "claude-opus-5" },
      judgeAuth: { apiKey: "sk-ant-for-this-dispatch" },
    } as unknown as CaseJob;
    const env = envOf(buildNomadJob(withJudge, { addr: "http://n:4646", image: "runner:1", secretEnv: TIER }));
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-for-this-dispatch");
  });

  it("passes nothing when the tier holds no model credential at all", () => {
    const env = envOf(
      buildNomadJob(job(), { addr: "http://n:4646", image: "runner:1", secretEnv: { GITHUB_TOKEN: "ghp_secret" } }),
    );
    expect(Object.values(env)).not.toContain("ghp_secret");
  });

  it("holds on the K8S TWIN too — exposure must not depend on the orchestrator", () => {
    // Both lanes call the same filter for exactly this reason. Two hand-written filters is how a tenant's
    // exposure comes to depend on which cluster their runtime happens to point at.
    const spec = buildK8sJob(job(), { image: "runner:1", secretEnv: TIER }, "evd-c1", "default") as unknown as {
      spec: { template: { spec: { containers: Array<{ env?: Array<{ name: string; value?: string }> }> } } };
    };
    const container = spec.spec.template.spec.containers[0];
    const names = (container?.env ?? []).map((e) => e.name);
    expect(names, "the k8s lane handed the workspace's GitHub token to the agent").not.toContain("GITHUB_TOKEN");
    expect(names).toContain("ANTHROPIC_API_KEY");
  });
});
