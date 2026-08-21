import type { CaseJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { buildK8sJob } from "./k8s.js";
import { buildNomadJob } from "./nomad.js";

// ── A GRADER-ONLY API IS NOT A GRADER-ONLY PROCESS (arch-review 59 P0-security) ──────────────────────
//
// arch-review 58 moved the judge's provider key off the driver wrapper and onto `runCase`'s `graderEnv`, so
// the harness's compute no longer carries it. That was the right move and it changed nothing on the managed
// lanes, because the credential does not reach the runner through the payload alone — the BACKEND also puts
// `judgeAuthEnv(job.judge, job.judgeAuth)` into the pod/task environment. The job-runner process therefore
// holds it in `process.env`, and `LocalDriver` execs the agent under test with `{ ...process.env, ...opts.env }`:
//
//     env | grep ANTHROPIC_API_KEY
//
// No bypass, no /proc, no race. A narrower consumer in TypeScript is not a narrower PROCESS, and the commit
// that claimed "the harness's environment no longer contains a credential it never needed" was true only for
// the lanes whose parent never received one.
//
// The injection is also redundant now. The runner builds the judge env from `job.judgeAuth` — a field on the
// payload it already decodes — and hands it to the grading half. Nothing reads it out of the environment. So
// the env entry is pure exposure, and removing it is not a trade.
//
// What this does NOT close, stated so the next reader does not assume it: the payload itself still carries
// `judgeAuth.apiKey`, `repoToken` and the registry passwords, and `/proc/<pid>/environ` reports the
// environment a process was EXECVE'd with regardless of later deletes. Closing that needs the envelope off
// the environment entirely — see rule `protocol`, "a secret in a process's initial environment".
//
// Seen RED before the injection was removed, observed:
//   the agent's own environment carries the tenant's judge key: expected 'sk-judge' to be undefined

const job = (): CaseJob =>
  ({
    tenant: "acme",
    runId: "evd-run-r1",
    harness: { id: "h", version: "1" },
    evalCase: { id: "c1", task: "t", env: { kind: "prompt" }, graders: [], timeoutSec: 60 },
    judge: { provider: "anthropic", model: "claude-opus-5" },
    judgeAuth: { apiKey: "sk-judge" },
  }) as unknown as CaseJob;

const nomadEnv = (): Record<string, string> => {
  const task = buildNomadJob(job(), { addr: "http://n:4646", image: "runner:1" }).Job.TaskGroups[0]?.Tasks[0];
  if (!task) throw new Error("no task");
  return task.Env as Record<string, string>;
};

const k8sEnv = (): Array<{ name: string; value?: string }> => {
  const spec = buildK8sJob(job(), { image: "runner:1" }, "evd-c1", "ns") as unknown as {
    spec: { template: { spec: { containers: Array<{ env?: Array<{ name: string; value?: string }> }> } } };
  };
  return spec.spec.template.spec.containers[0]?.env ?? [];
};

describe("[R59 COUNTEREXAMPLE] the judge's key is not in the environment the agent inherits", () => {
  it("keeps it out of the nomad task env", () => {
    const env = nomadEnv();
    expect(env.ANTHROPIC_API_KEY, "the agent's own environment carries the tenant's judge key").toBeUndefined();
    expect(Object.values(env)).not.toContain("sk-judge");
  });

  it("keeps it out of the k8s pod env", () => {
    // Both lanes or neither: a tenant's exposure must not depend on which orchestrator placed the job.
    const values = k8sEnv().map((e) => e.value);
    expect(values, "the k8s lane hands the agent the tenant's judge key").not.toContain("sk-judge");
  });

  it("still carries the judge's MODEL, which is configuration rather than a credential", () => {
    // The runner and a code judge's script both want to know which model was selected. Removing that too
    // would be a different change, made for no reason.
    expect(nomadEnv().EVERDICT_JUDGE_MODEL).toBeDefined();
  });

  it("still carries the HARNESS's own model key, which the agent legitimately needs", () => {
    // The agent under test has to call a model. That key comes from the workspace tier, filtered to the
    // model-auth vocabulary — a different credential from the judge's, sharing a variable name, which is
    // exactly why removing the judge's from the env had to be checked rather than assumed.
    const task = buildNomadJob(job(), {
      addr: "http://n:4646",
      image: "runner:1",
      secretEnv: { ANTHROPIC_API_KEY: "sk-harness" },
    }).Job.TaskGroups[0]?.Tasks[0];
    expect((task?.Env as Record<string, string>).ANTHROPIC_API_KEY).toBe("sk-harness");
  });
});
