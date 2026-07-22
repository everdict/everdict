import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// `package:runner` bundles each @everdict/* workspace dep through its built `dist/` (esbuild.mjs resolves package
// `exports`) before grafting the Node SEA. If those dists are stale, the standalone runner binary bakes in old code —
// e.g. an out-of-date @everdict/contracts Zod enum, which then makes the runner reject a newer leased job with
// `invalid_enum_value`. Unlike release CI (which runs the turbo build as a prior step), a local `pnpm package:runner`
// bypasses turbo's graph, so the script itself MUST build the dependency chain before bundling. Guard that ordering.
describe("cli package:runner script", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: { "package:runner": string };
  };
  const pkg = manifest.scripts["package:runner"];

  it("builds every workspace dependency (turbo) BEFORE esbuild bundles them, so no stale dist is baked in", () => {
    const turboAt = pkg.indexOf("turbo run build");
    const esbuildAt = pkg.indexOf("esbuild.mjs");
    expect(turboAt).toBeGreaterThanOrEqual(0); // the dependency chain is built as part of packaging …
    expect(esbuildAt).toBeGreaterThanOrEqual(0);
    expect(turboAt).toBeLessThan(esbuildAt); // … and it happens first (fresh dist before the bundle reads it)
  });

  it("bundles (esbuild) before the Node SEA graft assembles the binary", () => {
    expect(pkg.indexOf("esbuild.mjs")).toBeLessThan(pkg.indexOf("sea-build.mjs"));
  });
});
