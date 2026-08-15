import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ── THE STRUCTURAL HALF OF "NOTHING DELETES A RECEIPT" (review 40 / 46) ──────────────────────────────
//
// The case-commit receipt is the decision: one row per `(scorecard, case, trial)`, claimed by an `INSERT …
// ON CONFLICT DO NOTHING`, and the row that wins IS the answer for that case forever. Everything downstream
// reads it as settled fact — the parent's frozen read-set (mig 0179), the trajectory's attempt join, the
// re-drive's "this case is already decided".
//
// THE STORE'S OWN ERROR HANDLING IS BUILT ON THIS, in a way that is easy to miss and impossible to repair
// locally. `commitOn` claims, and when the insert is refused it reads the winner back in a SECOND statement
// (the first statement's CTE shares one snapshot with the query around it, so the loser cannot see the row it
// lost to — TRUST-169). If that read finds nothing, the store throws `UPSTREAM_ERROR` rather than reporting
// "somebody else committed", and its comment says exactly why: *"nothing deletes a receipt — so this is a
// store fault, not an outcome to interpret. Reporting it as 'somebody else committed' would invent a winner
// nobody can name."*
//
// So a `DELETE` added anywhere — a cleanup job, a test-fixture reset promoted to production, a cascade on a
// contraction migration — does not merely lose a row. It turns a correct fail-closed branch into a false
// alarm, and it does so in the exact window a race is happening. The claim is APPEND-ONLY, and an `UPDATE`
// is the same violation wearing better clothes: a receipt whose digest is revised after the fact is a
// decision that changed its mind, which is precisely what the read-set was frozen to prevent.
//
// There is no allowlist. A statement that has to modify this table is a schema decision, and it should be
// argued for here, in review, rather than discovered by a reader holding a receipt that no longer matches
// the evidence it names.
const MUTATION =
  /\b(?:UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+(?:ONLY\s+)?everdict_case_commit_receipts\b/i;
// The table's own name, so a RENAME cannot make this scan pass by making it match nothing.
const TABLE = /everdict_case_commit_receipts/;
// The claim itself — the one statement that is allowed to write this table, and the anti-vacuity anchor: if
// the scan can no longer find it, the scan is pointed at the wrong tree and every green below is empty.
const CLAIM = /INSERT INTO everdict_case_commit_receipts/;

// Comment text is not SQL and is not code. Both languages are stripped: this table is discussed constantly in
// the prose above and below every statement that touches it (including the prose you are reading), and a scan
// that reads a comment as a statement teaches people to stop writing the comments.
function statementsOf(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/--.*$/, "").replace(/\/\/.*$/, ""))
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

function filesUnder(dir: string, prefix: string, ext: string): string[] {
  if (prefix.endsWith("/dist") || prefix.endsWith("/node_modules")) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = `${prefix}/${name}`;
    if (statSync(full).isDirectory()) return filesUnder(full, rel, ext);
    return name.endsWith(ext) ? [rel] : [];
  });
}

describe("receipt append-only guard — a case commit receipt is claimed once and never rewritten", () => {
  const root = join(__dirname, "../../../..");
  // BOTH HALVES, because the violation can be written in either language: a migration that alters the table's
  // contents, or a store method that issues the statement at runtime. Tests are deliberately IN scope — a
  // fixture that resets by deleting receipts is a `DELETE` somebody will lift into production the week the
  // cleanup job is asked for, and the in-memory fake is where the append-only rule is easiest to forget.
  const scanned = [
    ...filesUnder(join(root, "packages/db/migrations"), "packages/db/migrations", ".sql"),
    ...filesUnder(join(root, "packages/db/src"), "packages/db/src", ".ts"),
  ];
  const files = scanned.map((rel) => ({ rel, text: statementsOf(readFileSync(join(root, rel), "utf8")) }));

  it("no migration and no store statement rewrites or removes a committed receipt", () => {
    const offenders = files
      .filter(({ text }) => MUTATION.test(text))
      .map(
        ({ rel, text }) =>
          `${rel}: ${text
            .split("\n")
            .find((l) => MUTATION.test(l))
            ?.trim()}`,
      );
    expect(offenders).toEqual([]);
  });

  it("the rule fires on the statements it exists to refuse", () => {
    // Written out because there is no defect to revert here: this invariant has held since the table was
    // created, which is the one situation where a scanner can be born broken and nobody would ever find out.
    expect(MUTATION.test("DELETE FROM everdict_case_commit_receipts WHERE scorecard_id = $1")).toBe(true);
    expect(MUTATION.test("UPDATE everdict_case_commit_receipts SET result_digest = $1 WHERE id = $2")).toBe(true);
    expect(MUTATION.test("delete from only everdict_case_commit_receipts where committed_at < now()")).toBe(true);
    expect(MUTATION.test("TRUNCATE TABLE everdict_case_commit_receipts")).toBe(true);
    expect(MUTATION.test("DROP TABLE IF EXISTS everdict_case_commit_receipts")).toBe(true);
    // …and stays off the statements that are the point of the table.
    expect(MUTATION.test("INSERT INTO everdict_case_commit_receipts (scorecard_id, case_id) VALUES ($1, $2)")).toBe(
      false,
    );
    expect(MUTATION.test("SELECT * FROM everdict_case_commit_receipts WHERE scorecard_id = $1")).toBe(false);
    expect(MUTATION.test("ALTER TABLE everdict_case_commit_receipts ADD COLUMN IF NOT EXISTS attempt_id text")).toBe(
      false,
    );
    // A neighbouring table's cleanup is not this one's business — the name must match, not merely be nearby.
    expect(MUTATION.test("DELETE FROM everdict_case_commit_receipt_locks WHERE id = $1")).toBe(false);
    // …and PROSE about deleting a receipt is what the file above is made of.
    expect(
      statementsOf("-- nothing DELETE FROM everdict_case_commit_receipts, which is why the read can throw"),
    ).not.toMatch(MUTATION);
    expect(
      statementsOf("// nothing deletes a receipt: DELETE FROM everdict_case_commit_receipts never appears"),
    ).not.toMatch(MUTATION);
  });

  it("the scanner is still looking at the table it names", () => {
    // The claim is the anchor. A rename, a move out of `packages/db`, or a glob that stops reaching the
    // migrations all end with this scan green over nothing, and this is the assertion that refuses that.
    const claimSites = files.filter(({ text }) => CLAIM.test(text)).map(({ rel }) => rel);
    expect(claimSites).toContain("packages/db/src/results/pg-case-receipt-store.ts");
    // …and the store's fail-closed branch is still the one this invariant holds up. If that error stops being
    // thrown, the rule below is no longer load-bearing and this guard's header needs rewriting, not deleting.
    const store = readFileSync(join(root, "packages/db/src/results/pg-case-receipt-store.ts"), "utf8");
    expect(store).toMatch(/case receipt claim returned no row/);
    // Both halves of the walk found their subject: the schema that creates the table, and the code that reads
    // it. Either going quiet hides a different language the violation could be written in.
    expect(scanned.some((rel) => rel.endsWith(".sql") && TABLE.test(readFileSync(join(root, rel), "utf8")))).toBe(true);
    expect(files.filter(({ text }) => TABLE.test(text)).length).toBeGreaterThan(3);
  });
});
