// ── A PRODUCER DOCUMENT IS PARSED WITH THE UNTRUSTED SCHEMA, OR NOT AT ALL ──────────────────────────
//
// Three P0s in three reviews, all the same shape: a field the PLATFORM authors — an `artifact://` coordinate,
// a billing provenance, a verifier receipt, a judgment seal — arrived on a document a PRODUCER submits, and
// the platform then acted on it. Read them in order and the pattern is not forgetfulness:
//
//   arch-review 66   the GC coordinate on `CaseResult`; a runner could name objects a settlement would delete
//   arch-review 121  `outputRef`/`screenshotRef`; a producer could read and delete objects it does not own
//   arch-review 122  `provenance`; a producer could decide WHO PAYS, and bill a workspace that never ran it
//
// Each was closed by splitting the schema — `TraceEventSchema` for what WE stored, `UntrustedTraceEventSchema`
// for what a producer sends — and each time the closing change had to hunt the doors by hand. The door written
// AFTER the lesson is the one that never learns it, which is why rule `protocol` says a prose law that fails
// once becomes a machine check. This one has failed three times.
//
// So: a raw producer-document schema may not be referenced outside its own declaration and the allowlist
// below. Every entry states WHY that site is not an ingress — the honest reasons are "it decodes bytes WE
// wrote" and "it is the declaration itself"; anything else is a door.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

// raw schema → the untrusted variant a door must use instead.
const GUARDED = {
  TraceEventSchema: "UntrustedTraceEventSchema",
  TraceSpanSchema: "UntrustedTraceSpanSchema",
  CaseResultSchema: "UntrustedCaseResultSchema",
};

// Every site allowed to name a raw schema, with the reason it is not a door. A reason that is not "this
// decodes what WE wrote" or "this is the declaration" is a defect wearing an exemption (rule `typescript`
// makes the same point about `constructed-casts`).
const ALLOWED = {
  "packages/contracts/src/execution/eval-case.ts": "declares CaseResultSchema and its untrusted variant",
  "packages/contracts/src/execution/trace.ts": "declares TraceEventSchema and its untrusted variant",
  "packages/contracts/src/execution/span.ts": "declares TraceSpanSchema and its untrusted variant",
  "packages/contracts/src/execution/grader.ts": "type-level composition of the stored shape",
  "packages/contracts/src/execution/trace-source.ts": "the pulled-trace record WE assemble from a platform",
  "packages/contracts/src/execution/verifier-result-wire.ts": "the verifier's own sentinel, a separate wire",
  "packages/contracts/src/job-result-wire.ts": "declares the sentinel decoder; it parses with the UNTRUSTED variant",
  "packages/contracts/src/records/run.ts": "the stored run record",
  "packages/contracts/src/records/scorecard.ts":
    "the stored scorecard record — CaseAttempt holds a result WE moved off the current plane",
  "packages/contracts/src/wire/run/run-live-trace.ts": "a response shape WE serialize",
  "packages/contracts/src/wire/scorecard/scorecard.ts": "a response shape WE serialize",
  "packages/db/src/results/trajectory-body.ts": "decodes trajectory bytes WE sealed",
  "packages/db/src/activity/runner-job-store.ts": "decodes a result row WE persisted",
  "packages/domain/src/scorecard/case-result-digest.ts": "digests the canonical stored document",
  "packages/application-control/src/execution/agent-half.ts": "reads back the staged half WE wrote",
  "packages/job-runner/src/main.ts": "our own code building its result before printing it — not an ingress",
};

const files = execFileSync(
  "git",
  ["grep", "-l", "-E", `\\b(${Object.keys(GUARDED).join("|")})\\b`, "--", "packages", "apps", ":(exclude)*.test.ts"],
  { cwd: ROOT, encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);

const problems = [];
for (const file of files) {
  if (ALLOWED[file] !== undefined) continue;
  const text = readFileSync(path.join(ROOT, file), "utf8");
  for (const [raw, untrusted] of Object.entries(GUARDED)) {
    // `UntrustedTraceEventSchema` contains `TraceEventSchema`; only a BARE mention counts.
    const bare = new RegExp(`(?<![A-Za-z])${raw}\\b`, "g");
    const hits = [...text.matchAll(bare)].filter(
      (m) => !text.slice(Math.max(0, m.index - 9), m.index).endsWith("Untrusted"),
    );
    if (hits.length > 0)
      problems.push(
        `${file} names ${raw} — a producer document is parsed with ${untrusted}, or the file states why it is not a door in ALLOWED`,
      );
  }
}

// An allowlist entry whose site stopped naming the schema reads as permission for a door nobody opened, and
// the next reader inherits it as precedent (same discipline as `guarded-doubles`).
for (const file of Object.keys(ALLOWED))
  if (!files.includes(file))
    problems.push(`${file} is allowlisted but no longer names a guarded schema — drop the entry`);

if (problems.length > 0) {
  console.error(`untrusted ingress check FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(
  `PASS untrusted ingress: ${files.length} file(s) name a producer-document schema — every one is a declaration, a decode of what we wrote, or parses with the untrusted variant (${Object.keys(ALLOWED).length} allowlisted, each with its reason).`,
);
