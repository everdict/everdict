#!/usr/bin/env node
// Slim agent-image guard (re-architecture P0).
// Walks @everdict/agent's workspace dependency cone transitively and checks three invariants:
//   (1) every cone member must be on the allowlist — if a control-plane package (db/auth/backends…)
//       gets pulled into the agent image, the image bloats again.
//   (2) cone members may not depend on "pg" or control-plane @everdict/* packages — DB drivers and
//       the orchestration layer have no business running inside the sandbox.
//   (3) @everdict/contracts (L0) depends on exactly {"zod"} — the contract root stays light forever.
// On violation it prints the offending edge and exits 1. Plain Node, no external deps.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every package allowed inside the agent image (unscoped names under packages/<name>).
const ALLOWLIST = new Set([
  "agent",
  "application-execution", // L2a agent-safe use-cases (imports contracts + domain only — enforced below)
  "contracts",
  "core", // compat shell over contracts + domain (P1e); removed from the cone in the P4 sweep
  "domain", // L1 pure rules (imports contracts only — enforced below)
  "drivers",
  "environments",
  "graders",
  "harnesses",
  "run-case", // compat shell over application-execution (P2a); removed from the cone in the P4 sweep
  "trace",
]);

// Control-plane packages that cone members must never depend on.
const FORBIDDEN = new Set([
  "@everdict/application-control", // L2b control-plane use-cases/ports — never inside the agent image
  "@everdict/db",
  "@everdict/auth",
  "@everdict/registry",
  "@everdict/backends",
  "@everdict/orchestrator",
  "@everdict/suite",
  "@everdict/topology",
  "@everdict/sdk",
  "@everdict/billing",
  "@everdict/datasets",
  "@everdict/storage",
  "@everdict/self-hosted-runner",
]);

const SCOPE = "@everdict/";

// packages directory name == unscoped package name (monorepo convention).
function readPackageJson(unscopedName) {
  const file = path.join(root, "packages", unscopedName, "package.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

const violations = [];
const cone = new Set(["agent"]);
const queue = ["agent"];

// Compute the workspace dependency cone via BFS, checking edge by edge.
while (queue.length > 0) {
  const name = queue.shift();
  const pkg = readPackageJson(name);
  const deps = Object.keys(pkg.dependencies ?? {});
  for (const dep of deps) {
    if (dep === "pg") {
      violations.push(`${SCOPE}${name} -> pg (DB drivers must stay out of the agent cone)`);
      continue;
    }
    if (FORBIDDEN.has(dep)) {
      violations.push(`${SCOPE}${name} -> ${dep} (control-plane package — must not enter the agent cone)`);
      continue;
    }
    if (!dep.startsWith(SCOPE)) continue; // third-party deps other than pg are not judged here
    const unscoped = dep.slice(SCOPE.length);
    if (!ALLOWLIST.has(unscoped)) {
      violations.push(
        `${SCOPE}${name} -> ${dep} (outside the allowlist — widening the cone starts with updating this script's rationale)`,
      );
      continue;
    }
    if (!cone.has(unscoped)) {
      cone.add(unscoped);
      queue.push(unscoped);
    }
  }
}

// (3) The L0 contract root depends on exactly one thing: zod.
const contractsDeps = Object.keys(readPackageJson("contracts").dependencies ?? {}).sort();
if (contractsDeps.length !== 1 || contractsDeps[0] !== "zod") {
  violations.push(`@everdict/contracts dependencies = {${contractsDeps.join(", ")}} (must be exactly {zod})`);
}

// (4) The L1 domain layer depends on exactly one thing: @everdict/contracts — pure by construction.
const domainDeps = Object.keys(readPackageJson("domain").dependencies ?? {}).sort();
if (domainDeps.length !== 1 || domainDeps[0] !== "@everdict/contracts") {
  violations.push(`@everdict/domain dependencies = {${domainDeps.join(", ")}} (must be exactly {@everdict/contracts})`);
}

// (5) The L2a execution layer depends on exactly {contracts, domain} — adapters arrive by injection.
const appExecDeps = Object.keys(readPackageJson("application-execution").dependencies ?? {}).sort();
if (appExecDeps.join(",") !== "@everdict/contracts,@everdict/domain") {
  violations.push(
    `@everdict/application-execution dependencies = {${appExecDeps.join(", ")}} (must be exactly {@everdict/contracts, @everdict/domain})`,
  );
}

if (violations.length > 0) {
  console.error("agent cone check FAILED:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log(`PASS agent cone: ${[...cone].sort().join(", ")}`);
