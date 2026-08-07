import { describe, expect, it } from "vitest";
import { DockerDriver } from "./docker.js";

// The declared-world guard exists on BOTH drivers, but only LocalDriver had a test — DockerDriver's refusal
// was pinned nowhere, and packages/drivers had no docker.test.ts at all. The refusal must fire PRE-FLIGHT
// (before any docker CLI call), which is also what lets this test run without docker installed.

describe("DockerDriver — the declared compute world is honored, never silently substituted", () => {
  it("refuses a declared non-linux world before any execution", async () => {
    const driver = new DockerDriver({ defaultImage: "example/image:1" });
    await expect(driver.provision({ os: "windows", needs: ["shell"] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(driver.provision({ os: "macos", needs: ["shell"] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("refuses a provision with neither spec.image nor defaultImage — still pre-flight", async () => {
    const driver = new DockerDriver();
    await expect(driver.provision({ os: "linux", needs: ["shell"] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
