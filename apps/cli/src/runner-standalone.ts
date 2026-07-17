import { AppError } from "@everdict/contracts";
import { parseFlags } from "./flags.js";
import { runnerCommand } from "./runner-command.js";

// Standalone self-hosted-runner entry — the bundle target for the distributable `everdict-runner` binary. It runs ONLY
// the runner lease loop (no `run`/`worker`/`suite`/`image` subcommands), so it never imports @everdict/orchestrator and
// esbuild can inline the whole dependency graph into one file (Temporal's native bindings, which only the full CLI's
// orchestrator path needs, are excluded). Distributed via `install.sh` → GitHub Release asset.
// Design: docs/architecture/runner-distribution.md.
async function main(): Promise<void> {
  // Accept both `everdict-runner --pair …` and `everdict-runner runner --pair …` (parity with `everdict runner …`).
  const argv = process.argv.slice(2);
  const rest = argv[0] === "runner" ? argv.slice(1) : argv;
  try {
    await runnerCommand(parseFlags(rest));
  } catch (err) {
    if (err instanceof AppError) {
      console.error(`✗ ${err.code}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

void main();
