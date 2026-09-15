# Intent: four doors register a dataset, and only one writes the receipt that says an admin approved it

Author: Claude (from `pnpm scan --next` over `api`, 2026-09-11). Status: draft

Design: owed — the repair is a SEAM (where the constitutional publish happens), and arch-review 119 already
settled the shape of that argument once for ownership: *close it at the store, not at every door.* Whether that
applies here, and what carries the principal to it, is the design pass.

## Problem

A dataset whose graders declare `ground_truth` for a metric "defines what passing means for every evaluation
that ever runs this dataset" — the code's own words. The protocol has TWO halves:

- `assertDatasetConstitution` — the declaration requires the admin role;
- `publishDataset` — it writes an approval RECEIPT atomically, and refuses with `UpstreamError` on a
  deployment with no `constitutionalPublisher` configured. Its own comment records why (arch-review 23 P1):
  *"Authorizing at the door leaves no trace, so an artifact already in the database cannot say whether an
  admin approved it, a member registered it before the gate existed, or it arrived some other way."*

Four surfaces register a dataset. One honours both halves.

| door | admin check | receipt |
|---|---|---|
| `POST /datasets` (+ import) | ✅ | ✅ |
| `save_dataset` (MCP) | ✅ | ✅ |
| `POST /bundles/apply` | ✅ | ❌ |
| `apply_bundle` (MCP) | ❌ → **repaired 2026-09-11** | ❌ |
| benchmark catalog import | ⚠️ re-implemented INLINE | ❌ |

The escalation — a plain member granting ground_truth through the one door that asked nothing — is closed,
with a counterexample and a mutation rung. Everything in the `receipt` column is not.

So today: an admin applies a bundle declaring ground_truth, the declaration is authorized and the dataset is
registered, and **nothing anywhere records that it was approved.** On a deployment with no
`constitutionalPublisher`, the identical dataset is REFUSED through `POST /datasets` and succeeds silently
through `/bundles/apply` — the capability refusal is a property of the door rather than of the deployment.

`BenchmarkService` additionally re-implements the admin check inline instead of calling
`assertDatasetConstitution`, which is a predicate written twice (rule `protocol` L3) and has already drifted
once by construction: it never gained the receipt half.

## Proposed outcome

A dataset carrying a constitutional declaration cannot become registered without its approval receipt, by any
route. The deployment-capability refusal is a property of the DEPLOYMENT, not of which door was used.

## Affected users and systems

`apps/api/src/api/route-context.ts` (`assertDatasetConstitution` / `publishDataset` — the two halves),
`apps/api/src/core/bundle/bundle-service.ts` (`apply` builds its register callbacks from `this.deps`, so a
route cannot inject one today), `apps/api/src/api/bundle/{routes,mcp}.ts`,
`apps/api/src/core/benchmark/benchmark-service.ts` (the inline copy), and whatever composition root wires the
publisher.

## Constraints

- **The inline copy goes away rather than gaining a receipt.** Two spellings of one predicate is what produced
  this; a third would be worse than the gap.
- **A registry cannot answer the constitutional question.** It has no principal. Whatever seam is chosen has
  to carry one, which is why "close it at the store" is an argument here and not an obvious answer.
- **Partial success must stay partial.** `apply` reports per-item status and a bundle's other sections land
  even when one fails; a refusal added here may not turn a partial apply into an all-or-nothing one without
  saying so.
- **No new door.** The repair is fewer paths to the registry, not another wrapper beside them.

## Open questions

- **Where does the seam go?** `apply` taking an optional publish callback is the smallest change and leaves
  four callers to remember it — the exact shape that produced this finding. Making the service's `datasets`
  dep a publisher rather than a registry moves it to the composition root and is harder to bypass.
- **What does a bundle apply do when the publisher is unconfigured?** `POST /datasets` refuses the whole
  request. A bundle has other sections that would otherwise land, and refusing them for a dataset's sake may
  be the wrong trade — or exactly the right one.
- **Are there other registry doors?** This looked at datasets because that is where the scan looked. Judges,
  rubrics and models are registered from the same bundle path, and nobody asked whether any of them carries
  a comparable protocol.
