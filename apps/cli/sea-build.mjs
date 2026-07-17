// Turn the esbuild bundle into a standalone Node SEA (Single Executable Application) binary — a real
// `everdict-runner` executable with node baked in, so a headless host needs NEITHER everdict NOR node.
// Run AFTER `pnpm bundle` (needs bundle/everdict-runner.cjs). Cross-platform: run once per OS in the release
// matrix (.github/workflows/cli-release.yml). Design: docs/architecture/runner-distribution.md.
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { inject } from "postject";

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const out = isWin ? "bundle/everdict-runner.exe" : "bundle/everdict-runner";
// Node's documented SEA fuse sentinel — the fixed string postject looks for in the node binary to graft the blob.
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

// 1) Generate the SEA blob from the bundle (node reads sea-config.json).
execFileSync(process.execPath, ["--experimental-sea-config", "sea-config.json"], { stdio: "inherit" });

// 2) Copy THIS node binary as the target executable (the SEA graft turns it into everdict-runner).
copyFileSync(process.execPath, out);

// 3) macOS: a signed binary must have its signature removed before injection, then be ad-hoc re-signed after.
if (isMac) execFileSync("codesign", ["--remove-signature", out], { stdio: "inherit" });

// 4) Inject the blob (postject programmatic API — no npx). macOS needs the Mach-O segment name.
await inject(out, "NODE_SEA_BLOB", readFileSync("bundle/sea-prep.blob"), {
  sentinelFuse: SENTINEL,
  ...(isMac ? { machoSegmentName: "NODE_SEA" } : {}),
});

// 5) macOS: ad-hoc re-sign so the OS will run the modified binary.
if (isMac) execFileSync("codesign", ["--sign", "-", out], { stdio: "inherit" });

console.log(`✓ built ${out}`);
