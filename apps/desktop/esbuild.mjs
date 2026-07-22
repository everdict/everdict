// A single bundle for packaging — instead of putting the pnpm workspace's symlinked node_modules into the asar,
// bundle main (ESM) / preload (CJS) each into one file (including @everdict/runner-core). Only electron is external.
// The gate (turbo build) stays tsc (dist/) — this script is for `pnpm package` only.
//
// INVARIANT: this resolves each @everdict/* workspace dep through its package `exports` → its built `dist/`, so a stale
// dist gets baked into the bundle verbatim (e.g. an out-of-date @everdict/contracts Zod enum → the runner rejects a
// newer leased job with `invalid_enum_value`). The `package` script therefore runs `turbo run build --filter` FIRST so
// every upstream dist is fresh before we bundle; never invoke this script directly on an unbuilt tree.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "bundle/main.js",
  external: ["electron"],
  // Boilerplate to keep CJS dependencies (that use require) working in the ESM bundle.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  // Default server URL baked into release builds (D8) — CI injects it via EVERDICT_DESKTOP_DEFAULT_WEB_URL (unset = empty → the setup screen).
  define: {
    __EVERDICT_DEFAULT_WEB_URL__: JSON.stringify(process.env.EVERDICT_DESKTOP_DEFAULT_WEB_URL ?? ""),
  },
});

await build({
  entryPoints: ["src/preload.cts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "bundle/preload.cjs",
  external: ["electron"],
});
