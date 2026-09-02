import { type SeedReader, materializeSeeds } from "@everdict/application-control";
import type { DispatchOptions, Dispatcher } from "@everdict/backends";
import { BadRequestError, type CaseJob, type CaseResult } from "@everdict/contracts";

// ── THE SEEDS TRAVEL WITH THE JOB (docs/architecture/harness-identity-and-seeds-spec.md §2) ──────────
//
// The resolved harness spec names its seeds; the runner has no access to the workspace's records, so the bytes
// are read HERE, once, verified against the version's digests, and attached to the job for the runner to write
// at the mount before the harness starts. Inside the verifier split (the agent half is the half that runs the
// harness), outside model resolution (seeds are not a model binding). A harness with seeds and no tenant cannot
// be materialized and is refused — never dispatched seedless under a digest that says otherwise.
export class SeedingDispatcher implements Dispatcher {
  constructor(
    private readonly seeds: SeedReader,
    private readonly inner: Dispatcher,
  ) {}

  async dispatch(job: CaseJob, opts?: DispatchOptions): Promise<CaseResult> {
    const seeds = job.harnessSpec?.seeds;
    if (seeds === undefined || (seeds.skills.length === 0 && seeds.knowledge.length === 0))
      return this.inner.dispatch(job, opts);
    if (job.tenant === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { harness: `${job.harness.id}@${job.harness.version}` },
        "this harness version ships seeds, and a job with no tenant cannot read them — the run is refused rather than started seedless",
      );
    const seedFiles = await materializeSeeds(job.tenant, seeds, this.seeds);
    return this.inner.dispatch({ ...job, seedFiles }, opts);
  }
}
