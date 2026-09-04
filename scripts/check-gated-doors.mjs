#!/usr/bin/env node
// ── A DOOR THAT LOCKS ITSELF ON A DEPENDENCY THE COMPOSITION ROOT NEVER PASSES ──────────────────────
//
// A route that feature-gates — `if (!deps.x) return reply.code(404)… "not configured"` — is saying "this
// deployment may legitimately not have x". The same line says nothing about whether ANY deployment has it.
// So a dep the root builds, hands to three services, and forgets to put in `buildServer` leaves the door
// answering 404 forever, and it reads exactly like a feature somebody turned off.
//
// Found twice in one sweep, both shipped:
//   · `environmentRegistry` — every /environments door 404'd, so a world could not be registered through the
//     API and therefore never referenced, while the resolution and the manifest seal behind it worked fine;
//   · `constitutionApprovals` — the dataset ATTEST door 404'd, so the only way to GRANT a ground-truth
//     approval was unreachable while the submit-time refusal that requires one worked.
//
// ⚠️ THIS IS NOT `unwired-capabilities`, AND THAT CHECK CANNOT SEE IT. That one asks whether some composition
// root CONSTRUCTS an implementation of the port, and in both cases one does. "A producer exists ≠ the
// producer reaches this consumer" (rule `protocol`) — and here the consumer is a TRANSPORT, so what has to be
// checked is the argument list of the one call that builds it.
// watches: nothing — matches a 404-shaped refusal in route files.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".routes.ts") || full.endsWith(".mcp.ts")) out.push(full);
  }
  return out;
};

// Every ServerDeps field a transport locks itself on: `if (!deps.x) … reply.code(404)`. The marker is the
// 404, not the sentence beside it.
//
// ⚠️ The first draft matched the literal "not configured", and MISSED ONE OF THE TWO DEFECTS IT WAS WRITTEN
// FOR — `registerEnvironmentRoutes` hoists that sentence into a `const missing`, so the words are not on the
// line. A check that reads prose rather than shape answers about how a door was phrased.
const gated = new Map();
for (const file of walk(path.join(root, "apps/api/src/api"))) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/if \(([^)]*!deps\.[^)]*)\)[\s\S]{0,200}?reply\s*\.?\s*code\(404\)/g))
    for (const d of m[1].matchAll(/!deps\.([A-Za-z0-9_]+)/g)) gated.set(d[1], path.relative(root, file));
}

// …and what the ONE call that builds the transport actually receives. Braces are balanced rather than
// line-matched: the call spans hundreds of lines and carries conditional spreads, and a line-based read of it
// is how the first draft of this check reported seven false positives.
const main = readFileSync(path.join(root, "apps/api/src/main.ts"), "utf8");
const open = main.indexOf("{", main.indexOf("const app = buildServer("));
let depth = 0;
let close = -1;
for (let i = open; i < main.length; i++) {
  if (main[i] === "{") depth += 1;
  else if (main[i] === "}" && --depth === 0) {
    close = i;
    break;
  }
}
if (close === -1) {
  console.error("✖ could not find the buildServer call in apps/api/src/main.ts — this check cannot answer.");
  process.exit(2);
}
// Comments are stripped first. The loose match below counts any mention of the name, and a COMMENT naming
// the dependency it is explaining would then read as wiring — which is not hypothetical: the comment written
// beside the fix for this very defect defeated the check when it was driven against the pre-fix state.
const call = main
  .slice(open, close)
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/[^\n]*/g, " ");
// A name counts as passed if it appears in the argument AT ALL. Deliberately loose: shorthand, a rename and a
// conditional spread are all real wiring, and the spread form `…? { a, b } : {}` puts the last name before a
// brace rather than a comma — which is how the first draft of this check reported four healthy doors as
// broken. A gate that cries wolf teaches people to skip its output, so this errs toward missing a defect
// rather than inventing one; both defects it was written for are names that appear NOWHERE in the call.
const mentioned = (dep) => new RegExp(`\\b${dep}\\b`).test(call);

const missing = [...gated].filter(([dep]) => !mentioned(dep)).sort();
if (missing.length > 0) {
  console.error(`✖ ${missing.length} door(s) gate on a dependency the composition root never passes:\n`);
  for (const [dep, file] of missing)
    console.error(
      `  ${dep}\n    gated in ${file}\n    → add it to the buildServer({ … }) call in apps/api/src/main.ts, or delete the door.`,
    );
  console.error(
    "\nSuch a door answers 404 forever and reads as a feature this deployment declined.\n" +
      "`pnpm unwired-capabilities` cannot see it: the port IS constructed, it just never reaches the transport.",
  );
  process.exit(1);
}
console.log(
  `PASS gated doors: ${gated.size} transport dependenc(ies) answer 404 when a dependency is absent — every one is passed to buildServer.`,
);
