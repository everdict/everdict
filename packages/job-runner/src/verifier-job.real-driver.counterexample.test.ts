import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoSnapshot, VerifierJob } from "@everdict/contracts";
import { LocalDriver } from "@everdict/drivers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runVerifierJob } from "./verifier-job.js";

// ── THE VERIFIER RUNS AGAINST A REAL DRIVER, OR IT IS NOT TESTED (arch-review 57, Wave 0) ────────────
//
// There is already a counterexample for this runner. It passes. It passed before arch-review 57 and it passed
// after every fix that review's P0 required, because its fake driver was more generous than any driver that
// ships:
//
//   · `provision()` accepted whatever object it was handed, so a spec with no `os` looked fine — while the
//     real `LocalDriver` refuses anything but `os === "linux"` on its FIRST line;
//   · files lived in a flat `Map`, so `/app/x` written through the file API and `/app/x` named in a shell
//     command were the same key — while the real handle resolves the file API under its root and leaves the
//     shell's absolute paths alone, which is two namespaces;
//   · `exec` answered `git apply` by materialising the file, so a restore could not fail — and the runner
//     did not read the exit code anyway;
//   · `safeGrade` never saw a deadline, and a fake grader does not race one — while the real one computes
//     `Math.max(0, ctx.deadlineAt - Date.now())`, which is NaN when the field is missing, and a NaN timeout
//     fires on the first tick.
//
// Four independent breakages, all green. That is not a gap in coverage; it is a fixture that describes a
// world the production builders cannot produce (rule `testing`, vacuous-pass rules). So this file drives the
// REAL `LocalDriver` over a REAL git repository, and the fake stays only for what it is honest about — the
// dispose-on-throw and refuse-empty-plan shapes, which do not touch a driver's contract.
//
// RED as of 11943e7f, observed, in this order as each was fixed:
//   BAD_REQUEST: LocalDriver provides linux only; the case declared os 'undefined'
//   → git apply exited 128 (the patch was written to a namespace the shell could not see)
//   → tests_pass unmeasured{grader_timeout} (deadlineAt was undefined → NaN → immediate)

const shell = (cwd: string, cmd: string) => execFileSync("bash", ["-lc", cmd], { cwd, encoding: "utf8" });

describe("[R57 WAVE-0 COUNTEREXAMPLE] the verifier reaches a verdict through the driver that ships", () => {
  let root: string;
  let workdir: string;

  beforeEach(async () => {
    // The "container": a directory that plays the role of `/`. The task's repo lives at `<root>/app`, which
    // the job addresses as the absolute `/app` exactly as a container task does.
    root = await mkdtemp(join(tmpdir(), "everdict-verifier-ce-"));
    workdir = join(root, "app");
    shell(root, "mkdir -p app && cd app && git init -q && git config user.email t@t && git config user.name t");
    await writeFile(join(workdir, "solution.py"), "def solve():\n    return 0\n");
    shell(workdir, "git add -A && git commit -q -m seed");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // The agent's work as the environment actually records it: a staged diff against HEAD.
  const agentDiff = async (): Promise<RepoSnapshot> => {
    await writeFile(join(workdir, "solution.py"), "def solve():\n    return 42\n");
    shell(workdir, "git add -A");
    return {
      kind: "repo",
      diff: shell(workdir, "git diff --cached HEAD"),
      changedFiles: ["solution.py"],
      headSha: shell(workdir, "git rev-parse HEAD").trim(),
    };
  };

  const job = (workspace: RepoSnapshot, over: Partial<VerifierJob> = {}): VerifierJob => ({
    runId: "r1",
    tenant: "acme",
    caseId: "c1",
    workdir: "/app",
    workspace,
    timeoutSec: 60,
    plan: {
      digest: "sha256:plan",
      // A command grader is the smallest thing that can only pass if the workspace is really there: it greps
      // the agent's own change out of the file the patch was supposed to restore. Addressed the way a grader
      // addresses anything — a `cwd` plus a relative path — so the assertion is about the SEAM (does the
      // restore land where an exec's cwd resolves?) and holds under any driver root, which is what lets this
      // run outside a container at all.
      graders: [{ id: "command", config: { cwd: "/app", cmd: "grep -q 'return 42' solution.py" } }],
    },
    ...over,
  });

  it("restores the agent's diff into the SAME namespace the graders read, and grades it", async () => {
    const snapshot = await agentDiff();
    // The verifier starts from the pristine commit — the agent's change is only in the diff.
    shell(workdir, "git reset -q && git checkout -- .");
    expect(await readFile(join(workdir, "solution.py"), "utf8")).toContain("return 0");

    const scores = await runVerifierJob(job(snapshot), { driver: new LocalDriver({ root }) });

    // The file the shell sees is the file the restore wrote. If the two namespaces had drifted, the grader
    // would have graded the pristine checkout and this would read `return 0`.
    expect(await readFile(join(workdir, "solution.py"), "utf8")).toContain("return 42");
    expect(scores, "the verifier produced no score at all").toHaveLength(1);
    const verdict = scores[0];
    expect(verdict, `the grader did not pass over the restored work: ${JSON.stringify(verdict)}`).toMatchObject({
      graderId: "command",
      pass: true,
    });
  });

  it("REFUSES to grade when the restore failed — a pristine image is not the agent's work", async () => {
    // A diff that does not apply: it claims a file the repo does not have.
    const broken: RepoSnapshot = {
      kind: "repo",
      diff: "diff --git a/absent.py b/absent.py\n--- a/absent.py\n+++ b/absent.py\n@@ -1 +1 @@\n-gone\n+here\n",
      changedFiles: ["absent.py"],
      // The repository's OWN head. This was an arbitrary string for as long as nothing read `headSha`, and
      // arch-review 58 made the verifier confirm the baseline before applying — an invented one now refuses
      // one step earlier, which would leave this test green for the wrong reason.
      headSha: shell(workdir, "git rev-parse HEAD").trim(),
    };
    await expect(runVerifierJob(job(broken), { driver: new LocalDriver({ root }) })).rejects.toThrow(
      /could not be restored/i,
    );
  });

  it("leaves the root it was GIVEN standing — a verifier does not delete the container it ran in", async () => {
    const snapshot = await agentDiff();
    shell(workdir, "git reset -q && git checkout -- .");
    await runVerifierJob(job(snapshot), { driver: new LocalDriver({ root }) });
    // `dispose()` removes the sandbox it created. This driver was handed one, and in production that root is
    // `/`: a recursive remove there would take the container with it.
    await expect(readFile(join(workdir, "solution.py"), "utf8")).resolves.toContain("return 42");
  });
});
