import type { CaseJob, CaseResult, RegistryAuth } from "@everdict/contracts";
import { registryAuthsForImages } from "@everdict/domain";
import type { DispatchOptions, Dispatcher } from "../ports/dispatcher.js";
import { type CollectTraceDeps, collectDeferredTrace } from "./collect-trace.js";

// Execution concern — a pure unit that runs a single case and produces a result. Shared by run/scorecard.
// It doesn't care about "what comes after (settle·offload·notify)" — that's the orchestration's job (RunService/batch takes the result and settles/notifies).
// A result whose collection the job deferred (traceRef) is completed here (platform pull + scoring deferred observations) — honoring the
// "return a complete CaseResult" contract so settlement (costOf)·judge see the collected trace. docs/architecture/streaming-case-pipeline.md D4
// Both services' Deps are structural supersets of this shape, so each service can pass `this.deps` straight through.
// Extends CollectTraceDeps so the collection knobs (buildTraceSource/secretsFor/sleep/makeGraders) flow straight into
// the collectDeferredTrace call below. docs/architecture/execution-scoring-orchestration.md
export interface ExecuteCaseDeps extends CollectTraceDeps {
  dispatcher: Dispatcher;
  // Resolve a token for seeding a private repo (preferred) — workspace-owned GitHub App. If the case git URL's owner matches the workspace
  // installation account, issue a repo-scoped installation token via that App (independent of the submitter's personal login, workspace-shared).
  installationTokenFor?: (workspace: string, gitUrl: string) => Promise<string | undefined>;
  // (legacy) personal connection — evalCase.env.source.connectionId → external-account connection token (personally owned, resolved by owner). Removed in S6.
  repoTokenFor?: (owner: string, connectionId: string) => Promise<string | undefined>;
  // Image pull credentials for THESE images (best-effort) — the images are passed in because a managed-store grant
  // is minted for exactly the repositories in flight, not handed out as a standing credential; the BYO half
  // ignores them and answers with the workspace's registered registries. docs/architecture/managed-image-store.md
  registryAuthsFor?: (workspace: string, images: string[]) => Promise<RegistryAuth[]>;
}

// Every image reference this job can pull — the case image + service-harness service images (+per-dispatch pin
// override). Host-exec services carry no image and contribute nothing here.
export function jobImages(job: CaseJob): string[] {
  const images: string[] = [];
  if (job.evalCase.image) images.push(job.evalCase.image);
  const spec = job.harnessSpec;
  if (spec?.kind === "service") {
    for (const s of spec.services) {
      const image = job.imagePins?.[s.name] ?? s.image;
      if (image) images.push(image);
    }
  }
  return images;
}

// Every credential covering an image this job pulls (same discipline as repoToken — non-persisted transient).
// All matching registries are attached, not just the first: a topology whose services come from two different
// registries needs both, and a grant/credential is scoped per host so they compose.
async function resolveRegistryAuths(deps: ExecuteCaseDeps, job: CaseJob): Promise<RegistryAuth[]> {
  if (!deps.registryAuthsFor || !job.tenant) return [];
  const images = jobImages(job);
  const auths = await deps.registryAuthsFor(job.tenant, images).catch(() => [] as RegistryAuth[]);
  // Filter again even though the provider was told the images: the BYO half returns every registered registry,
  // and shipping a credential for a host this job never contacts is needless exposure.
  return registryAuthsForImages(auths, images);
}

// If the case repo seed is private (git), resolve a token. Try the workspace GitHub App (installation) first and
// (if no matching installation) fall back to the legacy personal connection (connectionId). Returns undefined for public/non-repo/unset.
// Module-internal helper (executeCase only) — not exposed externally.
async function resolveRepoToken(deps: ExecuteCaseDeps, owner: string, job: CaseJob): Promise<string | undefined> {
  const env = job.evalCase.env;
  if (env.kind !== "repo") return undefined;
  const src = env.source;
  if (!("git" in src)) return undefined;
  // 1) Workspace-owned GitHub App — if the git URL owner matches the workspace installation, use that App's token (preferred).
  if (deps.installationTokenFor && job.tenant) {
    const t = await deps.installationTokenFor(job.tenant, src.git).catch(() => undefined);
    if (t) return t;
  }
  // 2) (legacy) personal connection — resolve connectionId under the submitter (owner). Removed in S6.
  if (deps.repoTokenFor && src.connectionId) return deps.repoTokenFor(owner, src.connectionId).catch(() => undefined);
  return undefined;
}

// Promote a command harness's declared execution image (spec.image — the field a CI re-pin `pins.image` lands on) to the
// case's execution container when the case specifies no image (evalCase.image ??= harnessSpec.image). If the case specifies one,
// the case wins — the dataset stays harness-agnostic. Without this promotion, a command harness's image pin never reaches
// execution: every backend picks the container by evalCase.image (no harness fallback), and the self-hosted runner reads
// only job.evalCase.image → a CI image re-pin becomes a pointless no-op that can't change the container.
// Design: docs/architecture/portable-harness-runtime.md.
function withHarnessImage(job: CaseJob): CaseJob {
  const spec = job.harnessSpec;
  if (!spec || spec.kind !== "command" || !spec.image || job.evalCase.image) return job;
  return { ...job, evalCase: { ...job.evalCase, image: spec.image } };
}

// Pure execution: (promote harness image →) resolve+attach private-repo token → dispatch → (complete collection) → CaseResult.
// budget admit/settle are the orchestration's (caller's) accounting concern — not done here (a run just runs). The caller passes the job
// already enriched (tenant/harnessSpec/judge/meterUsage/submittedBy). opts threads cancellation (signal) + the onStarted
// hook (fires when compute actually begins → the caller flips the run record queued→running) down to the dispatcher.
export async function executeCase(
  deps: ExecuteCaseDeps,
  owner: string,
  job: CaseJob,
  opts?: DispatchOptions,
): Promise<CaseResult> {
  const normalized = withHarnessImage(job);
  const repoToken = await resolveRepoToken(deps, owner, normalized);
  const registryAuths = await resolveRegistryAuths(deps, normalized);
  const enriched: CaseJob = {
    ...normalized,
    ...(repoToken ? { repoToken } : {}),
    ...(registryAuths.length > 0 ? { registryAuths } : {}),
    // Dual-write the deprecated singular field: a self-hosted runner is user-installed and may lag this control
    // plane, and it reads only that field — dropping it would silently un-authenticate an older runner's pulls.
    ...(registryAuths[0] ? { registryAuth: registryAuths[0] } : {}),
  };
  const result = await deps.dispatcher.dispatch(enriched, opts);
  // A case whose collection was deferred out of the job (traceRef) is completed here — the job was returned when execution ended (2-phase).
  return collectDeferredTrace(deps, enriched.tenant, enriched.evalCase, result);
}
