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

// 하니스 분류(taxonomy): Template(대분류) + Instance(개별 하네스).
// Template = 구조 골격(버전 미고정, 버전 대상 = slot). Instance = template 참조 + pins(슬롯→구체 버전/이미지, 델타).
// resolveHarnessInstance(template, instance) → HarnessSpec(resolved) — 백엔드/런타임이 소비하는 기존 형식.
// 설계: docs/architecture/harness-taxonomy.md.

// 대분류 라벨 — 웹 그룹핑/온보딩 폼 선택용. 시드 몇 개 + custom 자유.
export const HarnessCategorySchema = z.string().min(1);

// --- service(topology) 템플릿 ---
// 서비스 구조만(이미지 없음). slot = 인스턴스가 핀하는 키 이름(미지정이면 name).
export const TemplateServiceSchema = TopologyServiceSchema.omit({ image: true }).extend({
  slot: z.string().optional(),
});
export type TemplateService = z.infer<typeof TemplateServiceSchema>;

const templateBase = {
  category: HarnessCategorySchema,
  id: z.string(),
  version: z.string(), // 구조(shape) 버전 — 서비스 추가/제거 등 모양이 바뀔 때만 올린다(핀 변경은 인스턴스).
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

// --- command 템플릿 --- setup/command/env/trace 가 구조, image/model 은 pins("image"/"model")로 핀 가능.
export const CommandTemplateSpecSchema = z.object({
  kind: z.literal("command"),
  ...templateBase,
  image: z.string().optional(), // pins.image 없을 때의 기본
  workDir: z.string().optional(),
  setup: z.array(z.string()).default([]),
  command: z.string(),
  env: z.record(EnvValueSchema).default({}), // 리터럴 또는 { secretRef }
  model: z.string().optional(), // pins.model 없을 때의 기본
  params: z.record(z.string()).default({}), // {{var}} 기본값(인스턴스 overrides.params 가 덮어쓴다)
  trace: CommandTraceSpecSchema.default({ kind: "none" }),
});

// --- process 템플릿 --- 단일 프로세스(Claude Code/Codex). 핀 대상 없음(템플릿 버전 = 구조).
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

// 인스턴스 변주(overrides) — 구조(템플릿)는 그대로 두고 "동작 노브"만 델타로 얹는다. resolve 시 deep-merge.
// Phase 1(런타임 무관, resolve 시점만): 서비스별 env 오버레이 · front-door 본문 값 · command env/params.
// 이미지 교체는 기존 pins 로(흔한 경우). overrides 는 같은 템플릿 안에서 모델/온도/플래그/페이로드 변주를 표현하는 통로.
// 설계: docs/architecture/harness-taxonomy.md "Instance variation".
export const InstanceServiceOverrideSchema = z.object({
  env: z.record(EnvValueSchema).optional(), // 서비스 정적 env 오버레이(템플릿 env 위에 병합; storeEnv 아래) — Phase 1
  replicas: z.number().int().positive().optional(), // Phase 2 — nomad/k8s 존중(docker 단일호스트=1)
  resources: ServiceResourcesSchema.optional(), // Phase 2 — cpu/memory (scalar 치환)
  volumes: z.array(z.string()).optional(), // Phase 3 — docker 존중(nomad/k8s 후속) (scalar 치환)
  readiness: ServiceReadinessSchema.optional(), // Phase 3 — readiness 폴링 상한 (scalar 치환)
});
export type InstanceServiceOverride = z.infer<typeof InstanceServiceOverrideSchema>;

export const InstanceOverridesSchema = z.object({
  // service 템플릿: 서비스명 → 오버라이드. 템플릿에 없는 서비스명이면 resolve 가 BadRequest.
  services: z.record(InstanceServiceOverrideSchema).optional(),
  // service 템플릿: front-door submit 본문 값(shallow-merge) + 완료 타이밍 튜닝(completion 위에 spread; 무효 키는 재파싱이 제거).
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
  // service 템플릿: 브라우저 타깃 익스텐션 ref 핀(Phase 3). 템플릿에 target 이 없으면 resolve 가 BadRequest.
  target: z.object({ extension: z.object({ ref: z.string() }) }).optional(),
  // command 템플릿: env 오버레이 + {{var}} 값. 각각 템플릿 위에 병합.
  env: z.record(EnvValueSchema).optional(),
  params: z.record(z.string()).optional(),
});
export type InstanceOverrides = z.infer<typeof InstanceOverridesSchema>;

// 개별 하네스(인스턴스) — template 참조 + pins(슬롯→값, 델타) + overrides(구조 불변 동작 델타). 보통 PR/SHA 마다 하나.
// version 은 자유 문자열(예: "pr-123-sha-abc") — 레지스트리가 비-semver 를 등록순으로 처리한다.
export const HarnessInstanceSpecSchema = z.object({
  template: z.object({ id: z.string(), version: z.string() }),
  id: z.string(), // resolved 하네스 id (관례상 template.id 와 동일)
  version: z.string(), // 인스턴스 태그
  pins: z.record(z.string()).default({}), // slot → 값(이미지 ref; command 는 "image"/"model")
  overrides: InstanceOverridesSchema.optional(), // 구조 불변 동작 변주(env/본문/params) — 미설정 = 이미지만(현행)
});
export type HarnessInstanceSpec = z.infer<typeof HarnessInstanceSpecSchema>;

// Template(구조) + Instance(pins) → resolved HarnessSpec. 슬롯 누락/불일치는 BadRequestError.
export function resolveHarnessInstance(template: HarnessTemplateSpec, instance: HarnessInstanceSpec): HarnessSpec {
  if (template.id !== instance.template.id || template.version !== instance.template.version) {
    throw new BadRequestError(
      "BAD_REQUEST",
      {
        template: `${template.id}@${template.version}`,
        instanceTemplate: `${instance.template.id}@${instance.template.version}`,
      },
      "인스턴스의 template 참조가 주어진 템플릿과 일치하지 않습니다.",
    );
  }
  const pins = instance.pins;
  const overrides = instance.overrides;
  switch (template.kind) {
    case "service": {
      // overrides.services 의 대상 서비스는 반드시 템플릿에 존재해야 한다(이미지 핀과 같은 규율).
      const serviceNames = new Set(template.services.map((s) => s.name));
      for (const name of Object.keys(overrides?.services ?? {})) {
        if (!serviceNames.has(name)) {
          throw new BadRequestError(
            "BAD_REQUEST",
            { service: name, known: [...serviceNames] },
            `overrides 대상 서비스 '${name}' 가 템플릿에 없습니다.`,
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
            `서비스 '${s.name}' 의 slot '${slot}' 에 대한 pin(이미지)이 없습니다.`,
          );
        }
        const ov = overrides?.services?.[s.name];
        // env 는 병합(인스턴스가 이김; 런타임은 connEnv < 이 env < storeEnv). 나머지 노브는 scalar 치환(있으면 인스턴스, 없으면 템플릿).
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
      // front-door: submit 본문 값(shallow-merge) + 완료 타이밍(completion 위에 spread; 모드 불일치 키는 재파싱이 제거).
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
      // 타깃 익스텐션 ref 핀(Phase 3) — 템플릿에 target 이 있어야 한다(없으면 명확히 실패).
      let target = template.target;
      if (overrides?.target) {
        if (!target) {
          throw new BadRequestError(
            "BAD_REQUEST",
            {},
            "overrides.target 가 있으나 템플릿에 target(browser)이 없습니다.",
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
      // env/params 오버레이: 템플릿 위에 병합(인스턴스가 이김). params 는 command 의 {{var}} 를 채운다.
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
      });
    }
    case "process":
      return ProcessHarnessSpecSchema.parse({ kind: "process", id: instance.id, version: instance.version });
  }
}
