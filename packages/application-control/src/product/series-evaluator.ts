import { NotFoundError, type ProductRecord, type ProductSeries } from "@everdict/contracts";
import { type SeriesContractResolution, watchedSeries } from "@everdict/domain";
import type { ReleaseStore } from "../ports/product-store.js";

// Running a product's watch series — the ONE place a series turns into a scorecard
// (docs/architecture/product-timeline.md).
//
// It used to live inside the version sync as a private method, which made the sync the only thing that could
// ever produce evidence for a series: declaring one and pressing Sync fanned out nothing, because a sync that
// imports no new row has nothing to fan out from. So a series declared on a product whose history was already
// backfilled stayed empty until upstream happened to ship again — while the release gate read that same
// emptiness as `not_evaluated` and blocked the ship. The trigger was missing, not the plumbing.
//
// The plumbing is here now and has three callers, distinguished by their TRIGGER rather than by their code
// path: the import fan-out, the seed a declaration owes itself, and a member asking again.

// WHY a batch was submitted. Rides onto `ScorecardOrigin.seriesTrigger` verbatim.
export type SeriesRunTrigger = "version_import" | "series_declared" | "manual";

export interface SeriesRunOutcome {
  // The scorecards this fan-out created, one per series that submitted.
  triggered: string[];
  // Series whose submit failed. One broken series must never sink the others, and a silently missing batch
  // would read as "the product got worse" — so the failure is part of the outcome rather than a throw.
  failedSeries: Array<{ key: string; error: string }>;
}

// The submit seam — what the fan-out needs from the scorecard plane, as a function so this collaborator
// depends on behaviour (the composition root closes it over ScorecardService.submit). Versions are refs:
// absent = latest at run time, which is what a standing series means.
export type SeriesRunSubmitter = (input: {
  tenant: string;
  submittedBy: string;
  dataset: { id: string; version?: string };
  harness: { id: string; version?: string };
  judges: Array<{ id: string; version?: string }>;
  runtime?: string;
  // The contract digest this caller resolved — submit re-seals and REFUSES on a mismatch (arch-review 16
  // P0-3), so a `latest` moving between resolution and seal costs a retry rather than a record whose origin
  // and manifest name different questions.
  expectedContractDigest?: string;
  origin: {
    source: "product";
    productId: string;
    releaseId?: string;
    seriesKey: string;
    // The concrete evaluation contract this run answers under — see SeriesEvaluator.run.
    seriesContractDigest?: string;
    seriesTrigger?: SeriesRunTrigger;
    serviceVersion?: string;
  };
}) => Promise<{ id: string }>;

export interface SeriesEvaluatorDeps {
  releases: ReleaseStore;
  // Absent = a deployment without the eval plane: series never run, and every caller reports that honestly by
  // triggering nothing rather than by failing.
  submitSeriesRun?: SeriesRunSubmitter;
  // Resolve a series' CONCRETE contract at submit time (arch-review 13 P0) — the same seam ProductService
  // uses at readiness, so the stamp a batch carries and the contract a release compares it against are
  // produced by one function. Absent = batches ship unstamped, which readiness reads as evidence whose
  // question cannot be named.
  resolveSeriesContract?: (tenant: string, series: ProductSeries) => Promise<SeriesContractResolution>;
}

export interface SeriesRunInput {
  // Who the batch is filed as. The import fan-out submits as the product's CREATOR (the schedule precedent:
  // the standing declaration's author, not whoever pressed Sync); the declaration seed and the manual run
  // submit as the person who acted, because there a person IS the cause.
  submittedBy: string;
  trigger: SeriesRunTrigger;
  // Which series to run. Absent = what the product currently watches (the active planned release's selection
  // when it has one, else every series) — the import fan-out's rule. Named keys are run as named: declaring a
  // series owes THAT series a baseline whether or not a planned release happens to watch it.
  keys?: readonly string[];
  // The ledger row that caused this run. Only a version import has one (see ScorecardOrigin.serviceVersion).
  serviceVersion?: string;
}

export class SeriesEvaluator {
  constructor(private readonly deps: SeriesEvaluatorDeps) {}

  // Which of the product's series a set of keys names — refusing an unknown one rather than quietly running
  // the intersection, because "run the cost series" answered by running nothing is indistinguishable from a
  // series that submitted and produced no batch.
  static select(product: ProductRecord, keys: readonly string[]): ProductSeries[] {
    const declared = new Map(product.series.map((series) => [series.key, series] as const));
    const unknown = keys.filter((key) => !declared.has(key));
    if (unknown.length > 0)
      throw new NotFoundError(
        "NOT_FOUND",
        { product: product.id, series: unknown },
        `This product declares no series called ${unknown.map((key) => `'${key}'`).join(", ")}.`,
      );
    return keys.flatMap((key) => {
      const found = declared.get(key);
      return found ? [found] : [];
    });
  }

  async run(tenant: string, product: ProductRecord, input: SeriesRunInput): Promise<SeriesRunOutcome> {
    if (this.deps.submitSeriesRun === undefined) return { triggered: [], failedSeries: [] };
    // The active planned release scopes the import fan-out AND stamps every batch, whichever trigger fired:
    // a run submitted while a release is being planned is evidence that release will be judged on.
    const planned = (await this.deps.releases.list(tenant, { productId: product.id, status: "planned" }))[0];
    const series =
      input.keys === undefined ? watchedSeries(product, planned) : SeriesEvaluator.select(product, input.keys);
    if (series.length === 0) return { triggered: [], failedSeries: [] };
    const triggered: string[] = [];
    const failedSeries: Array<{ key: string; error: string }> = [];
    for (const entry of series) {
      try {
        // WHICH QUESTION this batch is about to answer (arch-review 13 P0) — the series' concrete
        // dataset/harness/judge closure, resolved NOW. Version-less refs mean "latest at run time", so the
        // digest has to be taken over what the run will actually use, not over the refs as written; without
        // it a release read cannot tell a batch that answered today's question from one that answered
        // last month's under the same series key. Unresolvable → no stamp, which readiness treats as
        // evidence whose question cannot be named (blocking, not silently current).
        const contract = this.deps.resolveSeriesContract
          ? await this.deps
              .resolveSeriesContract(tenant, entry)
              .catch((): SeriesContractResolution => ({ status: "unresolvable", reason: "resolver threw" }))
          : ({ status: "unknown" } as SeriesContractResolution);
        // A series whose current definition cannot be resolved must not be RUN either — an evaluation we
        // cannot describe produces evidence nobody can place. The readiness side already blocks on this; the
        // producer refusing keeps the two halves saying one thing.
        if (contract.status === "unresolvable") {
          failedSeries.push({ key: entry.key, error: `series definition unresolvable: ${contract.reason}` });
          continue;
        }
        // `unknown` = this deployment has no resolver, so there is no plan to carry and the series runs from
        // its declaration exactly as it always did — honestly unstamped, which readiness reads as evidence
        // whose question cannot be named.
        const plan = contract.status === "resolved" ? contract.contract : undefined;
        const submitted = await this.deps.submitSeriesRun({
          tenant,
          submittedBy: input.submittedBy,
          // The RESOLVED plan, not the declaration (arch-review 14 P0). Submitting `entry.*` sent
          // version-less refs that submit re-resolved — so a `latest` that moved between the stamp and the
          // dispatch produced a scorecard whose recorded question and executed question were different
          // versions. The digest above and these refs now come from ONE resolution.
          dataset: plan?.dataset ?? entry.dataset,
          harness: plan?.harness ?? entry.harness,
          judges: plan?.judges ?? entry.judges,
          // …and submit must SEAL the same one (arch-review 16 P0-3). Passing the resolved top-level refs
          // closes the version race; it does not close the CLOSURE race, because submit re-resolves each
          // spec's floating `{ref}` bindings itself. If a model's `latest` moved between this resolution and
          // that seal, the record would carry an origin naming one question and a manifest answering
          // another — so submit compares its own seal against this digest and refuses instead.
          ...(contract.status === "resolved" ? { expectedContractDigest: contract.digest } : {}),
          ...(product.autoEval.runtime !== undefined ? { runtime: product.autoEval.runtime } : {}),
          origin: {
            source: "product",
            productId: product.id,
            ...(planned !== undefined ? { releaseId: planned.id } : {}),
            seriesKey: entry.key,
            ...(contract.status === "resolved" ? { seriesContractDigest: contract.digest } : {}),
            seriesTrigger: input.trigger,
            ...(input.serviceVersion !== undefined ? { serviceVersion: input.serviceVersion } : {}),
          },
        });
        triggered.push(submitted.id);
      } catch (err) {
        // One series' failed submit must not sink the others — on the import path the rows already landed,
        // and on the declaration path the series is already declared. The failure rides the outcome so it
        // never reads as "the product got worse".
        failedSeries.push({ key: entry.key, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { triggered, failedSeries };
  }
}
