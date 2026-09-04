import {
  type CampaignBuildDeps,
  CampaignBuildService,
  type CampaignBuildStore,
  type EnvironmentRegistry,
  type HarnessInstanceRegistry,
  type HarnessTemplateRegistry,
  type SandboxSessionService,
  type WorkspaceImages,
  repinHarnessImages,
} from "@everdict/application-control";
import type { CampaignService } from "@everdict/application-control";
import { resolveHarnessInstance } from "@everdict/contracts";

// ── EVERDICT BUILDS THE CANDIDATE, INTO ITS OWN STORE (docs/architecture/code-evolution-loop.md, D2) ──
//
// The build service turns a campaign\'s repository change into a candidate image in the managed store — a
// build session, a captured layer, a minted harness version. Its dependencies are the pieces the control
// plane already holds; this is where they are joined, as a named function so a counterexample drives the
// production closure rather than one of its own (rule `testing`).
export interface CampaignBuildWiring {
  builds: CampaignBuildStore;
  campaigns: CampaignService;
  instances: HarnessInstanceRegistry;
  templates: HarnessTemplateRegistry;
  // The world's own registry (world-and-engagement-model.md): an environment campaign builds the WORLD and
  // mints a new version of it, the same way a harness campaign builds a slot and re-pins.
  environments: EnvironmentRegistry;
  sessions: SandboxSessionService;
  // The managed image store, for the endpoint the built ref is named against and the digest read-back.
  images: Pick<WorkspaceImages, "endpoint" | "namespaceFor">;
}

export function buildCampaignBuild(deps: CampaignBuildWiring): CampaignBuildService {
  const campaignDep: CampaignBuildDeps["campaigns"] = {
    get: async (tenant, id) => {
      const record = await deps.campaigns.get(tenant, id);
      return {
        id: record.id,
        subjectType: record.frame.subject.type,
        subjectId: record.frame.subject.id,
        baselineVersion: record.frame.subject.baselineVersion,
      };
    },
  };
  const harnessDep: CampaignBuildDeps["harness"] = {
    instance: (tenant, id, version) => deps.instances.getInstance(tenant, id, version),
    template: async (tenant, id, version) => {
      const instance = await deps.instances.getInstance(tenant, id, version);
      return deps.templates.get(tenant, instance.template.id, instance.template.version);
    },
    // The slot\'s concrete image, read from the resolved instance (template + pins). "image" is a command
    // harness\'s single slot; a service name is a topology slot.
    resolvedImageOf: async (tenant, id, version, slot) => {
      const instance = await deps.instances.getInstance(tenant, id, version);
      const template = await deps.templates.get(tenant, instance.template.id, instance.template.version);
      const resolved = resolveHarnessInstance(template, instance);
      if (resolved.kind === "command") return resolved.image;
      if (resolved.kind === "service") return resolved.services.find((svc) => svc.name === slot)?.image;
      return undefined;
    },
  };
  const sessionDep: CampaignBuildDeps["sessions"] = {
    create: async (input) => {
      const record = await deps.sessions.create({
        tenant: input.tenant,
        createdBy: input.createdBy,
        image: input.image,
        repo: input.repo,
        ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
        ...(input.ttlSec !== undefined ? { ttlSec: input.ttlSec } : {}),
      });
      return { id: record.id };
    },
    exec: (actor, runId, cmd) => deps.sessions.exec(actor, runId, cmd),
    publishBuildLayer: (actor, runId, input) => deps.sessions.publishBuildLayer(actor, runId, input),
    close: (actor, runId, input) => deps.sessions.close(actor, runId, input ?? {}),
    imageEndpoint: () => ({
      endpoint: deps.images.endpoint,
      namespaceFor: (tenant) => deps.images.namespaceFor(tenant),
    }),
  };
  return new CampaignBuildService({
    builds: deps.builds,
    campaigns: campaignDep,
    harness: harnessDep,
    // The candidate version is minted through the SAME re-pin door a headless CI re-pin uses (D2), so a build
    // and a merge produce the same shape. The origin is the campaign.
    repin: async ({ tenant, by, id, pins, version, note }) => {
      const result = await repinHarnessImages(
        deps.instances,
        tenant,
        by,
        id,
        { pins, allowTags: false, ...(version !== undefined ? { version } : {}) },
        { via: "ci", note },
      );
      return { version: result.version };
    },
    // The environment lane's mint: a NEW version of the world carrying the built image. Registry versions are
    // immutable, so a re-driven build of the same commit re-registers identical bytes (idempotent) and a
    // non-reproducible one collides by name — the guarantee working, not a failure to paper over.
    environment: {
      get: (tenant, id, version) => deps.environments.get(tenant, id, version),
      mint: async ({ tenant, by, id, version, image, note }) => {
        const base = await deps.environments.get(tenant, id, version.split("-build-")[0] ?? version);
        await deps.environments.register(tenant, { ...base, version, image }, by, { via: "ci", note });
        return { version };
      },
    },
    sessions: sessionDep,
  });
}
