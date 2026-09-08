# Plan: bind evolution decisions to measured attempts and constrained evidence

From: intent.md @ d3e8a51b
## Files that change

- contracts records/execution: family attempts, campaign adoption criteria, structured measurements, evidence grants.
- domain evolution/scorecard/auth: non-inferiority, measurement matching and references, constrained principals.
- application-control evolution/scorecard: request reservations, sealed submission bindings, attempt-backed rounds and target-only evidence.
- application-execution/graders: producer-authored structured measurement coordinates.
- db evolution and migrations: atomic durable family consumption and idempotent attempts.
- auth/API composition and campaign/scorecard routes/MCP: enforce grants and expose request/evidence paths.
- SDK/client surfaces and skills: document and transport the new contracts.

## Order of work

1. Add a versioned non-inferiority policy and pure evaluation with explicit insufficient-evidence status, consumed by the gate.
2. Add structured measurement identities and stable references through production, normalization, deduplication and policy interpretation; keep legacy policy behavior fixed.
3. Add a durable experiment-family attempt ledger; reserve and bind scorecards before dispatch, retain spent attempts after every ending, refuse unbound round evidence.
4. Expose narrowly authorized target evidence and credential isolation, with HTTP and MCP denial across sibling read and mutation paths.
5. Exercise real PostgreSQL concurrency, malformed provenance and replay, historical interpretation, and end-to-end request/adoption paths. Run repository checks, self-review all authority boundaries, and commit the completed implementation.

## Risks

Historical policy identity must not change through normalization defaults. Attempt retries must not dispatch twice or release spent capacity. Grant-scoped credentials must never gain authority through workspace switching, MCP sessions or indirect reads. A new policy declaration must be enforced at adoption, not merely stored.

## Proof

Counterexamples at each boundary, including positive controls. Real PostgreSQL for reservation races and atomicity. HTTP/MCP tests for evidence grants and scorecard binding. Full format, lint, typecheck, test and build; targeted mutation checks and recorded self-review.
