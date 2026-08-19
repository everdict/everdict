import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaseJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { harnessSpecFrom, withHarnessSpec } from "./harness-spec.js";

const dir = mkdtempSync(join(tmpdir(), "everdict-cli-spec-"));
const write = (name: string, body: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
};

const JOB: CaseJob = {
  evalCase: { id: "c1", env: { kind: "prompt" }, task: "do X", graders: [], timeoutSec: 60, tags: [] },
  harness: { id: "claude-code", version: "cli" },
};

describe("--harness-spec", () => {
  it("loads a command spec so any CLI agent is evaluable without a code adapter", () => {
    const path = write("cmd.json", {
      kind: "command",
      id: "some-agent",
      version: "1.0.0",
      command: "node run.mjs {{task}}",
    });
    const spec = harnessSpecFrom(path);
    expect(spec?.kind).toBe("command");
    expect(spec?.id).toBe("some-agent");
  });

  it("is absent when the flag is absent — the built-in adapters keep working unchanged", () => {
    expect(harnessSpecFrom(undefined)).toBeUndefined();
    expect(withHarnessSpec(JOB, undefined)).toBe(JOB);
  });

  it("the spec names the harness on the job, so the scorecard cannot disagree with what ran", () => {
    const spec = harnessSpecFrom(
      write("named.json", { kind: "command", id: "digo-agent", version: "1.2.0", command: "x {{task}}" }),
    );
    const job = withHarnessSpec(JOB, spec);
    expect(job.harness).toEqual({ id: "digo-agent", version: "1.2.0" });
    expect(job.harnessSpec).toBe(spec);
    expect(job.evalCase).toBe(JOB.evalCase); // the case is untouched — a harness swap is not a dataset change
  });

  it("a malformed spec throws at load instead of silently falling back to a built-in adapter", () => {
    const path = write("bad.json", { kind: "command", id: "no-command", version: "1.0.0" });
    expect(() => harnessSpecFrom(path)).toThrow();
  });
});
