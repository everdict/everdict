import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOB_PAYLOAD_FILE_ENV } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { takeJobPayload } from "./job-payload-env.js";

// ── THE JOB PAYLOAD IS CONSUMED, NOT LEFT WHERE THE AGENT CAN READ IT (arch-review 58 P0 · 59) ───────
//
// A `CaseJob` used to be dispatched by base64-ing the WHOLE object into `EVERDICT_CASE_JOB` on the job
// container. The job-runner decodes it at startup and never needs the string again — but nothing removed it,
// and every process the runner starts afterwards inherits it: `LocalDriver` execs with
// `{ ...process.env, ...opts.env }`, and the process it execs is the AGENT UNDER TEST, running arbitrary code
// with permissions deliberately disabled. One `echo $EVERDICT_CASE_JOB | base64 -d` reads:
//
//   · `repoToken`             — the workspace-scoped token used to clone private repositories
//   · `registryAuths[].password` — the tenant's registry credentials
//   · `judgeAuth.apiKey`     — the tenant's provider key, resolved for THIS dispatch
//   · `evalCase.graders`     — the grading configuration: for an evaluation product, the answer key
//
// The last one is the one that is not merely a leak. arch-review 56 Wave B built a whole refusal so that a
// case grading on hidden material could not be handed to the agent, and Wave K built a second container so
// the judging half runs where the agent is not. Both protect the SPLIT path; the payload env made the
// ordinary path hand over the rubric anyway, to any agent that thought to look at its own environment.
//
// R58's repair made reading it the same act as removing it. R59 found that this bounded INHERITANCE and not
// `/proc`: `delete process.env.X` edits this process's copy, while `/proc/<pid>/environ` reports what the
// process was EXECVE'd with and keeps reporting it — verified by execution, including that a child exec'd
// with a COMPLETELY clean environment reads it out of the parent anyway. So the transport changed: the
// payload is a FILE (a Nomad template, a K8s initContainer's write into a tmpfs emptyDir) and the environment
// carries only its path.
//
// The seam did not change, which is the point of having had one. `takeJobPayload` is still the only way to
// obtain the payload and it still destroys it in the same act — `unlink` now, where it was `delete` before.
//
// Seen RED with the removal neutralized (a missing-module red would have proved nothing — rule `testing`,
// the vacuous-pass rules), observed:
//   the agent under test can still read the job payload, which carries the repo token, the registry
//   passwords, the provider key and the grading configuration: expected true to be false

describe("[R58/R59 COUNTEREXAMPLE] the job payload does not survive into the agent's reach", () => {
  // A container's payload directory, as a lane renders it: the file exists, and the environment names it.
  const withPayloadFiles = <T>(files: Partial<Record<"case" | "verifier", string>>, body: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), "everdict-payload-"));
    const saved = Object.fromEntries(
      Object.values(JOB_PAYLOAD_FILE_ENV).map((k) => [k, process.env[k]] as const),
    ) as Record<string, string | undefined>;
    for (const [kind, value] of Object.entries(files)) {
      const path = join(dir, kind);
      writeFileSync(path, value as string, { mode: 0o600 });
      process.env[JOB_PAYLOAD_FILE_ENV[kind as "case" | "verifier"]] = path;
    }
    try {
      return body(dir);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("returns the payload and UNLINKS it in the same act", () => {
    withPayloadFiles({ case: "cGF5bG9hZA==" }, (dir) => {
      const path = join(dir, "case");
      const taken = takeJobPayload();
      expect(taken.kind).toBe("case");
      expect(taken.kind === "case" && taken.payload).toBe("cGF5bG9hZA==");
      expect(
        existsSync(path),
        "the agent under test can still read the job payload, which carries the repo token, the registry passwords, the provider key and the grading configuration",
      ).toBe(false);
      // …and the name goes too: a stale path pointing at nothing is a thing a future reader has to reason
      // about, and this process has no further use for it.
      expect(process.env[JOB_PAYLOAD_FILE_ENV.case]).toBeUndefined();
    });
  });

  it("removes the VERIFIER payload too — it carries the hidden tests themselves", () => {
    // Worse than the case payload if it leaked into the wrong container: this one holds the task's private
    // `tests/` bytes. It is only ever rendered on the second unit, where no agent runs — and "no agent runs
    // there today" is a fact about the current lanes, not a property of the value.
    withPayloadFiles({ verifier: "dmVyaWZpZXI=" }, (dir) => {
      const taken = takeJobPayload();
      expect(taken.kind).toBe("verifier");
      expect(existsSync(join(dir, "verifier"))).toBe(false);
    });
  });

  it("removes BOTH files even when it answers with one", () => {
    // A container that somehow carried both must not keep the one that lost the branch — the discipline the
    // env version had, applied to files.
    withPayloadFiles({ case: "Y2FzZQ==", verifier: "dmVyaWZpZXI=" }, (dir) => {
      takeJobPayload();
      expect(existsSync(join(dir, "case")), "the losing branch's payload stayed on disk").toBe(false);
      expect(existsSync(join(dir, "verifier"))).toBe(false);
    });
  });

  it("removes the bytes even when the payload is EMPTY — which answers `absent`", () => {
    // An empty file is not a payload, and the branch that decides that must not be the branch that decides
    // whether to remove it. The removal is in a `finally` for exactly this.
    withPayloadFiles({ case: "" }, (dir) => {
      expect(takeJobPayload().kind).toBe("absent");
      expect(existsSync(join(dir, "case")), "an empty payload file was left where the agent could reach it").toBe(
        false,
      );
    });
  });

  it("does not take the process down when the path names something that is not a file", () => {
    // A lane that set the variable wrong is a dispatch failure, not a crash before any result can be
    // produced — and it is why the removal is an `unlink` rather than a recursive delete: refusing to remove
    // a non-file is bounded, while getting a recursive delete's path wrong is not.
    const dir = mkdtempSync(join(tmpdir(), "everdict-payload-"));
    process.env[JOB_PAYLOAD_FILE_ENV.case] = dir;
    try {
      expect(() => takeJobPayload(), "a misconfigured payload path crashed the runner").not.toThrow();
      expect(existsSync(dir), "a directory the lane named was recursively deleted").toBe(true);
    } finally {
      delete process.env[JOB_PAYLOAD_FILE_ENV.case];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REFUSES to hand on a payload whose name it could not remove", async () => {
    // The contract this function exists to keep is "the only way to obtain it is a call that has already
    // destroyed it". The first version read the file and unlinked it in a `finally` with the failure
    // SWALLOWED — so a read that succeeded and an unlink that failed (a read-only mount, a permission the
    // lane got wrong, ENOSPC on the metadata write) returned the payload and left the bytes exactly where the
    // agent could reach them (arch-review 60 P1-security).
    //
    // Made to fail the way a real deployment fails: the payload sits in a directory this process may read and
    // traverse but not WRITE, which is what an unlink needs. Skipped as root, where no mode denies anything.
    const dir = mkdtempSync(join(tmpdir(), "everdict-payload-"));
    const path = join(dir, "case");
    writeFileSync(path, "cGF5bG9hZA==", { mode: 0o600 });
    chmodSync(dir, 0o500);
    process.env[JOB_PAYLOAD_FILE_ENV.case] = path;
    try {
      if (process.getuid?.() === 0) return; // root ignores the directory's write bit; the claim is untestable here
      expect(() => takeJobPayload(), "a payload whose name could not be removed was handed on anyway").toThrow(
        /EACCES|EPERM/,
      );
      // …and it is still there, which is the point: refusing is the only honest answer once it cannot be
      // destroyed. A dispatch that dies here dies before the agent starts.
      chmodSync(dir, 0o700);
      expect(existsSync(path)).toBe(true);
    } finally {
      delete process.env[JOB_PAYLOAD_FILE_ENV.case];
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says plainly when there is no payload, rather than answering an empty one", () => {
    withPayloadFiles({}, () => {
      expect(takeJobPayload().kind).toBe("absent");
    });
  });

  it("does not read the payload out of the ENVIRONMENT any more — that transport is gone", () => {
    // The escape hatch, deleted rather than left beside the new path (rule `protocol`): a fallback that stays
    // alive is a lane free to keep the old transport, and the exposure would survive in whichever one nobody
    // re-read.
    // The name this repo no longer knows, set the way a stale lane would set it. Restored through the same
    // computed-key helper the fixtures use — a literal `delete process.env.X` is what `noDelete` refuses.
    const OLD_NAME = "EVERDICT_CASE_JOB";
    const saved = process.env[OLD_NAME];
    process.env[OLD_NAME] = "cGF5bG9hZA==";
    try {
      expect(takeJobPayload().kind, "the environment transport is still live beside the file one").toBe("absent");
    } finally {
      if (saved === undefined) delete process.env[OLD_NAME];
      else process.env[OLD_NAME] = saved;
    }
  });

  it("the file it reads is the one a lane wrote at 0600", () => {
    // Non-vacuous fixture check: if `withPayloadFiles` stopped writing anything, every assertion above would
    // pass over an absent file and prove nothing.
    withPayloadFiles({ case: "cGF5bG9hZA==" }, (dir) => {
      expect(readFileSync(join(dir, "case"), "utf8")).toBe("cGF5bG9hZA==");
    });
  });
});
