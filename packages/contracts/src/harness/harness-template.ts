import { z } from "zod";
import { BadRequestError } from "../errors.js";
import { VersionSchema } from "../version.js";
import {
  CommandHarnessSpecSchema,
  CommandTraceSpecSchema,
  type EnvValue,
  EnvValueSchema,
  FrontDoorSpecSchema,
  HarnessSeedsSchema,
  type HarnessSpec,
  LiveScreenSpecSchema,
  ProcessHarnessSpecSchema,
  ServiceHarnessSpecSchema,
  ServiceReadinessSchema,
  ServiceResourcesSchema,
  TopologyDependencySchema,
  TopologyServiceSchema,
  TopologyTargetSchema,
  TraceSourceSpecSchema,
  caseTokenDefects,
  commandConversationDefects,
} from "./harness-spec.js";
import { ModelBindingSchema } from "./model-spec.js";

// Harness taxonomy: Template (category) + Instance (individual harness).
// Template = the structural skeleton (versions not pinned, version target = slot). Instance = a template reference + pins (slot→concrete version/image, delta).
// resolveHarnessInstance(template, instance) → HarnessSpec (resolved) — the existing form consumed by backends/runtimes.
// Design: docs/architecture/harness-taxonomy.md.

// Category label — for web grouping / onboarding form selection. A few seeds + free custom.
export const HarnessCategorySchema = z.string().min(1);

// --- service(topology) template ---
// Service structure. slot = the key name the instance pins (name if unspecified). `image` is the DEFAULT for that
// slot: without it every instance had to re-state every service's image just to vary one, which is what pushed
// "same shape, one image different" back into editing the template. Unset = the pin is required (previous behavior).
// ── WHERE A SLOT'S CODE LIVES, AND HOW EVERDICT BUILDS ITS IMAGE FROM A COMMIT ────────────────────────
//
// A code-evolution campaign changes the repository behind a slot and needs the image that change produces —
// built by Everdict into its own managed store, never by an outside CI (docs/architecture/code-evolution-loop.md,
// D2). The recipe is part of the TEMPLATE: it is frozen with the template version, so "how this harness is
// made" is part of the harness's identity rather than a step somebody remembers.
//
// The build is "the slot's base image + one layer": a build session boots the slot's current image, clones the
// repository at the commit, runs `steps` in `workDir`, and publishes `capture` (default: the workDir) as a layer
// on that base through the registry protocol — no daemon, no Dockerfile builder. What the base contains is the
// author's (their Dockerfile); what the commit adds is Everdict's to capture and to name.
// WHO maintains this code (docs/architecture/evolution-routing-spec.md §1): the delegation profile — the coding
// agent built for THIS repository, its instructions file, its tool conventions, its model. It lives on the slot's
// source because the slot is the SSOT of "this code, built this way"; a workspace-level repository → profile map
// would be a second owner of a fact the template already half-owns, and drift the moment a slot's repository moves.
export const HarnessMaintainerSchema = z.object({
  profile: z.string().min(1), // a delegation profile id (CapabilityRecord of type `delegation`)
  version: z.string().min(1).optional(), // pin a profile version; absent = the workspace's current one
});
export type HarnessMaintainer = z.infer<typeof HarnessMaintainerSchema>;

export const HarnessSourceSchema = z.object({
  git: z.string().min(1), // the clone URL (a private repository needs the workspace GitHub App on its owner)
  repo: z.string().min(1).optional(), // "owner/name", when the URL is a GitHub repository — the pull-request coordinate
  maintainer: HarnessMaintainerSchema.optional(),
});
export type HarnessSource = z.infer<typeof HarnessSourceSchema>;

export const HarnessBuildSchema = z.object({
  steps: z.array(z.string().min(1)).min(1), // run in order, in workDir, inside the base image
  // Absolute, because the capture is a tar of paths from `/` and the clone lands here. Default: a directory the
  // base image is unlikely to own, so the layer carries the build and nothing the base already had.
  workDir: z.string().min(1).regex(/^\//, "build.workDir must be an absolute path").default("/everdict/build"),
  capture: z.array(z.string().min(1).regex(/^\//, "capture paths must be absolute")).optional(), // default [workDir]
  timeoutSec: z.number().int().positive().max(7200).optional(), // the whole build's bound (default 1800)
});
export type HarnessBuild = z.infer<typeof HarnessBuildSchema>;

export const TemplateServiceSchema = TopologyServiceSchema.extend({
  slot: z.string().optional(),
  source: HarnessSourceSchema.optional(),
  build: HarnessBuildSchema.optional(),
});
export type TemplateService = z.infer<typeof TemplateServiceSchema>;

// A template service's image is OPTIONAL (the pin may supply it), so the resolved-spec pairing (validateServiceExec,
// which requires one) cannot run here. What still holds at template time: a host-exec service takes no image and
// must declare its command.
function validateTemplateServiceExec(
  services: Array<Pick<TemplateService, "name" | "exec" | "image">>,
  ctx: z.RefinementCtx,
): void {
  services.forEach((svc, i) => {
    if (svc.exec?.kind !== "host") return;
    if (!svc.exec.command || svc.exec.command.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "exec", "command"],
        message: `Host-exec service "${svc.name}" requires exec.command (the program to run on the node).`,
      });
    }
    if (svc.image !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "image"],
        message: `Host-exec service "${svc.name}" takes no image (it runs directly on the node).`,
      });
    }
  });
}

const templateBase = {
  category: HarnessCategorySchema,
  id: z.string(),
  version: VersionSchema, // shape version — bumped only when the shape changes (services added/removed etc.); pin changes are the instance.
};

export const ServiceTemplateSpecSchema = z.object({
  kind: z.literal("service"),
  ...templateBase,
  services: z.array(TemplateServiceSchema).superRefine(validateTemplateServiceExec),
  dependencies: z.array(TopologyDependencySchema).default([]),
  target: TopologyTargetSchema.optional(),
  frontDoor: FrontDoorSpecSchema,
  traceSource: TraceSourceSpecSchema,
});

// --- command template --- setup/command/env/trace are the structure; image/model can be pinned via pins ("image"/"model").
export const CommandTemplateSpecSchema = z.object({
  kind: z.literal("command"),
  ...templateBase,
  image: z.string().optional(), // default when pins.image is absent
  // The scaffold's own repository and build recipe — the `image` slot is what a code-evolution campaign rebuilds
  // (see HarnessSourceSchema / HarnessBuildSchema above).
  source: HarnessSourceSchema.optional(),
  build: HarnessBuildSchema.optional(),
  resources: ServiceResourcesSchema.optional(), // job-level resource request (cpu/memoryMb) — carried into the resolved spec
  workDir: z.string().optional(),
  setup: z.array(z.string()).default([]),
  command: z.string(),
  env: z.record(EnvValueSchema).default({}), // literal or { secretRef }
  model: z.string().optional(), // default when pins.model is absent
  params: z.record(z.string()).default({}), // {{var}} defaults (an instance's overrides.params overrides them)
  trace: CommandTraceSpecSchema.default({ kind: "none" }),
  liveScreen: LiveScreenSpecSchema.optional(), // opt-in live in-run screen capture (self-driven browser/GUI in the container)
  // How this CLI continues a conversation — the SAME contract the resolved spec carries (harness-spec.ts). It
  // lives on the template because registration is template-only: a contract the template cannot hold is one no
  // registered command harness could ever declare, and `conversational` would stay a marker nothing reaches.
  conversation: CommandHarnessSpecSchema.shape.conversation,
});

// --- process template --- a single process (Claude Code/Codex). Nothing to pin (template version = structure).
export const ProcessTemplateSpecSchema = z.object({
  kind: z.literal("process"),
  ...templateBase,
  resources: ServiceResourcesSchema.optional(), // the box a process harness asks for (harness-definability-spec.md §4)
});

export const HarnessTemplateSpecSchema = z
  .discriminatedUnion("kind", [ServiceTemplateSpecSchema, CommandTemplateSpecSchema, ProcessTemplateSpecSchema])
  // A command template's conversation contract is checked where the TEMPLATE enters — registration is
  // template-only, so this is the door the resolved spec's own refine never sees.
  .superRefine((template, ctx) => {
    if (template.kind !== "command") return;
    for (const message of commandConversationDefects(template))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["conversation"], message });
    // …and the case tokens, at the door registration uses (harness-definability-spec.md §4).
    for (const message of caseTokenDefects(template.command))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["command"], message });
  });
export type HarnessTemplateSpec = z.infer<typeof HarnessTemplateSpecSchema>;

// Instance variation (overrides) — leave the structure (template) alone and layer only "behavior knobs" as a delta. deep-merge at resolve.
// Phase 1 (runtime-agnostic, resolve time only): per-service env overlay · front-door body values · command env/params.
// Image replacement goes through the existing pins (the common case). overrides is the channel for expressing model/temperature/flag/payload variations within the same template.
// Design: docs/architecture/harness-taxonomy.md "Instance variation".
export const InstanceServiceOverrideSchema = z.object({
  env: z.record(EnvValueSchema).optional(), // static service env overlay (merged on top of the template env; below storeEnv) — Phase 1
  // env keys to DROP from the template's env, applied after the merge. The overlay alone can only add or replace, so a
  // template default the variation must not carry (a base URL, a feature flag) had no expression short of a new shape
  // version. Naming a key the template never set is a no-op, not an error — the intent ("this must not be set") holds.
  unsetEnv: z.array(z.string().min(1)).optional(),
  replicas: z.number().int().positive().optional(), // Phase 2 — honored by nomad/k8s (docker single-host = 1)
  resources: ServiceResourcesSchema.optional(), // Phase 2 — cpu/memory (scalar substitution)
  volumes: z.array(z.string()).optional(), // Phase 3 — honored by docker (nomad/k8s follow-up) (scalar substitution)
  readiness: ServiceReadinessSchema.optional(), // Phase 3 — readiness polling bound (scalar substitution)
  // The agent-server model binding (scalar substitution). "Same topology, a different model" is the single most
  // common variation there is, and without this it was a template edit — even though the shape never changes.
  model: ModelBindingSchema.optional(),
});
export type InstanceServiceOverride = z.infer<typeof InstanceServiceOverrideSchema>;

export const InstanceOverridesSchema = z.object({
  // service template: service name → override. If a service name is not in the template, resolve throws BadRequest.
  services: z.record(InstanceServiceOverrideSchema).optional(),
  // service template: front-door submit body values (shallow-merge) + completion timing tuning (spread on top of completion; invalid keys are dropped by re-parse).
  frontDoor: z
    .object({
      request: z.object({ bodyTemplate: z.record(z.unknown()).optional() }).optional(),
      completion: z
        .object({
          timeoutMs: z.number().int().positive().optional(),
          intervalMs: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .optional(),
  // service template: pin the browser target extension ref (Phase 3). If the template has no target, resolve throws BadRequest.
  target: z.object({ extension: z.object({ ref: z.string() }) }).optional(),
  // command template: env overlay + {{var}} values. Each merged on top of the template.
  env: z.record(EnvValueSchema).optional(),
  // command template: env keys to DROP (applied after the merge) — same reason as the per-service `unsetEnv`.
  unsetEnv: z.array(z.string().min(1)).optional(),
  params: z.record(z.string()).optional(),
  // command template: the job's resource request (scalar substitution). A heavier variation of the same CLI agent —
  // one that needs 8 GB where the template asks for 2 — was a template edit, so every such run forked the shape.
  resources: ServiceResourcesSchema.optional(),
});
export type InstanceOverrides = z.infer<typeof InstanceOverridesSchema>;

// Store provenance ANNOTATION for a pin filled from the capability store's ENVIRONMENT assets — the identity of the
// environment capability whose image was inserted. Purely informational: `resolveHarnessInstance` never reads it (the
// pin VALUE stays the verbatim ref — the no-rewrite invariant of docs/architecture/workspace-image-registry.md), the
// web renders a "from store" chip from it. docs/architecture/environment-image-store.md.
export const PinSourceSchema = z
  .object({
    source: z.string(), // the OWNER workspace that published the environment
    id: z.string(),
    version: z.string(), // the environment version whose image was inserted
  })
  .strict();
export type PinSource = z.infer<typeof PinSourceSchema>;

// Individual harness (instance) — a template reference + pins (slot→value, delta) + overrides (structure-invariant behavior delta). Usually one per PR/SHA.
// version is a free string (e.g. "pr-123-sha-abc") — the registry handles non-semver in registration order.
export const HarnessInstanceSpecSchema = z.object({
  template: z.object({ id: z.string(), version: z.string() }),
  id: z.string(), // resolved harness id (conventionally the same as template.id)
  version: VersionSchema, // instance tag
  // This version's changelog (free-text) — entered by the user on deploying a new version, shown on the harness detail. Unset = none.
  // Part of the version spec so immutable (subject to specsEqual): re-registering the same version with different notes → 409. Runtime-agnostic meta, so not carried into resolve.
  description: z.string().optional(),
  pins: z.record(z.string()).default({}), // slot → value (image ref; command uses "image"/"model")
  // The skill and knowledge seeds this VERSION ships with — carried onto the resolved document, so inside its digest
  // (docs/architecture/harness-identity-and-seeds-spec.md §2).
  seeds: HarnessSeedsSchema.optional(),
  pinSources: z.record(PinSourceSchema).optional(), // slot → store environment provenance (annotation; resolve ignores)
  overrides: InstanceOverridesSchema.optional(), // structure-invariant behavior variation (env/body/params) — unset = image only (current)
});
export type HarnessInstanceSpec = z.infer<typeof HarnessInstanceSpecSchema>;

// Drop the named keys from a merged env map. Returns the input untouched when nothing is named, so a spec without
// `unsetEnv` keeps its exact object (and callers comparing specs see no change).
function dropEnvKeys(env: Record<string, EnvValue>, unset: string[] | undefined): Record<string, EnvValue> {
  if (!unset || unset.length === 0) return env;
  const drop = new Set(unset);
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k)));
}

// Template (structure) + Instance (pins) → resolved HarnessSpec. Missing/mismatched slots throw BadRequestError.
export function resolveHarnessInstance(template: HarnessTemplateSpec, instance: HarnessInstanceSpec): HarnessSpec {
  if (template.id !== instance.template.id || template.version !== instance.template.version) {
    throw new BadRequestError(
      "BAD_REQUEST",
      {
        template: `${template.id}@${template.version}`,
        instanceTemplate: `${instance.template.id}@${instance.template.version}`,
      },
      "The instance's template reference does not match the given template.",
    );
  }
  const pins = instance.pins;
  const overrides = instance.overrides;
  switch (template.kind) {
    case "service": {
      // The target service of overrides.services must exist in the template (same discipline as image pins).
      const serviceNames = new Set(template.services.map((s) => s.name));
      for (const name of Object.keys(overrides?.services ?? {})) {
        if (!serviceNames.has(name)) {
          throw new BadRequestError(
            "BAD_REQUEST",
            { service: name, known: [...serviceNames] },
            `Override target service '${name}' is not in the template.`,
          );
        }
      }
      const services = template.services.map((s) => {
        const slot = s.slot ?? s.name;
        // The pin wins; absent, the template's own image is the default. A slot with neither is still an error.
        const image = pins[slot] ?? s.image;
        // A host-exec service runs directly on the node — its slot takes no image pin (there is no container).
        const hostExec = s.exec?.kind === "host";
        if (hostExec && pins[slot] !== undefined) {
          throw new BadRequestError(
            "BAD_REQUEST",
            { service: s.name, slot },
            `Slot '${slot}' belongs to host-exec service '${s.name}' — it takes no image pin.`,
          );
        }
        if (!hostExec && !image) {
          throw new BadRequestError(
            "BAD_REQUEST",
            { service: s.name, slot },
            `No pin (image) for slot '${slot}' of service '${s.name}'.`,
          );
        }
        const ov = overrides?.services?.[s.name];
        // env is merged (instance wins; the runtime does connEnv < this env < storeEnv), THEN the instance's
        // unsetEnv drops keys — the only way a variation can refuse a template default. The other knobs are
        // scalar-substituted (instance if present, else template).
        const env = dropEnvKeys(ov?.env ? { ...s.env, ...ov.env } : s.env, ov?.unsetEnv);
        const volumes = ov?.volumes ?? s.volumes;
        const readiness = ov?.readiness ?? s.readiness;
        const resources = ov?.resources ?? s.resources;
        const model = ov?.model ?? s.model;
        // Spread the template service instead of rebuilding it field-by-field: an allowlist here silently
        // DROPS every field it doesn't name — that bug class ate volumes/readiness once, and later
        // requires/wiring/model (a requires.os=windows topology lost its OS requirement on resolve, so the
        // lease-time placement gate let any Linux runner take it). The spread carries current AND future
        // pass-through fields; only the pinned/overridden ones are recomputed on top.
        const { slot: _slot, ...passthrough } = s;
        return {
          ...passthrough,
          ...(image !== undefined ? { image } : {}), // host-exec services stay imageless
          replicas: ov?.replicas ?? s.replicas,
          env,
          ...(volumes !== undefined ? { volumes } : {}),
          ...(readiness !== undefined ? { readiness } : {}),
          ...(resources !== undefined ? { resources } : {}),
          ...(model !== undefined ? { model } : {}),
        };
      });
      // front-door: submit body values (shallow-merge) + completion timing (spread on top of completion; keys that don't match the mode are dropped by re-parse).
      const bodyOverride = overrides?.frontDoor?.request?.bodyTemplate;
      const completionOverride = overrides?.frontDoor?.completion;
      let frontDoor = template.frontDoor;
      if (bodyOverride) {
        frontDoor = {
          ...frontDoor,
          request: {
            ...(frontDoor.request ?? {}),
            bodyTemplate: { ...(frontDoor.request?.bodyTemplate ?? {}), ...bodyOverride },
          },
        };
      }
      if (completionOverride && frontDoor.completion) {
        frontDoor = {
          ...frontDoor,
          completion: {
            ...frontDoor.completion,
            ...(completionOverride.timeoutMs !== undefined ? { timeoutMs: completionOverride.timeoutMs } : {}),
            ...(completionOverride.intervalMs !== undefined ? { intervalMs: completionOverride.intervalMs } : {}),
          },
        };
      }
      // Target extension ref pin (Phase 3) — the template must have a target (fail clearly otherwise).
      let target = template.target;
      if (overrides?.target) {
        if (!target) {
          throw new BadRequestError(
            "BAD_REQUEST",
            {},
            "overrides.target is present but the template has no target (browser).",
          );
        }
        target = { ...target, extension: { ...(target.extension ?? {}), ref: overrides.target.extension.ref } };
      }
      return ServiceHarnessSpecSchema.parse({
        ...(instance.seeds !== undefined ? { seeds: instance.seeds } : {}),
        kind: "service",
        id: instance.id,
        version: instance.version,
        services,
        dependencies: template.dependencies,
        frontDoor,
        traceSource: template.traceSource,
        ...(target ? { target } : {}),
      });
    }
    case "command": {
      const image = pins.image ?? template.image;
      const model = pins.model ?? template.model;
      // env/params overlay: merged on top of the template (instance wins), then unsetEnv drops keys.
      // params fills command's {{var}}. resources is a scalar substitution (instance if present, else template).
      const env = dropEnvKeys(
        overrides?.env ? { ...template.env, ...overrides.env } : template.env,
        overrides?.unsetEnv,
      );
      const params = overrides?.params ? { ...template.params, ...overrides.params } : template.params;
      const resources = overrides?.resources ?? template.resources;
      return CommandHarnessSpecSchema.parse({
        ...(instance.seeds !== undefined ? { seeds: instance.seeds } : {}),
        kind: "command",
        id: instance.id,
        version: instance.version,
        setup: template.setup,
        command: template.command,
        env,
        params,
        trace: template.trace,
        ...(image !== undefined ? { image } : {}),
        ...(template.workDir !== undefined ? { workDir: template.workDir } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(resources !== undefined ? { resources } : {}),
        ...(template.liveScreen !== undefined ? { liveScreen: template.liveScreen } : {}),
        ...(template.conversation !== undefined ? { conversation: template.conversation } : {}),
      });
    }
    case "process":
      return ProcessHarnessSpecSchema.parse({
        kind: "process",
        id: instance.id,
        version: instance.version,
        ...(instance.seeds !== undefined ? { seeds: instance.seeds } : {}),
        ...((instance.overrides?.resources ?? template.resources) !== undefined
          ? { resources: instance.overrides?.resources ?? template.resources }
          : {}),
      });
  }
}

// ── WHO CHANGES THIS SLOT — a total decision over the template (evolution-routing-spec.md §1) ─────────
//
// The `code_evolve` driver used to answer "which coding agent should I delegate to" by listing the profiles and
// asking the member, once per round, for a fact that does not change between rounds. The template's slot knows:
// `source.maintainer`. This resolves it, and says by name when it cannot — an `unmapped` slot is a template that
// needs a maintainer declared, `no_such_slot` is a caller naming a slot the template does not have, and
// `ambiguous` is a template with several buildable slots and no slot named. Pure and total (no I/O), so the
// agent's MCP door, the build service and a test all read one predicate.
export const DelegateResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile"), slot: z.string(), profile: z.string(), version: z.string().optional() }),
  z.object({ kind: z.literal("unmapped"), slot: z.string() }), // the slot has code (a source) and no maintainer
  z.object({ kind: z.literal("no_such_slot"), slot: z.string(), slots: z.array(z.string()) }),
  z.object({ kind: z.literal("ambiguous"), slots: z.array(z.string()) }), // several slots carry code; name one
]);
export type DelegateResolution = z.infer<typeof DelegateResolutionSchema>;
export function resolveDelegate(template: HarnessTemplateSpec, slot?: string): DelegateResolution {
  const carriers: Array<{ slot: string; source: HarnessSource | undefined }> =
    template.kind === "service"
      ? template.services.map((svc) => ({ slot: svc.slot ?? svc.name, source: svc.source }))
      : [{ slot: "image", source: template.kind === "command" ? template.source : undefined }];
  const withCode = carriers.filter((c) => c.source !== undefined);
  const chosen =
    slot !== undefined ? carriers.find((c) => c.slot === slot) : withCode.length === 1 ? withCode[0] : undefined;
  if (chosen === undefined) {
    if (slot !== undefined) return { kind: "no_such_slot", slot, slots: carriers.map((c) => c.slot) };
    return { kind: "ambiguous", slots: withCode.map((c) => c.slot) };
  }
  const maintainer = chosen.source?.maintainer;
  if (maintainer === undefined) return { kind: "unmapped", slot: chosen.slot };
  return {
    kind: "profile",
    slot: chosen.slot,
    profile: maintainer.profile,
    ...(maintainer.version !== undefined ? { version: maintainer.version } : {}),
  };
}
