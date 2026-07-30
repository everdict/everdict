import { describe, expect, it } from "vitest";
import { fileRunPlanFor, isRunnableFilePath } from "./run-plan.js";

describe("fileRunPlanFor — how a workspace file gets run", () => {
  it("picks the interpreter from the extension and runs the file by its own name", () => {
    expect(fileRunPlanFor("tasks/abc/report.py")).toEqual({
      image: "python:3.13-slim",
      command: "python './report.py'",
    });
    expect(fileRunPlanFor("deploy.sh")?.command).toBe("bash './deploy.sh'");
    expect(fileRunPlanFor("scripts/build.ts")?.command).toBe("node --experimental-strip-types './build.ts'");
  });

  it("lets a caller swap the image without changing the command", () => {
    const plan = fileRunPlanFor("a/b/analyze.py", "ghcr.io/acme/analysis:2.1.0");

    expect(plan).toEqual({ image: "ghcr.io/acme/analysis:2.1.0", command: "python './analyze.py'" });
  });

  it("quotes the file name, so a name with a space cannot split the command", () => {
    expect(fileRunPlanFor("odd name.py")?.command).toBe("python './odd name.py'");
  });

  it("reports formats it cannot run instead of guessing one", () => {
    expect(fileRunPlanFor("README.md")).toBeUndefined();
    expect(fileRunPlanFor("main.go")).toBeUndefined(); // needs a build step — a different feature
    expect(fileRunPlanFor("Dockerfile")).toBeUndefined();
    expect(isRunnableFilePath("notes.txt")).toBe(false);
    expect(isRunnableFilePath("run.sh")).toBe(true);
  });
});
