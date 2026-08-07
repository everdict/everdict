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

  it("refuses a desktop need pre-flight (os-use case) — a container is not a desktop world", async () => {
    const driver = new DockerDriver({ defaultImage: "example/image:1" });
    await expect(driver.provision({ os: "linux", needs: ["shell", "desktop"] })).rejects.toThrow(/desktop world/);
  });

  it("lets a browser need flow through the pre-flight gates — the image is what satisfies it", async () => {
    // A browser-use bundle's image carries headless chromium; the driver cannot know, so it must not refuse.
    // No docker binary in CI: reaching the pull/run stage (past every pre-flight guard) proves the pass-through.
    const driver = new DockerDriver({ defaultImage: "example/browser-bundle:1" });
    const err = await driver.provision({ os: "linux", needs: ["shell", "browser"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toMatch(/BAD_REQUEST|desktop world/); // failed at docker exec, not at the gate
  });
});
