#!/usr/bin/env node
// ── AN EXPORTED GUARD WITH NO CALLER IS A CHECK THAT DOES NOT RUN (arch-review 124) ──────────────────
//
// `unwired-capabilities` asks whether an optional PORT has an implementation. This asks the other half:
// whether a pure GUARD — `assert*` / `refuse*` / `require*` / `reject*` — is consumed anywhere. The two fail
// the same way and neither sees the other's shape.
//
// It exists because the review that added it found three at once:
//
//   · `refuseUnsafeCallback` / `assertPublicTarget` — the outbound SSRF decision, exported from
//     @everdict/application-control's index and imported by nobody, while three other lanes dialled a
//     caller-named URL with no check at all. Exporting it was the intent; nothing carried it.
//   · `assertRoleProfile` — the ownership protocol's O2 invariant, cited by `assertIndependentVerification`
//     as the "necessary" half of the separation it enforces, and called by nothing.
//   · `requireOwed` — a third spelling of an invariant already decided at boot and by a throw.
//
// The three repairs are the three legal answers, and the check asks for one of them: WIRE it (the guard gets
// a caller), DELETE it (the rule is enforced elsewhere — say where), or DECLARE it (the door it guards does
// not exist yet, and here is what will open it).
//
// ⚠️ ITS FIRST DRAFT MISSED ITS OWN TARGETS. The sweep that found these ran `git ls-files 'apps/*/src/**/*.ts'`,
// which does not match a file directly under `src/` — so `main.ts`, `server.ts` and `mcp.ts`, the composition
// roots where wiring LIVES, were invisible, and it reported a correctly-wired guard as unwired. Whole-tree
// pathspecs and a `.tsx` sweep are not tidiness here; they are the difference between this check and a
// generator of false findings.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const GUARD = /^export (?:async )?function ((?:assert|refuse|require|reject|forbid|deny)[A-Z]\w*)/gm;

// A guard whose door is not open yet. Each entry states what would open it, so the entry expires by being
// read rather than by being remembered.
const DECLARED_UNWIRED = new Map([
  // (empty — every guard in the tree is consumed)
]);

const files = execFileSync("git", ["ls-files", "packages", "apps"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("/dist/") && !f.endsWith(".d.ts"));

const source = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const production = files.filter((f) => !f.includes(".test."));

const unwired = [];
let scanned = 0;
for (const file of production) {
  for (const match of (source.get(file) ?? "").matchAll(GUARD)) {
    const name = match[1];
    scanned += 1;
    // A caller is any OTHER file that invokes it. Its own file counts as wiring — a guard used by the module
    // that owns it is consumed, whatever its export says.
    const called = [...source].some(
      ([other, text]) => other !== file && !other.includes(".test.") && new RegExp(`\\b${name}\\s*\\(`).test(text),
    );
    const selfCalled = new RegExp(`\\b${name}\\s*\\(`).test((source.get(file) ?? "").replace(match[0], ""));
    if (called || selfCalled) continue;
    if (DECLARED_UNWIRED.has(name)) continue;
    unwired.push({ name, file });
  }
}

if (unwired.length > 0) {
  console.error("\n✖ unwired guards — exported, and nothing calls them:\n");
  for (const { name, file } of unwired) console.error(`  ${name}  (${file})`);
  console.error(
    "\nA guard nobody calls is a check that does not run, and its export reads to a reviewer as enforcement.\n" +
      "Pick one: WIRE it (give it the caller it was written for), DELETE it (the rule is enforced elsewhere —\n" +
      "say where, in a comment that survives the deletion), or DECLARE it in DECLARED_UNWIRED with the door\n" +
      "that will open it.\n",
  );
  process.exit(1);
}

console.log(
  `PASS unwired guards: ${scanned} exported guard(s) across ${production.length} production files — every one is called ` +
    `(${DECLARED_UNWIRED.size} declared unwired, each naming the door it waits for).`,
);
