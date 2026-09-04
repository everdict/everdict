# Plan: every scanner states its vocabulary

From: intent.md @ f1d4a56f68610eefe86423353052e3c0459f9062

## Files that change

- `scripts/check-scanner-watches.mjs` (new) — the check.
- `scripts/check-authz-optional.mjs` — drop the two dead names, declare `WATCHES`, rewrite the header.
- `scripts/check-untrusted-ingress.mjs` — declare `WATCHES` (all six names verified live).
- the other twenty `scripts/check-*.mjs` — one `// watches:` line each.
- `package.json`, `.github/workflows/ci.yml`, `scripts/ci-local.mjs`, `.claude/rules/ci.md`.

## Order of work

1. The check, written to PARSE the scanner files as text. It reads `export const WATCHES = [...]` or the
   marker comment, refuses a scanner carrying neither, and for every watched name requires at least one
   occurrence outside comments in non-test `packages/*/src` + `apps/*/src`.
2. Drive it against the tree BEFORE any annotation exists — it must fail, listing all twenty-two, or it is not
   measuring what it claims.
3. `authz-optional`: `WATCHES = ["gate", "authorize"]`, the header rewritten so the law is stated in live
   vocabulary and the deleted axis appears as history with its migration named.
4. `untrusted-ingress`: `WATCHES` with the six schema names.
5. The twenty markers.
6. Wire, and prove the removal drill: put a dead name back into a `WATCHES` list and the check goes red.

## Risks

- **A marker that is easy to write is easy to write untruthfully.** A scanner that does watch vocabulary but
  declares `nothing — structural` passes and is exactly as dead as before. The check cannot tell; what it
  buys is that the claim is now WRITTEN somewhere a reader can contradict, which is the same trade every
  allowlist in this tree already makes.
- **Occurrence is not a call site.** A name that survives only in a comment would pass if the comment were in
  live source. Comments are stripped before matching for that reason; a name surviving only in a string is
  accepted, and named as the known approximation.
- **Importing a scanner runs it.** The check reads text. This is the trap rule `ci` already records.

## Proof

- The check fails over the unannotated tree, naming twenty-two scanners.
- It fails with `assertTeamVisible` put back into `authz-optional`'s `WATCHES`, and passes when removed.
- `pnpm authz-optional` still passes and still has live subjects.
- `pnpm lint`, `pnpm docs-check`, `pnpm intent-chain` green.
