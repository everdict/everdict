import { z } from "zod";
import { BadRequestError } from "./errors.js";
import {
  CommandHarnessSpecSchema,
  CommandTraceSpecSchema,
  EnvValueSchema,
  FrontDoorSpecSchema,
  type HarnessSpec,
  ProcessHarnessSpecSchema,
  ServiceHarnessSpecSchema,
  ServiceReadinessSchema,
  ServiceResourcesSchema,
  TopologyDependencySchema,
  TopologyServiceSchema,
  TopologyTargetSchema,
  TraceSourceSpecSchema,
} from "./harness-spec.js";

// Harness taxonomy: Template (category) + Instance (individual harness).
// Template = the structural skeleton (versions not pinned, version target = slot). Instance = a template reference + pins (slot→concrete version/image, delta).
// resolveHarnessInstance(template, instance) → HarnessSpec (resolved) — the existing form consumed by backends/runtimes.
// Design: docs/architecture/harness-taxonomy.md.

// Category label — for web grouping / onboarding form selection. A few seeds + free custom.
export const HarnessCategorySchema = z.string().min(1);

// --- service(topology) template ---
// Service structure only (no images). slot = the key name the instance pins (name if unspecified).
export const TemplateServiceSchema = TopologyServiceSchema.omit({ image: true }).extend({
  slot: z.string().optional(),
});
export type TemplateService = z.infer<typeof TemplateServiceSchema>;

const templateBase = {
  category: HarnessCategorySchema,
  id: z.string(),
  version: z.string(), // shape version — bumped only when the shape changes (services added/removed etc.); pin changes are the instance.
};

export const ServiceTemplateSpecSchema = z.object({
  kind: z.literal("service"),
  ...templateBase,
  services: z.array(TemplateServiceSchema),
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
  resources: ServiceResourcesSchema.optional(), // job-level resource request (cpu/memoryMb) — carried into the resolved spec
  workDir: z.string().optional(),
  setup: z.array(z.string()).default([]),
  command: z.string(),
  env: z.record(EnvValueSchema).default({}), // literal or { secretRef }
  model: z.string().optional(), // default when pins.model is absent
  params: z.record(z.string()).default({}), // {{var}} defaults (an instance's overrides.params overrides them)
  trace: CommandTraceSpecSchema.default({ kind: "none" }),
});

// --- process template --- a single process (Claude Code/Codex). Nothing to pin (template version = structure).
export const ProcessTemplateSpecSchema = z.object({
  kind: z.literal("process"),
  ...templateBase,
});

export const HarnessTemplateSpecSchema = z.discriminatedUnion("kind", [
  ServiceTemplateSpecSchema,
  CommandTemplateSpecSchema,
  ProcessTemplateSpecSchema,
]);
export type HarnessTemplateSpec = z.infer<typeof HarnessTemplateSpecSchema>;

// Instance variation (overrides) — leave the structure (template) alone and layer only "behavior knobs" as a delta. deep-merge at resolve.
// Phase 1 (runtime-agnostic, resolve time only): per-service env overlay · front-door body values · command env/params.
// Image replacement goes through the existing pins (the common case). overrides is the channel for expressing model/temperature/flag/payload variations within the same template.
// Design: docs/architecture/harness-taxonomy.md "Instance variation".
export const InstanceServiceOverrideSchema = z.object({
  env: z.record(EnvValueSchema).optional(), // static service env overlay (merged on top of the template env; below storeEnv) — Phase 1
  replicas: z.number().int().positive().optional(), // Phase 2 — honored by nomad/k8s (docker single-host = 1)
  resources: ServiceResourcesSchema.optional(), // Phase 2 — cpu/memory (scalar substitution)
  volumes: z.array(z.string()).optional(), // Phase 3 — honored by docker (nomad/k8s follow-up) (scalar substitution)
  readiness: ServiceReadinessSchema.optional(), // Phase 3 — readiness polling bound (scalar substitution)
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
  params: z.record(z.string()).optional(),
});
export type InstanceOverrides = z.infer<typeof InstanceOverridesSchema>;

// Individual harness (instance) — a template reference + pins (slot→value, delta) + overrides (structure-invariant behavior delta). Usually one per PR/SHA.
// version is a free string (e.g. "pr-123-sha-abc") — the registry handles non-semver in registration order.
export const HarnessInstanceSpecSchema = z.object({
  template: z.object({ id: z.string(), version: z.string() }),
  id: z.string(), // resolved harness id (conventionally the same as template.id)
  version: z.string(), // instance tag
  // This version's changelog (free-text) — entered by the user on deploying a new version, shown on the harness detail. Unset = none.
  // Part of the version spec so immutable (subject to specsEqual): re-registering the same version with different notes → 409. Runtime-agnostic meta, so not carried into resolve.
  description: z.string().optional(),
  pins: z.record(z.string()).default({}), // slot → value (image ref; command uses "image"/"model")
  overrides: InstanceOverridesSchema.optional(), // structure-invariant behavior variation (env/body/params) — unset = image only (current)
});
export type HarnessInstanceSpec = z.infer<typeof HarnessInstanceSpecSchema>;

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
        const image = pins[slot];
        if (!image) {
          throw new BadRequestError(
            "BAD_REQUEST",
            { service: s.name, slot },
            `No pin (image) for slot '${slot}' of service '${s.name}'.`,
          );
        }
        const ov = overrides?.services?.[s.name];
        // env is merged (instance wins; the runtime does connEnv < this env < storeEnv). The other knobs are scalar-substituted (instance if present, else template).
        const env = ov?.env ? { ...s.env, ...ov.env } : s.env;
        const volumes = ov?.volumes ?? s.volumes;
        const readiness = ov?.readiness ?? s.readiness;
        const resources = ov?.resources ?? s.resources;
        return {
          name: s.name,
          image,
          needs: s.needs,
          perRun: s.perRun,
          replicas: ov?.replicas ?? s.replicas,
          env,
          ...(s.port !== undefined ? { port: s.port } : {}),
          ...(volumes !== undefined ? { volumes } : {}),
          ...(readiness !== undefined ? { readiness } : {}),
          ...(resources !== undefined ? { resources } : {}),
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
      // env/params overlay: merged on top of the template (instance wins). params fills command's {{var}}.
      const env = overrides?.env ? { ...template.env, ...overrides.env } : template.env;
      const params = overrides?.params ? { ...template.params, ...overrides.params } : template.params;
      return CommandHarnessSpecSchema.parse({
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
        ...(template.resources !== undefined ? { resources: template.resources } : {}),
      });
    }
    case "process":
      return ProcessHarnessSpecSchema.parse({ kind: "process", id: instance.id, version: instance.version });
  }
}
