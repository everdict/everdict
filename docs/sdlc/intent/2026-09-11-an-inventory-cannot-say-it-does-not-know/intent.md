# Intent: an inventory that cannot reach its source says "unavailable", which is a revocation it did not observe

Author: Claude (from `pnpm scan --next` over `application`, 2026-09-11). Status: draft

Design: none — one named display state with a known blast radius. The question is what the third state is CALLED
to a user, which is a product decision and not a design pass.

## Problem

`EnvironmentAdoptionService.resolve` now answers three ways — `resolved`, `absent`, `unknown` — because a
capability-store outage used to be indistinguishable from a deleted capability and `adopt()` returned 404
about an environment that exists. That half is repaired: `adopt` refuses an unreadable store as retryable
upstream, and a genuinely absent capability still gets its 404.

The other half is not. `AdoptedEnvironmentView.available` is a BOOLEAN whose declared meaning is "the source
capability still resolves + is consumable for this workspace", and `unknown` is rendered as `false`. So during
a store outage a workspace's environment inventory labels every entry unavailable, and the web draws
`envUnavailable` on each one — which reads exactly like a revocation nobody performed.

Nothing is lost and nothing is written: the view is computed live and `reverify` skips its persist on a
non-`resolved` answer. What is wrong is what a person is told, at the moment they are deciding whether their
environments still work.

## Proposed outcome

The inventory can say "I could not find out" and a user can tell that from "this was revoked". Whatever the
third state is called, `available: false` stops being the answer to two different questions.

## Affected users and systems

Small and fully enumerated: `AdoptedEnvironmentView` (the service's own type),
`apps/web/src/entities/environment-adoption/model/schema.ts` (the Zod mirror), one render site in
`apps/web/src/features/publish-capability/ui/environment-workbench.tsx`, and a message-catalog entry in both
locales (`ko`/`en`) — the web never hardcodes a string.

The view is computed per request, so there is no stored-record migration and no schema-split question.

## Constraints

- **The web has its own rules.** A UI string lives in the message catalogs, both locales, never in the
  component (rule `web`, `docs/web.md`).
- **`available: false` must keep meaning what it means.** A revoked capability and an unreachable store are
  two answers; replacing one boolean with another boolean somewhere else would move the collapse rather than
  close it.
- **This is a LABEL, not a decision.** No effect path changes; `adopt`'s refusal is already repaired. A
  design that starts gating behaviour on the third state has widened the change past what the scan found.

## Open questions

- **What is it called?** "Unknown", "cannot reach the store", "checking" — a product decision, and the wrong
  word here is worse than the current lie, because a user who reads "checking" on a genuinely revoked
  environment waits for something that will not happen.
- **Should the list say WHY?** The service knows the store threw; the view does not carry it. Passing the
  reason through is more useful and more surface.
- **Is there a sibling?** `resolve`'s shape is not unique — any inventory merging stored refs with a live
  lookup has the same question, and this intent looked only at environments.
