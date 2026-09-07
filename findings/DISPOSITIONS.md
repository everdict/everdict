# Finding dispositions

What happened to what the reviewer and the scanner reported. Written by
`pnpm findings --record`, and COMMITTED: a judgement nobody else can read is one the next person makes again.

A finding is `real` (it named a defect), `false-positive` (it did not), or `carried` (real, and deliberately
not fixed here — an intent holds it). Precision counts real and carried against the total; carrying a finding
is not the same as disagreeing with it.

<!-- entries below, newest last -->
- 2026-09-07 · review@2ebc79ca11ef · `evals/run.mjs` · **real** — the stamp condition read failed===0 and ignored inconclusive, so an unanswered run could certify; fixed in d4aa2e3c
- 2026-09-07 · review@2ebc79ca11ef · `scripts/bands/watch.mjs` · **carried** — the YAML reader mis-types a threshold into a string instead of refusing it; the honest repair is a parse that refuses, filed as intent 2026-09-06-three-findings-the-review-left
- 2026-09-07 · review@2ebc79ca11ef · `scripts/check-swallowed-reads.mjs` · **real** — the header claimed a baseline of 83 against a file summing to 105 across 61 files; corrected in d4aa2e3c
- 2026-09-07 · review@2ebc79ca11ef · `scripts/ci-commits.mjs` · **carried** — the history exclusion pathspec is duplicated instead of importing CONFIG_PATHSPEC; filed as intent 2026-09-06-three-findings-the-review-left
- 2026-09-07 · review@d4aa2e3c46df · `packages/application-control/src/evolution/campaign-service.ts` · **carried** — verifyExamControl reads card.manifest.verdictPolicy directly instead of through ExecutionPlan; pre-existing, filed for the same intent
- 2026-09-07 · review@d4aa2e3c46df · `scripts/check-swallowed-reads.mjs` · **carried** — the ratchet globs .ts and never .tsx, so 50 occurrences across 29 tsx files are invisible; widening moves the baseline so it needs its own change
- 2026-09-07 · scan@contracts · `packages/contracts/src/execution/git-auth.ts` · **carried** — unscoped http.extraheader leaks the installation token to any host a submodule or redirect names; verified by reading and filed as intent 2026-09-05-scan-contracts-outbound-credentials
- 2026-09-07 · scan@contracts · `packages/contracts/src/infra/outbound-target.ts` · **carried** — isPrivateAddress is blind to IPv4-mapped IPv6, so an SSRF guard admits ::ffff:169.254.169.254; verified and filed in the same intent
- 2026-09-07 · scan@api · `apps/api/src/api/harness/harness.routes.ts` · **false-positive** — the scanner claimed this door parses before authorizing unlike its siblings; the siblings at lines 39 and 104 do the same, so the claim was contradicted by the file it cited
