import { describe, expect, it } from "vitest";
import { takeJobPayload } from "./job-payload-env.js";

// ── THE JOB PAYLOAD IS CONSUMED, NOT LEFT LYING IN THE ENVIRONMENT (arch-review 58 P0) ───────────────
//
// A `CaseJob` is dispatched by base64-ing the WHOLE object into `EVERDICT_CASE_JOB` on the job container.
// The job-runner decodes it at startup and never needs the string again — but nothing removed it, and every
// process the runner starts afterwards inherits it: `LocalDriver` execs with `{ ...process.env, ...opts.env }`,
// and the process it execs is the AGENT UNDER TEST, running arbitrary code with permissions deliberately
// disabled. One `echo $EVERDICT_CASE_JOB | base64 -d` reads:
//
//   · `repoToken`             — the workspace-scoped token used to clone private repositories
//   · `registryAuths[].password` — the tenant's registry credentials
//   · `judgeAuth.apiKey`     — the tenant's provider key, resolved for THIS dispatch
//   · `evalCase.graders`     — the grading configuration: for an evaluation product, the answer key
//
// The last one is the one that is not merely a leak. arch-review 56 Wave B built a whole refusal so that a
// case grading on hidden material could not be handed to the agent, and Wave K built a second container so
// the judging half runs where the agent is not. Both of those protect the SPLIT path; the payload env made
// the ordinary path hand over the rubric anyway, to any agent that thought to look at its own environment.
//
// The repair is to make reading it the same act as removing it — a function that returns the value and
// deletes the variable, so a caller cannot get the payload and leave it behind. A discipline ("remember to
// unset it") is the shape that failed; this is the shape that cannot.
//
// Seen RED with the deletion neutralized (a missing-module red would have proved nothing — rule `testing`,
// the vacuous-pass rules), observed:
//   the agent under test inherits the job payload, which carries the repo token, the registry passwords,
//   the provider key and the grading configuration: expected 'cGF5bG9hZA==' to be undefined

describe("[R58 COUNTEREXAMPLE] the job payload does not survive into the agent's environment", () => {
  const withEnv = <T>(vars: Record<string, string | undefined>, body: () => T): T => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return body();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it("returns the payload and removes it in the same act", () => {
    withEnv({ EVERDICT_CASE_JOB: "cGF5bG9hZA==", EVERDICT_VERIFIER_JOB: undefined }, () => {
      const taken = takeJobPayload();
      expect(taken.kind).toBe("case");
      expect(taken.kind === "case" && taken.payload).toBe("cGF5bG9hZA==");
      expect(
        process.env.EVERDICT_CASE_JOB,
        "the agent under test inherits the job payload, which carries the repo token, the registry passwords, the provider key and the grading configuration",
      ).toBeUndefined();
    });
  });

  it("removes the VERIFIER payload too — it carries the hidden tests themselves", () => {
    // Worse than the case payload if it leaked into the wrong container: `EVERDICT_VERIFIER_JOB` holds the
    // task's private `tests/` bytes. It is only ever set on the second unit, where no agent runs — and
    // "no agent runs there today" is a fact about the current lanes, not a property of the value.
    withEnv({ EVERDICT_VERIFIER_JOB: "dmVyaWZpZXI=", EVERDICT_CASE_JOB: undefined }, () => {
      const taken = takeJobPayload();
      expect(taken.kind).toBe("verifier");
      expect(process.env.EVERDICT_VERIFIER_JOB).toBeUndefined();
    });
  });

  it("removes BOTH names even when it answers with one", () => {
    // A container that somehow carried both must not keep the one that lost the branch.
    withEnv({ EVERDICT_CASE_JOB: "Y2FzZQ==", EVERDICT_VERIFIER_JOB: "dmVyaWZpZXI=" }, () => {
      takeJobPayload();
      expect(process.env.EVERDICT_CASE_JOB).toBeUndefined();
      expect(process.env.EVERDICT_VERIFIER_JOB).toBeUndefined();
    });
  });

  it("says plainly when there is no payload, rather than answering an empty one", () => {
    withEnv({ EVERDICT_CASE_JOB: undefined, EVERDICT_VERIFIER_JOB: undefined }, () => {
      expect(takeJobPayload().kind).toBe("absent");
    });
  });
});
