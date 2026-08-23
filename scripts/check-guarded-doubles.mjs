#!/usr/bin/env node
// Guarded-write double guard — a fake that cannot answer `false` (arch-review 64).
//
// Some store methods are CONDITIONAL WRITES: their whole purpose is to refuse. `transition` returns `false`
// when the row is already terminal or its parent no longer authorizes it; `update` returns `undefined` when
// the fence was lost. A hand-written double that answers the success value unconditionally cannot express the
// one outcome the caller was written to handle, so a guard that refuses EVERY real call reads as a green test.
//
// This guard exists because the prose version of it did not hold. arch-review 63 wrote the law into
// `.claude/rules/protocol.md` — "A DOUBLE THAT ALWAYS SUCCEEDS IS NOT A STORE" — and the same wave shipped:
//
//     attempts: { transition: async (id, to) => { moved.push([id, to]); return true; } }
//
// as the counterexample for a correction that, in production, could never run at all. Two independent reasons
// it could not: the composition root has no parameter to pass a ledger through, and the real store is
// first-terminal-wins, so the `committed → superseded` correction the test asserted is refused by every real
// implementation. The assertion recorded that we had ASKED. A rule the author broke the day they wrote it is
// a note; this is the version that binds.
//
// The remedy is almost always cheaper than the workaround: `InMemoryExecutionAttemptStore` exists, makes the
// same decision production makes, and lets the test read the ROW back instead of a call log.
//
// Scope is test sources only — production code does not write doubles. A double that answers `false` (or
// decides from its inputs) is fine and is what this guard is asking for.
//
// Reads SOURCE only (no build, no deps), prints every violation, exits 1.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The conditional writes in this repo: each returns a value that MEANS "refused", and each has a real
// in-memory implementation a test can use instead. Adding a conditional write to a port adds it here.
const GUARDED = [
  { name: "transition", refusal: "false", success: "true" },
  { name: "tryAdmit", refusal: "false", success: "true" },
  { name: "tryAdmitRuns", refusal: "false", success: "true" },
];

// A hard-coded success is fine when granting is the test's PREMISE rather than its subject — a permit that is
// always issued, in a test about what happens to the permit afterwards. It is not fine when an assertion
// reads back through it, which is the shape this guard was built for.
//
// So each entry says which of the two it is, and an `OPEN —` entry is a defect with a scheduled owner, not a
// judgement that the site is acceptable. Same discipline as `check-constructed-casts.mjs`: the entry's REASON
// is the thing to read, and a site leaves this list by changing, never by being explained better.
const ALLOWED = new Map([
  [
    "packages/backends/src/scheduling/admission-race.trust.test.ts",
    "PREMISE — the permit is granted so the test can hold it mid-claim; the subject is the aborted entry never dispatching and the late permit being returned",
  ],
  [
    "apps/api/src/composition/verifier-admission.counterexample.test.ts",
    "PREMISE — admission succeeds so the lane holds a permit; the subject is whether that permit is RENEWED while the verifier runs",
  ],
  [
    "apps/api/src/trust/contract-carry.trust.test.ts",
    "PREMISE — the envelope admits so a run exists; the subject is `releaseRuns` carrying the same requestId the admit used",
  ],
  [
    "packages/application-control/src/execution/agent-half.counterexample.test.ts",
    "OPEN (arch-review 64) — this IS the defect: the double asserts we ASKED, while production has no parameter to pass a ledger through and the real store refuses `committed → superseded` outright. Removed when `verdict_produced` replaces the correction",
  ],
  [
    "apps/api/src/composition/verifier-is-not-the-run-result.counterexample.test.ts",
    "OPEN (arch-review 64) — the assertion reads a call log (`closed`) rather than the row; removed when the recovery settles its adopted attempt through the real ledger",
  ],
]);

// `name: async (…) => { … }` or `name: async (…) => expr` or `async name(…) { … }`, capturing the body so the
// next step can ask whether any refusal is reachable in it.
function doublesIn(text, method) {
  const out = [];
  const arrow = new RegExp(`(^|[\\s{,(])${method}\\s*:\\s*(async\\s*)?\\(?[^)\\n]*\\)?\\s*=>`, "g");
  const shorthand = new RegExp(`(^|[\\s{,])(async\\s+)?${method}\\s*\\([^)\\n]*\\)\\s*\\{`, "g");
  for (const re of [arrow, shorthand]) {
    let m = re.exec(text);
    while (m !== null) {
      out.push(m.index + m[0].length - (m[0].endsWith("{") ? 1 : 0));
      m = re.exec(text);
    }
  }
  return out;
}

// The body that follows a match: to the closing brace for a block, to the end of the expression otherwise.
// Deliberately crude — this guard asks one question ("can `false` come out of here?") and a crude window
// answers it, while a parser would be a second thing to keep correct.
function bodyAt(text, from) {
  const rest = text.slice(from);
  if (!rest.trimStart().startsWith("{")) {
    const stop = rest.search(/,\s*\n|\n\s*\}/);
    return stop === -1 ? rest.slice(0, 400) : rest.slice(0, stop);
  }
  let depth = 0;
  for (let i = rest.indexOf("{"); i < rest.length; i += 1) {
    if (rest[i] === "{") depth += 1;
    else if (rest[i] === "}") {
      depth -= 1;
      if (depth === 0) return rest.slice(0, i + 1);
    }
  }
  return rest.slice(0, 2000);
}

// Is this body a HARD-CODED SUCCESS — the success value and nothing else, whatever the arguments or the state?
// Asked in the positive because the negative over-fires: a `tryAdmit` that always grants is often the PREMISE
// of a test about what happens afterwards, and only a body whose sole outcome is the success value can never
// express the refusal its caller was written to handle.
//
// So: any branch, any throw or rejection, any refusal literal, any delegation whose answer comes from
// somewhere else — all of those make the answer depend on something, and none of them is this shape.
function isHardcodedSuccess(body, success) {
  const code = body
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  if (/\bthrow\b|Promise\.reject|\breject\(/.test(code)) return false;
  if (/\bif\s*\(|\belse\b|\?\s*[^:]*:|&&|\|\|/.test(code)) return false;
  if (/\b(false|undefined|null)\b/.test(code) && !/=>\s*undefined\s*[,;)\n]/.test(code)) return false;
  // A concise arrow: `async () => true`.
  if (new RegExp(`^\\s*${success}\\s*[,;)\\n]?\\s*$`).test(code)) return true;
  // A block whose only return is the success literal. Anything else it does (pushing to a call log) does not
  // change the answer it gives, which is the whole point.
  const returns = [...code.matchAll(/\breturn\s+([^;\n]+)/g)].map((m) => m[1].trim());
  if (returns.length === 0) return false;
  return returns.every((r) => r === success);
}

const files = execSync('git ls-files -- packages apps ":(exclude)*/dist/*"', {
  cwd: root,
  maxBuffer: 64 * 1024 * 1024,
})
  .toString()
  .split("\n")
  .filter((f) => /\.test\.tsx?$/.test(f));

const violations = [];
let checked = 0;
let allowed = 0;

for (const file of files) {
  const text = readFileSync(path.join(root, file), "utf8");
  for (const { name, refusal, success } of GUARDED) {
    if (!text.includes(name)) continue;
    for (const at of doublesIn(text, name)) {
      checked += 1;
      const body = bodyAt(text, at);
      if (!isHardcodedSuccess(body, success)) continue;
      if (ALLOWED.has(file)) {
        allowed += 1;
        continue;
      }
      const line = text.slice(0, at).split("\n").length;
      const why = "It is a conditional write: a guard that refuses every real call would read as a green test here.";
      violations.push(`${file}:${line} — a \`${name}\` double that can never answer ${refusal}. ${why}`);
    }
  }
}

// A reason that outlived its subject reads as permission for a shape nobody wrote — and an `OPEN` entry that
// nobody removed reads as a defect still open when it was fixed. Both are worse than no entry.
for (const [file, why] of ALLOWED) {
  if (!files.includes(file)) {
    violations.push(`allowlist names ${file}, which is not a test file — remove the entry (${why})`);
    continue;
  }
  const text = readFileSync(path.join(root, file), "utf8");
  const live = GUARDED.some(({ name, success }) =>
    doublesIn(text, name).some((at) => isHardcodedSuccess(bodyAt(text, at), success)),
  );
  if (!live)
    violations.push(`allowlist names ${file}, which no longer hard-codes a success — remove the entry (${why})`);
}

if (violations.length > 0) {
  console.error(`guarded-double check FAILED — ${violations.length} problem(s):\n`);
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error(
    "\nA double for a guarded write answers the way the real one would. Use the `InMemory*` implementation —\n" +
      "it makes the same decision production makes — and assert the ROW's state rather than that the call\n" +
      "happened. See rule `protocol`, the always-succeeds-double law.",
  );
  process.exit(1);
}

console.log(
  `PASS guarded doubles: ${checked} hand-written double(s) across ${files.length} test files — ` +
    `each can answer a refusal (${allowed} allowlisted, every entry naming premise or an open defect).`,
);
