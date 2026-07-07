import { describe, expect, it } from "vitest";
import { LocalDriver } from "./local.js";

describe("LocalDriver", () => {
  it("creates the directory and runs even when exec is given a nonexistent relative cwd (regression for missing 'work' in prompt QA)", async () => {
    // Regression: previously, in a prompt env that doesn't create a directory, the harness's default cwd ("work")
    // was missing, so spawn died silently with exit 1 + empty output (the case looked like it "succeeded with an empty result").
    const handle = await new LocalDriver().provision({ os: "linux", needs: ["shell"] });
    try {
      const res = await handle.exec("echo hello > out.txt && cat out.txt", { cwd: "work" });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("hello");
      expect(await handle.readFile("work/out.txt")).toBe("hello\n");
    } finally {
      await handle.dispose();
    }
  });
});
