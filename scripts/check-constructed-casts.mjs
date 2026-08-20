#!/usr/bin/env node
// Constructed-cast guard — a value BUILT here and then cast past the checker (arch-review 57).
//
// `f({ ...fields } as never)` compiles whatever `fields` are. The object is constructed at this call site, so
// the parameter type is the only thing that could have said the fields are wrong — and the cast is the caller
// telling the compiler not to look. Nothing else catches it: the callee's own tests pass their own fixtures,
// and the fixture at THIS site never runs through the callee's contract.
//
// This is not a style rule. arch-review 57 found the verifier lane unable to produce a verdict in production,
// through three independent breakages, and the first one is this exact shape:
//
//   driver.provision({ ...(job.image !== undefined ? { image: job.image } : {}) } as never)
//
// `ComputeSpec` requires `os`. `LocalDriver.provision()` refuses anything but `os === "linux"` on its first
// line, so every verifier job that reached a real driver was rejected before it did anything. The cast is why
// the build was green over a call that could never succeed. The same shape appears twice more in the same
// review's findings — the synthetic `CaseJob` that K8s and Nomad build for a verifier submit, which is how
// that submit skips `resolve(job)` and with it the tenant's trust zone.
//
// So the shape marks the defect class, and an entry here is a DESIGN ADMISSION: the type could not say what
// this call site means. Each one states why, and leaves when the reason expires.
//
// ⚠️ AND THE REASON IS THE THING TO READ. This list carried
//
//     "the shape is a wire artifact, not a CaseResult"
//
// for the verifier entrypoint — a sentence that STATES the defect and files it as the exemption. The value
// really was not a CaseResult, and it was being printed down a pipe whose reader runs
// `CaseResultSchema.parse()`, so every verifier verdict died at that parse (arch-review 58). An entry that
// explains why a value is the WRONG SHAPE has recorded a bug, not an admission; the admission form is "the
// type cannot express this", and those two read almost alike at 2am. When adding one, ask which it is.
//
// Scope is production source only. Tests construct partial fixtures on purpose — that is what a fake is —
// and rule `testing` owns whether a fixture is honest (it must come from the production builder and reach the
// predicate). This guard is about code that ships.
//
// Reads SOURCE only (no build, no deps), prints every violation, exits 1.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A constructed object (or array) handed past the checker: `} as never`, `} as unknown as T`, and the
// bracketed forms. Not `x as never` on an existing binding — `.includes(x as never)` is a known TS limitation
// with readonly tuples and says nothing about a value's shape.
const CONSTRUCTED_CAST = /[}\]]\s*as\s+(never|unknown\s+as\s+[A-Za-z_$][\w$]*)/;

// Every allowlisted site names why the type could not say it. A site leaves this list by being typed, not by
// being explained better.
const ALLOWED = new Map([
  [
    "packages/topology/src/deploy/nomad-topology.ts",
    "OPEN — a ServiceHarnessSpec assembled for a deploy preview; the builder wants the whole registered spec and this path holds only the deployable half",
  ],
  [
    "apps/agent/src/server.ts",
    "OPEN — a verification-turn dep bag widened with a flag the turn's own type does not declare; the flag belongs on that type",
  ],
]);

// Directory pathspecs, not `packages/*/src/**/*.ts`: git matches a pathspec against the whole path, so the
// starred form silently misses every file sitting directly in `src/` — which is where the call this guard
// exists for lives. A scanner that cannot see its own subject is the failure mode rule `testing` names.
const files = execSync('git ls-files -- packages apps ":(exclude)*.test.ts" ":(exclude)*.test.tsx"', {
  cwd: root,
  maxBuffer: 64 * 1024 * 1024,
})
  .toString()
  .split("\n")
  .filter((f) => /\/src\/.*\.tsx?$/.test(f));

const violations = [];
let allowed = 0;

for (const file of files) {
  const text = readFileSync(path.join(root, file), "utf8");
  if (!CONSTRUCTED_CAST.test(text)) continue;
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    // A cast inside a comment is prose about this rule, not an instance of it.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    if (!CONSTRUCTED_CAST.test(line)) continue;
    if (ALLOWED.has(file)) {
      allowed += 1;
      continue;
    }
    violations.push(`${file}:${i + 1} constructs a value and casts it past the checker — ${line.trim()}`);
  }
}

// An allowlist entry whose site is gone is a reason that outlived its subject: the next reader takes it as
// permission for a call that no longer exists.
for (const [file, why] of ALLOWED) {
  if (!files.includes(file)) {
    violations.push(`allowlist names ${file}, which is not a production source file — remove the entry (${why})`);
    continue;
  }
  const text = readFileSync(path.join(root, file), "utf8");
  const live = text.split("\n").some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && CONSTRUCTED_CAST.test(line));
  if (!live) violations.push(`allowlist names ${file}, which no longer casts anything — remove the entry (${why})`);
}

if (violations.length > 0) {
  console.error(`constructed-cast check FAILED — ${violations.length} problem(s):\n`);
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error(
    "\nA value built at the call site is checked by the parameter type or by nothing. Type the call, or add an\n" +
      "entry to ALLOWED in scripts/check-constructed-casts.mjs stating why the type cannot say it.",
  );
  process.exit(1);
}

console.log(
  `PASS constructed casts: ${files.length} production files carry no untyped constructed argument ` +
    `(${allowed} allowlisted, each with its reason).`,
);
