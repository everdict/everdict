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
// watches: nothing — matches import specifiers.
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

// ─── Invariant 3: a SERVER module never CALLS a value exported by a `'use client'` module ────────────────
// Next.js allows a server component to RENDER a client component, but not to invoke a plain function that
// lives in a client module — it fails at REQUEST time ("Attempted to call x() from the server but x is on
// the client"), which typecheck, lint and the unit tests all miss. It cost a live 500 on the run detail once
// (`asSingleSegment` exported from trajectory-view.tsx); the fix is to keep such helpers in a server-safe
// module. Components are exempt: a Capitalized export is rendered, never called.
const isClientModule = (src) => /^\s*["']use client["']/.test(src);
// Lowercase function/const exports of a client module — the ones a server file could only be CALLING.
function clientValueExports(src) {
  const names = [];
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([a-z][A-Za-z0-9_]*)\s*\(/gm)) names.push(m[1]);
  for (const m of src.matchAll(/^export\s+const\s+([a-z][A-Za-z0-9_]*)\s*[:=]/gm)) names.push(m[1]);
  return names;
}

const files = collect(webSrc);
const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
// name → the client module that owns it (barrels re-export, so the NAME is the key that survives indirection).
const clientOwned = new Map();
for (const [file, src] of sources) {
  if (!isClientModule(src)) continue;
  for (const name of clientValueExports(src)) clientOwned.set(name, path.relative(root, file));
}
// What is DEFINITELY server-side: an App Router file (page/layout/route/template — rendered on the server
// unless it opts out) or a "use server" module (a server action). A plain lib without the directive is NOT
// checked on purpose: Next's boundary is TRANSITIVE, so a helper imported only by client components is itself
// client, and flagging it would be a false positive (it would also fail on *.test.ts, which runs in vitest).
const isServerEntry = (file, src) => {
  if (isClientModule(src) || /\.test\.tsx?$/.test(file)) return false;
  if (/^\s*["']use server["']/.test(src)) return true;
  const rel = path.relative(webSrc, file);
  return rel.startsWith(`app${path.sep}`) && /(?:page|layout|route|template|default|error|loading)\.tsx?$/.test(file);
};
// A named import binding list: `import { a, b as c } from "..."` — the LOCAL name is what a call site uses.
const namedImportRe = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
for (const [file, src] of sources) {
  if (!isServerEntry(file, src)) continue;
  for (const m of src.matchAll(namedImportRe)) {
    if (m[1]) continue; // `import type` never reaches runtime
    for (const raw of m[2].split(",")) {
      const part = raw.trim();
      if (part === "" || part.startsWith("type ")) continue;
      const [imported, local] = part.split(/\s+as\s+/).map((x) => x.trim());
      const owner = clientOwned.get(imported);
      if (!owner) continue;
      // Only a CALL is the failure — a re-export (a barrel) is inert until someone calls it.
      if (!new RegExp(`\\b${local ?? imported}\\s*\\(`).test(src)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      violations.push(
        `${path.relative(root, file)}:${line} -> calls \`${imported}()\` exported by the client module ${owner} (a server component cannot invoke a 'use client' export — move the helper to a server-safe module)`,
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
