#!/usr/bin/env node
// Web runtime-decoupling guard (re-architecture P4).
// The web (apps/web) is a pure HTTP client of the control plane: the ONLY @everdict dependency it may
// carry is TYPE-ONLY @everdict/contracts (wire/record TYPES). This walks every apps/web/src/**/*.{ts,tsx}
// source and enforces two invariants on each `from "@everdict/..."` import:
//   (1) the package must be @everdict/contracts (its /wire subpath included) — importing any OTHER
//       @everdict/* package (domain/api/db/…) couples the web to the control-plane runtime.
//   (2) every @everdict/contracts import must be `import type` — a value/schema import would pull the
//       contracts' zod v3 runtime into the web bundle and break the web's zod-v4 isolation.
// On violation it prints the offending import (file:line) and exits 1. Plain Node, no external deps.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webSrc = path.join(root, "apps", "web", "src");

// Recursively collect .ts/.tsx source files under apps/web/src (skip node_modules just in case).
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

// The only @everdict package the web may import, plus its allowed subpaths.
const ALLOWED = new Set(["@everdict/contracts", "@everdict/contracts/wire"]);

// Match an import STATEMENT that reads from an @everdict/* specifier. `import`, an optional `type`,
// the (possibly multi-line) binding, `from`, and the quoted specifier. The `[\s\S]*?` spans newlines so
// multi-line `import type { A,\n  B } from '@everdict/…'` is caught as one statement.
const importRe = /import\s+(type\s+)?[\s\S]*?from\s*["']([^"']+)["']/g;

const violations = [];
for (const file of collect(webSrc)) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(importRe)) {
    const isTypeOnly = Boolean(m[1]);
    const spec = m[2];
    if (!spec.startsWith("@everdict/")) continue;
    // Report as file:line for a clickable location.
    const line = src.slice(0, m.index).split("\n").length;
    const where = `${path.relative(root, file)}:${line}`;
    if (!ALLOWED.has(spec)) {
      violations.push(`${where} -> ${spec} (web may only import @everdict/contracts — no other @everdict package)`);
      continue;
    }
    if (!isTypeOnly) {
      violations.push(
        `${where} -> ${spec} (must be \`import type\` — a value import pulls the contracts' zod v3 runtime into the web)`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("web imports check FAILED:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log("PASS web imports: only type-only @everdict/contracts imports in apps/web");
