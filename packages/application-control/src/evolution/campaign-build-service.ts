import type {
  CampaignBuildRecord,
  CampaignBuildSetRecord,
  CampaignBuildState,
  DomainFact,
  HarnessInstanceSpec,
  HarnessTemplateSpec,
} from "@everdict/contracts";
import { BadRequestError, ConflictError, NotFoundError } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { CampaignBuildStore } from "../ports/evolution-campaign-store.js";

// ── EVERDICT BUILDS THE CANDIDATE, INTO ITS OWN STORE (docs/architecture/code-evolution-loop.md, D2) ──
//
// A code-evolution campaign changes a harness's repository, and the image that change produces is built by
// EVERDICT — never an outside CI, never a Dockerfile builder. The recipe is frozen on the harness TEMPLATE
// (`source` + `build` on the slot): a build session boots the slot's current image, clones the repository at
// a commit, runs the build steps, and publishes the declared paths as ONE layer on that base into the
// tenant's managed registry (the same daemonless registry-protocol path a world snapshot takes). The digest
// the store hands back becomes a real harness instance version, which is the round's candidate.
//
// Everything the record says about the bytes is Everdict's OWN account: the commit is what the session
// OBSERVED (`git rev-parse HEAD`), the image is what the registry stored, the receipt names the steps it ran.
// So a round built this way reads `execution_world` as held and needs no identity waiver — the platform is
// vouching for bytes it produced rather than trusting a caller's coordinates.

// The session surface the build drives — structural, so `SandboxSessionService` satisfies it without this
// package depending on its whole shape. Each op is scoped to the session's creator (the build's `by`).
export interface BuildSession {
  create(input: {
    tenant: string;
    createdBy: string;
    image: string;
    repo: { git: string; ref?: string; dir?: string };
    runtime?: string;
    ttlSec?: number;
  }): Promise<{ id: string }>;
  exec(
    actor: { tenant: string; subject: string; isAdmin: boolean },
    runId: string,
    input: { command: string; timeoutSec?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  publishBuildLayer(
    actor: { tenant: string; subject: string; isAdmin: boolean },
    runId: string,
    input: { repository: string; tag: string; roots: string[]; createdBy: string },
  ): Promise<{ digest: string }>;
  close(
    actor: { tenant: string; subject: string; isAdmin: boolean },
    runId: string,
    input?: { snapshot?: boolean },
  ): Promise<unknown>;
  imageEndpoint(): { endpoint: string; namespaceFor(tenant: string): string };
}

export interface CampaignBuildDeps {
  builds: CampaignBuildStore;
  // The campaign the build is for — its subject (the harness family and baseline) and its team.
  campaigns: {
    get(
      tenant: string,
      id: string,
    ): Promise<{
      id: string;
      teamId?: string;
      // Widened for the environment subject (harness-definability-spec.md §2); this service still refuses
      // anything but a harness — building a candidate IMAGE is a harness slot's recipe, and an environment
      // candidate is authored and registered rather than built.
      subjectType: "agent" | "harness" | "environment";
      subjectId: string;
      baselineVersion: string;
    }>;
  };
  // The harness the build extends: the instance (to resolve the slot's base image) and the template (the
  // slot's `source` + `build` recipe). Reads only.
  harness: {
    instance(tenant: string, id: string, version: string): Promise<HarnessInstanceSpec>;
    template(tenant: string, id: string, version: string): Promise<HarnessTemplateSpec>;
    // Resolve the whole instance so the slot's concrete image can be read (template + pins).
    resolvedImageOf(tenant: string, id: string, version: string, slot: string): Promise<string | undefined>;
  };
  // Mint the candidate instance version from the built digest(s) — the one door a re-pin goes through, so the
  // build and a headless CI re-pin produce the same shape. One pin for a plain build, every slot of a build set
  // (evolution-routing-spec.md §4). `version` names the version to mint when the caller derived it (a set's
  // `versionName`), so a retry meets the registry's immutability as "already minted", never as a second name.
  repin(input: {
    tenant: string;
    by: string;
    id: string;
    pins: Record<string, string>;
    version?: string;
    note: string;
  }): Promise<{ version: string }>;
  sessions: BuildSession;
  newId?: () => string;
  now?: () => string;
}

export interface StartBuildInput {
  campaignId: string;
  // Which pull request / commit to build. `ref` is what to check out (a branch, tag or sha); the build writes
  // back the sha it OBSERVED. `repo`/`prNumber` are the pull-request coordinates, carried onto the candidate.
  ref: string;
  repo?: string;
  prNumber?: number;
  // The slot to rebuild — a template service name, or "image" for a command harness. Default: the sole
  // buildable slot when the template has exactly one.
  slot?: string;
}

// A build SET (evolution-routing-spec.md §4): several slots of one pull request, one candidate version.
export interface StartBuildSetInput {
  campaignId: string;
  ref: string; // the one head every member checks out
  repo?: string;
  prNumber?: number;
  slots: string[]; // at least two, distinct, each with a build recipe on the template
}

export class CampaignBuildService {
  private readonly newId: () => string;
  private readonly now: () => string;
  constructor(private readonly deps: CampaignBuildDeps) {
    this.newId = deps.newId ?? (() => `bld_${Math.random().toString(36).slice(2, 12)}`);
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private stamped(tenant: string, facts: DomainFact[]) {
    return stampFacts(tenant, facts, { newId: this.newId, now: this.now }).map((f) => f.record);
  }

  async get(tenant: string, id: string): Promise<CampaignBuildRecord> {
    const record = await this.deps.builds.get(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, "campaign build not found");
    return record;
  }

  async forCampaign(tenant: string, campaignId: string): Promise<CampaignBuildRecord[]> {
    return this.deps.builds.forCampaign(tenant, campaignId);
  }

  async getSet(tenant: string, id: string): Promise<CampaignBuildSetRecord> {
    const record = await this.deps.builds.getSet(tenant, id);
    if (!record) throw new NotFoundError("NOT_FOUND", { id }, "campaign build set not found");
    return record;
  }

  async setsForCampaign(tenant: string, campaignId: string): Promise<CampaignBuildSetRecord[]> {
    return this.deps.builds.setsForCampaign(tenant, campaignId);
  }

  // ── START A BUILD SET (evolution-routing-spec.md §4) ─────────────────────────────────────────────
  //
  // One pull request, several slots, one version. Every slot must carry a build recipe; the set's version name
  // is derived from the set id so a re-driven mint re-mints the same name. Member ids derive from the set id too —
  // one `newId` per set, and no member can collide with another set's.
  async startSet(tenant: string, input: StartBuildSetInput, by: string): Promise<CampaignBuildSetRecord> {
    const campaign = await this.deps.campaigns.get(tenant, input.campaignId);
    if (campaign.subjectType !== "harness")
      throw new BadRequestError(
        "BAD_REQUEST",
        { campaign: input.campaignId, subject: campaign.subjectType },
        "only a harness campaign builds candidate images — an agent campaign evolves a configuration, not code",
      );
    const slots = [...new Set(input.slots)];
    if (slots.length < 2 || slots.length !== input.slots.length)
      throw new BadRequestError(
        "BAD_REQUEST",
        { slots: input.slots },
        "a build set names at least two DISTINCT slots — one slot is a plain build, a repeated slot is one build twice",
      );
    const template = await this.deps.harness
      .template(tenant, campaign.subjectId, campaign.baselineVersion)
      .catch(() => {
        throw new NotFoundError(
          "NOT_FOUND",
          { harness: campaign.subjectId },
          "the campaign's harness baseline could not be resolved",
        );
      });
    const setId = this.newId();
    const members: CampaignBuildRecord[] = [];
    for (const slot of slots) {
      const { recipe } = resolveBuildSlot(template, slot); // refuses a slot with no recipe, by name
      const baseImage = await this.deps.harness.resolvedImageOf(
        tenant,
        campaign.subjectId,
        campaign.baselineVersion,
        slot,
      );
      if (baseImage === undefined)
        throw new BadRequestError(
          "BAD_REQUEST",
          { harness: campaign.subjectId, slot },
          `slot '${slot}' of ${campaign.subjectId}@${campaign.baselineVersion} resolves to no image to build on`,
        );
      members.push({
        id: `${setId}-${imageRepoName(slot)}`,
        tenant,
        campaignId: input.campaignId,
        slot,
        setId,
        source: {
          git: recipe.source.git,
          ...(recipe.source.repo !== undefined
            ? { repo: recipe.source.repo }
            : input.repo !== undefined
              ? { repo: input.repo }
              : {}),
          ref: input.ref,
          ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
        },
        base: { version: campaign.baselineVersion, image: baseImage },
        state: "building",
        createdBy: by,
        createdAt: this.now(),
        updatedAt: this.now(),
      });
    }
    const set: CampaignBuildSetRecord = {
      id: setId,
      tenant,
      campaignId: input.campaignId,
      memberIds: members.map((m) => m.id),
      source: {
        ref: input.ref,
        ...(input.repo !== undefined ? { repo: input.repo } : {}),
        ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
      },
      base: { version: campaign.baselineVersion },
      versionName: `${campaign.baselineVersion}-set-${setId.slice(-8)}`,
      state: "building",
      createdBy: by,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.deps.builds.createSet(set);
    for (const member of members) await this.deps.builds.create(member);
    return set;
  }

  // ── DRIVE A BUILD SET TO ITS ONE MINT (evolution-routing-spec.md §4) ─────────────────────────────
  //
  // Members build in order (a member another driver already built is read, not rebuilt). Then the authority: the
  // observed commits must agree (or the pull request moved between builds), and `claimMint` must answer
  // `claimed` — exactly one driver gets it. The claimer mints under the set's own version name; a registry that
  // already holds that name with these pins is a retry meeting its earlier self, not a second version.
  async runSet(tenant: string, setId: string): Promise<CampaignBuildSetRecord> {
    const set = await this.getSet(tenant, setId);
    if (set.state !== "building") return set;
    const by = set.createdBy;
    const campaign = await this.deps.campaigns.get(tenant, set.campaignId);
    const failSet = async (error: string, slot: string, buildId: string): Promise<CampaignBuildSetRecord> => {
      const fact: DomainFact = {
        kind: "campaign.candidate_build_failed",
        subject: { type: "campaign", id: set.campaignId },
        actor: by,
        payload: {
          campaignId: set.campaignId,
          buildId,
          buildSetId: setId,
          slot,
          error,
          ...(campaign.teamId !== undefined ? { teamId: campaign.teamId } : {}),
        },
      };
      await this.deps.builds.settleSet(
        tenant,
        setId,
        { state: "failed", error, at: this.now() },
        this.stamped(tenant, [fact]),
      );
      return this.getSet(tenant, setId);
    };
    const members: CampaignBuildRecord[] = [];
    for (const memberId of set.memberIds) {
      const built = await this.run(tenant, memberId);
      if (built.state === "failed") return failSet(built.error ?? "a member build failed", built.slot, built.id);
      if (built.state !== "built")
        return failSet(`member ${built.id} is ${built.state} after its build`, built.slot, built.id);
      members.push(built);
    }
    const shas = [...new Set(members.map((m) => m.source.sha))];
    const sha = shas[0];
    if (shas.length !== 1 || sha === undefined)
      return failSet(
        `the members observed different commits (${shas.join(", ")}) — the pull request moved between builds; start the set again on its current head`,
        members.map((m) => m.slot).join(","),
        setId,
      );
    const images: Record<string, string> = {};
    for (const m of members) if (m.image !== undefined) images[m.slot] = m.image.ref;
    // THE AUTHORITY BEFORE THE EFFECT (L1): one claim, one mint.
    const claim = await this.deps.builds.claimMint(tenant, setId, this.now());
    if (claim !== "claimed") return this.getSet(tenant, setId); // another driver is minting, or the set already settled
    try {
      const version = await this.mintSet(tenant, campaign.subjectId, set, images, by, sha);
      const fact: DomainFact = {
        kind: "campaign.candidate_built",
        subject: { type: "campaign", id: set.campaignId },
        actor: by,
        payload: {
          campaignId: set.campaignId,
          buildId: setId,
          buildSetId: setId,
          slot: members.map((m) => m.slot).join(","),
          sha,
          candidateVersion: version,
          image: Object.values(images).join(" "),
          ...(campaign.teamId !== undefined ? { teamId: campaign.teamId } : {}),
        },
      };
      const outcome = await this.deps.builds.settleSet(
        tenant,
        setId,
        { state: "minted", candidateVersion: version, images, sha, at: this.now() },
        this.stamped(tenant, [fact]),
      );
      if (outcome !== "settled")
        throw new ConflictError(
          "CONFLICT",
          { set: setId, outcome },
          `the set minted but its record could not be settled (${outcome})`,
        );
      return this.getSet(tenant, setId);
    } catch (err) {
      return failSet(err instanceof Error ? err.message : String(err), members.map((m) => m.slot).join(","), setId);
    }
  }

  // The mint, idempotent under the set's own version name: a registry that already holds `versionName` with
  // exactly these pins is this set's earlier attempt, and the answer is that version — a different document
  // under that name is a refusal, never a silent second version.
  private async mintSet(
    tenant: string,
    harnessId: string,
    set: CampaignBuildSetRecord,
    images: Record<string, string>,
    by: string,
    sha: string,
  ): Promise<string> {
    try {
      const minted = await this.deps.repin({
        tenant,
        by,
        id: harnessId,
        pins: images,
        version: set.versionName,
        note: `built by campaign ${set.campaignId} from ${sha} (build set ${set.id}: ${Object.keys(images).sort().join(", ")})`,
      });
      return minted.version;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      const existing = await this.deps.harness.instance(tenant, harnessId, set.versionName).catch(() => undefined);
      const same = existing !== undefined && Object.entries(images).every(([slot, ref]) => existing.pins[slot] === ref);
      if (!same)
        throw new ConflictError(
          "CONFLICT",
          { version: set.versionName },
          `${harnessId}@${set.versionName} already exists with different pins — this set cannot mint under its name`,
        );
      return set.versionName;
    }
  }

  // Open the build: resolve the recipe, create the `building` record and its fact, and drive the session in
  // the background — a real build is minutes, so the caller gets the record and waits on the fact. Returns the
  // building record; `run` settles it.
  async start(tenant: string, input: StartBuildInput, by: string): Promise<CampaignBuildRecord> {
    const campaign = await this.deps.campaigns.get(tenant, input.campaignId);
    if (campaign.subjectType !== "harness")
      throw new BadRequestError(
        "BAD_REQUEST",
        { campaign: input.campaignId, subject: campaign.subjectType },
        "only a harness campaign builds candidate images — an agent campaign evolves a configuration, not code",
      );
    const template = await this.deps.harness
      .template(tenant, campaign.subjectId, campaign.baselineVersion)
      .catch(() => {
        throw new NotFoundError(
          "NOT_FOUND",
          { harness: campaign.subjectId },
          "the campaign's harness baseline could not be resolved",
        );
      });
    // The instance whose slot image the build extends — always the campaign's frozen BASELINE, so every
    // candidate is one change off the same base (the frame's fixed baseline, in code).
    const instance = await this.deps.harness.instance(tenant, campaign.subjectId, campaign.baselineVersion);
    const { slot, recipe } = resolveBuildSlot(template, input.slot);
    const baseImage = await this.deps.harness.resolvedImageOf(
      tenant,
      campaign.subjectId,
      campaign.baselineVersion,
      slot,
    );
    if (baseImage === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { harness: campaign.subjectId, slot },
        `slot '${slot}' of ${campaign.subjectId}@${campaign.baselineVersion} resolves to no image to build on`,
      );
    void instance; // resolved above to fail fast on a missing baseline; the image is what the build extends
    const id = this.newId();
    const record: CampaignBuildRecord = {
      id,
      tenant,
      campaignId: input.campaignId,
      slot,
      source: {
        git: recipe.source.git,
        ...(recipe.source.repo !== undefined
          ? { repo: recipe.source.repo }
          : input.repo !== undefined
            ? { repo: input.repo }
            : {}),
        ref: input.ref,
        ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
      },
      base: { version: campaign.baselineVersion, image: baseImage },
      state: "building",
      createdBy: by,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.deps.builds.create(record);
    return record;
  }

  // Drive the build session to completion and settle the record. Called by the transport in the background
  // after `start`. Every failure settles the record `failed` and writes its fact — a build that threw and
  // recorded nothing would be a `building` row nobody converges.
  async run(tenant: string, id: string): Promise<CampaignBuildRecord> {
    const record = await this.get(tenant, id);
    if (record.state !== "building") return record;
    const by = record.createdBy;
    const actor = { tenant, subject: by, isAdmin: false };
    const campaign = await this.deps.campaigns.get(tenant, record.campaignId);
    const template = await this.deps.harness.template(tenant, campaign.subjectId, campaign.baselineVersion);
    const { recipe } = resolveBuildSlot(template, record.slot);
    const startedAt = this.now();
    let sessionRunId: string | undefined;
    let observedSha: string | undefined;
    try {
      const session = await this.deps.sessions.create({
        tenant,
        createdBy: by,
        image: record.base.image,
        repo: {
          git: record.source.git,
          ...(record.source.ref !== undefined ? { ref: record.source.ref } : {}),
          dir: BUILD_REPO_DIR,
        },
      });
      sessionRunId = session.id;
      // The commit the session actually checked out — Everdict's own observation, not the caller's `ref`.
      const head = await this.deps.sessions.exec(actor, session.id, {
        command: `git -C ${sh(BUILD_REPO_DIR)} rev-parse HEAD`,
      });
      if (head.exitCode !== 0)
        throw new BadRequestError(
          "BAD_REQUEST",
          { runId: session.id },
          `could not read the checked-out commit: ${clamp(head.stderr)}`,
        );
      observedSha = head.stdout.trim();
      const workDir = recipe.build.workDir;
      // The clone landed in BUILD_REPO_DIR; the recipe runs in its own workDir, which the first step usually
      // populates from the repo (e.g. `cp -r ../repo/. .`). Both are made and the steps run in workDir.
      await this.execOrThrow(actor, session.id, `mkdir -p ${sh(workDir)}`, recipe.build.timeoutSec);
      for (const step of recipe.build.steps)
        await this.execOrThrow(actor, session.id, `cd ${sh(workDir)} && ${step}`, recipe.build.timeoutSec);
      const capture = recipe.build.capture ?? [workDir];
      const tag = `sha-${(observedSha ?? this.newId()).slice(0, 12)}`;
      const repository = `${imageRepoName(campaign.subjectId)}-${imageRepoName(record.slot)}`;
      const { digest } = await this.deps.sessions.publishBuildLayer(actor, session.id, {
        repository,
        tag,
        roots: capture,
        createdBy: `everdict build of ${campaign.subjectId} slot ${record.slot} at ${observedSha} (campaign ${record.campaignId})`,
      });
      const endpoint = this.deps.sessions.imageEndpoint();
      const ref = `${endpoint.endpoint}/${endpoint.namespaceFor(tenant)}/${repository}:${tag}@${digest}`;
      // Mint the candidate instance version pinning the built image into the slot — the one re-pin door. A set
      // MEMBER builds and stops: the set mints once, after every member (evolution-routing-spec.md §4).
      const minted =
        record.setId === undefined
          ? await this.deps.repin({
              tenant,
              by,
              id: campaign.subjectId,
              pins: { [record.slot]: ref },
              note: `built by campaign ${record.campaignId} from ${observedSha} (build ${id})`,
            })
          : undefined;
      await this.deps.sessions.close(actor, session.id, { snapshot: false }).catch(() => undefined);
      const receipt = {
        steps: recipe.build.steps,
        stepsDigest: contentDigest(recipe.build.steps),
        workDir,
        capture,
        startedAt,
        finishedAt: this.now(),
      };
      const image = { repository, tag, ref, digest };
      // A plain build's news is its mint; a set member's news is the SET's mint, so a member emits nothing here.
      const facts: DomainFact[] =
        minted !== undefined
          ? [
              {
                kind: "campaign.candidate_built",
                subject: { type: "campaign", id: record.campaignId },
                actor: by,
                payload: {
                  campaignId: record.campaignId,
                  buildId: id,
                  slot: record.slot,
                  sha: observedSha,
                  candidateVersion: minted.version,
                  image: ref,
                  ...(campaign.teamId !== undefined ? { teamId: campaign.teamId } : {}),
                },
              },
            ]
          : [];
      const outcome = await this.deps.builds.complete(
        tenant,
        id,
        {
          sha: observedSha,
          image,
          ...(minted !== undefined ? { candidateVersion: minted.version } : {}),
          receipt,
          at: this.now(),
        },
        this.stamped(tenant, facts),
      );
      if (outcome !== "completed") {
        // Another driver of the same set built this member first: its record is the answer, not an error.
        const landed = await this.get(tenant, id);
        if (landed.state === "built") return landed;
        throw new ConflictError(
          "CONFLICT",
          { build: id, outcome },
          `the build finished but its record could not be settled (${outcome})`,
        );
      }
      return this.get(tenant, id);
    } catch (err) {
      if (sessionRunId !== undefined)
        await this.deps.sessions.close(actor, sessionRunId, { snapshot: false }).catch(() => undefined);
      const error = err instanceof Error ? err.message : String(err);
      const fact: DomainFact = {
        kind: "campaign.candidate_build_failed",
        subject: { type: "campaign", id: record.campaignId },
        actor: by,
        payload: {
          campaignId: record.campaignId,
          buildId: id,
          slot: record.slot,
          error,
          ...(campaign.teamId !== undefined ? { teamId: campaign.teamId } : {}),
        },
      };
      await this.deps.builds
        .fail(
          tenant,
          id,
          { error, ...(observedSha !== undefined ? { sha: observedSha } : {}), at: this.now() },
          this.stamped(tenant, [fact]),
        )
        .catch(() => undefined);
      return this.get(tenant, id);
    }
  }

  private async execOrThrow(
    actor: { tenant: string; subject: string; isAdmin: boolean },
    runId: string,
    command: string,
    timeoutSec?: number,
  ): Promise<void> {
    const res = await this.deps.sessions.exec(actor, runId, {
      command,
      ...(timeoutSec !== undefined ? { timeoutSec } : {}),
    });
    if (res.exitCode !== 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { runId, command: command.slice(0, 200), exitCode: res.exitCode },
        `build step failed (exit ${res.exitCode}): ${clamp(res.stderr || res.stdout)}`,
      );
  }
}

// The clone lands here; the recipe's workDir is where steps run.
const BUILD_REPO_DIR = "/everdict/repo";

// The buildable slot and its recipe. A template with exactly one buildable slot needs no name; more than one
// is named, and a name that is not buildable is refused (a recipe nobody wrote is not a slot).
interface BuildRecipe {
  source: { git: string; repo?: string };
  build: { steps: string[]; workDir: string; capture?: string[]; timeoutSec?: number };
}
function resolveBuildSlot(
  template: HarnessTemplateSpec,
  requested: string | undefined,
): { slot: string; recipe: BuildRecipe } {
  const buildable: Array<{ slot: string } & BuildRecipe> = [];
  if (template.kind === "command") {
    if (template.source !== undefined && template.build !== undefined)
      buildable.push({ slot: "image", source: template.source, build: template.build });
  } else if (template.kind === "service") {
    for (const svc of template.services)
      if (svc.source !== undefined && svc.build !== undefined)
        buildable.push({ slot: svc.slot ?? svc.name, source: svc.source, build: svc.build });
  }
  if (buildable.length === 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { template: `${template.id}@${template.version}` },
      "this harness template declares no buildable slot (a service with `source` + `build`) — add the build recipe to the template, or evolve it by pinning instead of building",
    );
  const chosen =
    requested !== undefined
      ? buildable.find((b) => b.slot === requested)
      : buildable.length === 1
        ? buildable[0]
        : undefined;
  if (chosen === undefined)
    throw new BadRequestError(
      "BAD_REQUEST",
      { requested: requested ?? null, buildable: buildable.map((b) => b.slot) },
      requested !== undefined
        ? `slot '${requested}' has no build recipe on this template`
        : `this template has ${buildable.length} buildable slots — name one: ${buildable.map((b) => b.slot).join(", ")}`,
    );
  return { slot: chosen.slot, recipe: { source: chosen.source, build: chosen.build } };
}

// A managed-store repository segment: lowercase, single segment (IMAGE_REPOSITORY_NAME's shape).
function imageRepoName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "harness"
  );
}

function sh(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function clamp(text: string, max = 2000): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

// Re-exported so the transport can name the states without reaching into contracts twice.
export type { CampaignBuildState };
