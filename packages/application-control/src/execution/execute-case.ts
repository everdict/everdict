import type { AgentJob, CaseResult, RegistryAuth } from "@everdict/contracts";
import { imageUsesRegistryHost } from "@everdict/domain";
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
  // installation account, issue a repo-scoped installation token via that App (independent of the submitter's personal login, team-shared).
  installationTokenFor?: (workspace: string, gitUrl: string) => Promise<string | undefined>;
  // (legacy) personal connection — evalCase.env.source.connectionId → external-account connection token (personally owned, resolved by owner). Removed in S6.
  repoTokenFor?: (owner: string, connectionId: string) => Promise<string | undefined>;
  // Workspace image-registry (plural) pull credentials (best-effort) — if a registry matches the job image's host,
  // attach its credentials via job.registryAuth (transient). docs/architecture/workspace-image-registry.md
  registryAuthsFor?: (workspace: string) => Promise<RegistryAuth[]>;
}

// Every image reference this job can pull — the case image + service-harness service images (+per-dispatch pin override).
export function jobImages(job: AgentJob): string[] {
  const images: string[] = [];
  if (job.evalCase.image) images.push(job.evalCase.image);
  const spec = job.harnessSpec;
  if (spec?.kind === "service") for (const s of spec.services) images.push(job.imagePins?.[s.name] ?? s.image);
  return images;
}

// If any job image belongs to a workspace registry (plural), attach that registry's pull credentials
// (same discipline as repoToken — non-persisted transient). Only the first host match — AgentJob.registryAuth is a singular contract, so
// mixing images from two different BYO registries in one job authenticates only the first match (a documented limitation).
async function resolveRegistryAuth(deps: ExecuteCaseDeps, job: AgentJob): Promise<RegistryAuth | undefined> {
  if (!deps.registryAuthsFor || !job.tenant) return undefined;
  const auths = await deps.registryAuthsFor(job.tenant).catch(() => [] as RegistryAuth[]);
  const images = jobImages(job);
  return auths.find((auth) => images.some((image) => imageUsesRegistryHost(image, auth.host)));
}

// If the case repo seed is private (git), resolve a token. Try the workspace GitHub App (installation) first and
// (if no matching installation) fall back to the legacy personal connection (connectionId). Returns undefined for public/non-repo/unset.
// Module-internal helper (executeCase only) — not exposed externally.
async function resolveRepoToken(deps: ExecuteCaseDeps, owner: string, job: AgentJob): Promise<string | undefined> {
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
function withHarnessImage(job: AgentJob): AgentJob {
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
  job: AgentJob,
  opts?: DispatchOptions,
): Promise<CaseResult> {
  const normalized = withHarnessImage(job);
  const repoToken = await resolveRepoToken(deps, owner, normalized);
  const registryAuth = await resolveRegistryAuth(deps, normalized);
  const enriched: AgentJob = {
    ...normalized,
    ...(repoToken ? { repoToken } : {}),
    ...(registryAuth ? { registryAuth } : {}),
  };
  const result = await deps.dispatcher.dispatch(enriched, opts);
  // A case whose collection was deferred out of the job (traceRef) is completed here — the job was returned when execution ended (2-phase).
  return collectDeferredTrace(deps, enriched.tenant, enriched.evalCase, result);
}
