import { z } from "zod";
import { BadRequestError } from "./errors.js";
import {
  CommandHarnessSpecSchema,
  CommandTraceSpecSchema,
  type HarnessSpec,
  ProcessHarnessSpecSchema,
  ServiceHarnessSpecSchema,
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
  frontDoor: z.object({ service: z.string(), submit: z.string(), trace: z.string().optional() }),
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
  env: z.record(z.string()).default({}),
  model: z.string().optional(), // pins.model 없을 때의 기본
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

// 개별 하네스(인스턴스) — template 참조 + pins(슬롯→값, 델타만). 보통 PR/SHA 마다 하나.
// version 은 자유 문자열(예: "pr-123-sha-abc") — 레지스트리가 비-semver 를 등록순으로 처리한다.
export const HarnessInstanceSpecSchema = z.object({
  template: z.object({ id: z.string(), version: z.string() }),
  id: z.string(), // resolved 하네스 id (관례상 template.id 와 동일)
  version: z.string(), // 인스턴스 태그
  pins: z.record(z.string()).default({}), // slot → 값(이미지 ref; command 는 "image"/"model")
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
  switch (template.kind) {
    case "service": {
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
        return {
          name: s.name,
          image,
          needs: s.needs,
          perRun: s.perRun,
          replicas: s.replicas,
          ...(s.port !== undefined ? { port: s.port } : {}),
        };
      });
      return ServiceHarnessSpecSchema.parse({
        kind: "service",
        id: instance.id,
        version: instance.version,
        services,
        dependencies: template.dependencies,
        frontDoor: template.frontDoor,
        traceSource: template.traceSource,
        ...(template.target ? { target: template.target } : {}),
      });
    }
    case "command": {
      const image = pins.image ?? template.image;
      const model = pins.model ?? template.model;
      return CommandHarnessSpecSchema.parse({
        kind: "command",
        id: instance.id,
        version: instance.version,
        setup: template.setup,
        command: template.command,
        env: template.env,
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
