import { defineConfig } from "vitest/config";

// Same reason as `packages/job-runner`: every suite here drives a real subprocess (that is what a Driver is),
// so vitest's 5s default is the wrong budget for the whole package rather than for one case in it.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
