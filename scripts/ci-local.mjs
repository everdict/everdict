#!/usr/bin/env node
// Local CI parity gate — runs everything .github/workflows/ci.yml runs, in the same order.
// Never `git push` red: this script is the "confirm before push" rule (.claude/rules/ci.md, skill `ci`).
// On success with a CLEAN tree it stamps .git/everdict-ci-ok with the HEAD sha; the Claude Code
// PreToolUse hook (scripts/hooks/pre-push-gate.mjs) blocks `git push` unless that stamp matches HEAD
// (CI validates the pushed commit, so a dirty-tree pass proves nothing about HEAD).
// Plain Node, no external deps. Usage: `pnpm ci:local` (or `node scripts/ci-local.mjs`).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GITLEAKS_VERSION = "8.24.3"; // keep in sync with ci.yml
const gitleaksCache = path.join(homedir(), ".cache", "everdict", `gitleaks-${GITLEAKS_VERSION}`, "gitleaks");

function run(label, command, args, opts = {}) {
  const startedAt = Date.now();
  process.stdout.write(`\n▶ ${label}\n`);
  const res = spawnSync(command, args, { cwd: root, stdio: "inherit", ...opts });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (res.status !== 0) {
    console.error(`\n✖ CI-PARITY RED — "${label}" failed after ${seconds}s. Fix it, then re-run pnpm ci:local.`);
    process.exit(1);
  }
  process.stdout.write(`✓ ${label} (${seconds}s)\n`);
}

function resolveGitleaks() {
  const onPath = spawnSync("gitleaks", ["version"], { stdio: "ignore" });
  if (!onPath.error) return "gitleaks";
  if (existsSync(gitleaksCache)) return gitleaksCache;
  process.stdout.write(`\n▶ installing gitleaks v${GITLEAKS_VERSION} (one-time, to ${path.dirname(gitleaksCache)})\n`);
  mkdirSync(path.dirname(gitleaksCache), { recursive: true });
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`;
  const dl = spawnSync("bash", ["-c", `curl -sL ${url} | tar xz -C ${path.dirname(gitleaksCache)} gitleaks`], {
    stdio: "inherit",
  });
  if (dl.status !== 0 || !existsSync(gitleaksCache)) {
    console.error("✖ could not install gitleaks — install it manually and re-run.");
    process.exit(1);
  }
  return gitleaksCache;
}

// Job 1 — core (identical order to ci.yml).
run("pnpm lint", "pnpm", ["lint"]);
run("pnpm typecheck", "pnpm", ["typecheck"]);
run("pnpm test", "pnpm", ["test"]);
run("pnpm build", "pnpm", ["build"]);
run("pnpm cone", "pnpm", ["cone"]);
run("pnpm web-imports", "pnpm", ["web-imports"]);
run("empty-env boot contract", "node", ["scripts/live/empty-env-boot.mjs"]);

// Job 2 — web (self-contained; contracts d.ts already exists via the root build above).
run("web lint", "pnpm", ["-F", "@everdict/web", "lint"]);
run("web build", "pnpm", ["-F", "@everdict/web", "build"]);

// Job 3 — secret scan (full history, same flags as ci.yml).
run("gitleaks (full history)", resolveGitleaks(), [
  "git",
  ".",
  "--config",
  ".gitleaks.toml",
  "--log-opts=--all",
  "--no-banner",
]);

// Stamp — only a clean tree proves HEAD is what we just validated.
const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim();
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
if (dirty) {
  console.log(
    "\n✓ CI-PARITY GREEN — but the tree is DIRTY, so no push stamp was written.\n  Commit first, then re-run pnpm ci:local (turbo cache makes the re-run fast).",
  );
  process.exit(0);
}
writeFileSync(path.join(root, ".git", "everdict-ci-ok"), `${head}\n`);
console.log(`\n✓ CI-PARITY GREEN — stamped ${head.slice(0, 9)} — safe to push.`);
