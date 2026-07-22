import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The `package` script bundles each @everdict/* workspace dep through its built `dist/` (esbuild.mjs resolves package
// `exports`). If those dists are stale, the bundle bakes in old code — e.g. an out-of-date @everdict/contracts Zod enum,
// which then makes the resident runner reject a newer leased job with `invalid_enum_value`. Unlike CI (which runs the
// turbo build as a prior step), a local `pnpm package` bypasses turbo's graph entirely, so the script itself MUST build
// the dependency chain before bundling. This guards that ordering against a regression.
describe("desktop package script", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: { package: string };
  };
  const pkg = manifest.scripts.package;

  it("builds every workspace dependency (turbo) BEFORE esbuild bundles them, so no stale dist is baked in", () => {
    const turboAt = pkg.indexOf("turbo run build");
    const esbuildAt = pkg.indexOf("esbuild.mjs");
    expect(turboAt).toBeGreaterThanOrEqual(0); // the dependency chain is built as part of packaging …
    expect(esbuildAt).toBeGreaterThanOrEqual(0);
    expect(turboAt).toBeLessThan(esbuildAt); // … and it happens first (fresh dist before the bundle reads it)
  });

  it("bundles (esbuild) before electron-builder assembles the installer", () => {
    expect(pkg.indexOf("esbuild.mjs")).toBeLessThan(pkg.indexOf("electron-builder"));
  });
});
