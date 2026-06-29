// 마법사 폼 상태 → HarnessTemplateSpec / HarnessInstanceSpec 조립(순수). 컨트롤플레인이 스키마/충돌을 최종 검증한다.
// 대분류(Template) = 구조/슬롯(버전 미고정), Instance = template 참조 + pins(슬롯→이미지/값).
import type { HarnessTemplateSpec } from '@/entities/harness'

export type Kind = 'process' | 'service' | 'command'

export interface ServiceRow {
  name: string
  slot: string // 인스턴스가 핀하는 슬롯 이름(비우면 name)
  port: string
  needs: string // 콤마 구분
  perRun: string // 콤마 구분
  replicas: string
}
export interface DepRow {
  store: string
  role: string
  isolateBy: string
}

// 템플릿(대분류) 폼 상태.
export interface TemplateState {
  kind: Kind
  category: string
  id: string
  version: string // 구조(shape) 버전
  // service(토폴로지)
  services: ServiceRow[]
  deps: DepRow[]
  frontDoorService: string
  frontDoorSubmit: string
  frontDoorTrace: string
  traceKind: string
  traceEndpoint: string
  targetEnabled: boolean
  targetLifecycle: string
  targetObserve: string[]
  targetExtensionRef: string
  // command(선언형 CLI)
  image: string
  workDir: string
  setup: string // 줄바꿈 구분
  command: string
  model: string
  envText: string // KEY=VALUE 줄바꿈 구분
  cmdTraceKind: string // none | otel | mlflow
  cmdTraceEndpoint: string
}

const csv = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
const lines = (s: string): string[] =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
const kvLines = (s: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const ln of lines(s)) {
    const i = ln.indexOf('=')
    if (i > 0) out[ln.slice(0, i).trim()] = ln.slice(i + 1).trim()
  }
  return out
}

// 템플릿(대분류) 스펙 조립.
export function buildTemplate(s: TemplateState): Record<string, unknown> {
  const base = { category: s.category || 'custom', id: s.id, version: s.version }
  if (s.kind === 'process') return { kind: 'process', ...base }
  if (s.kind === 'command') {
    return {
      kind: 'command',
      ...base,
      ...(s.image.trim() ? { image: s.image } : {}),
      ...(s.workDir.trim() ? { workDir: s.workDir } : {}),
      setup: lines(s.setup),
      command: s.command,
      env: kvLines(s.envText),
      ...(s.model.trim() ? { model: s.model } : {}),
      trace:
        s.cmdTraceKind === 'none' || !s.cmdTraceKind
          ? { kind: 'none' }
          : { kind: s.cmdTraceKind, endpoint: s.cmdTraceEndpoint },
    }
  }
  const spec: Record<string, unknown> = {
    kind: 'service',
    ...base,
    services: s.services.map((sv) => ({
      name: sv.name,
      ...(sv.slot.trim() ? { slot: sv.slot } : {}), // 비우면 컨트롤플레인이 name 을 슬롯으로
      ...(sv.port.trim() ? { port: Number(sv.port) } : {}),
      needs: csv(sv.needs),
      perRun: csv(sv.perRun),
      replicas: sv.replicas.trim() ? Number(sv.replicas) : 1,
    })),
    dependencies: s.deps.map((d) => ({ store: d.store, role: d.role, isolateBy: d.isolateBy })),
    frontDoor: {
      service: s.frontDoorService,
      submit: s.frontDoorSubmit,
      ...(s.frontDoorTrace.trim() ? { trace: s.frontDoorTrace } : {}),
    },
    traceSource: { kind: s.traceKind, endpoint: s.traceEndpoint },
  }
  if (s.targetEnabled) {
    spec.target = {
      kind: 'browser',
      engine: 'chromium',
      lifecycle: s.targetLifecycle,
      observe: s.targetObserve,
      ...(s.targetExtensionRef.trim() ? { extension: { ref: s.targetExtensionRef } } : {}),
    }
  }
  return spec
}

// 템플릿 스펙 → 템플릿 폼 상태(구조 새 버전 편집 프리필). buildTemplate 의 역변환.
// 폼 필드는 문자열/배열 기반이라 미설정은 빈 문자열로 둔다(도메인 값이 아닌 UI 상태).
export function templateStateFromSpec(t: HarnessTemplateSpec): TemplateState {
  const env = t.env ?? {}
  return {
    kind: t.kind,
    category: t.category,
    id: t.id,
    version: t.version,
    services: (t.services ?? []).map((s) => ({
      name: s.name,
      slot: s.slot ?? '',
      port: s.port !== undefined ? String(s.port) : '',
      needs: (s.needs ?? []).join(', '),
      perRun: (s.perRun ?? []).join(', '),
      replicas: s.replicas !== undefined ? String(s.replicas) : '1',
    })),
    deps: (t.dependencies ?? []).map((d) => ({ store: d.store, role: d.role, isolateBy: d.isolateBy })),
    frontDoorService: t.frontDoor?.service ?? '',
    frontDoorSubmit: t.frontDoor?.submit ?? '',
    frontDoorTrace: t.frontDoor?.trace ?? '',
    traceKind: t.traceSource?.kind ?? 'mlflow',
    traceEndpoint: t.traceSource?.endpoint ?? '',
    targetEnabled: t.target !== undefined,
    targetLifecycle: t.target?.lifecycle ?? 'per-case-instance',
    targetObserve: t.target?.observe ?? ['dom', 'screenshot', 'url'],
    targetExtensionRef: t.target?.extension?.ref ?? '',
    image: t.image ?? '',
    workDir: t.workDir ?? '',
    setup: (t.setup ?? []).join('\n'),
    command: t.command ?? '',
    model: t.model ?? '',
    envText: Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    cmdTraceKind: t.trace?.kind ?? 'none',
    cmdTraceEndpoint: t.trace?.endpoint ?? '',
  }
}

// 슬롯 이름들(인스턴스 폼이 pins 입력을 그려줄 때 참조). service=서비스 슬롯, command=image/model.
export function templateSlots(s: TemplateState): string[] {
  if (s.kind === 'service') return s.services.map((sv) => sv.slot.trim() || sv.name).filter(Boolean)
  if (s.kind === 'command') return ['image', 'model']
  return []
}

export interface PinRow {
  slot: string
  value: string
}
export interface InstanceState {
  templateId: string
  templateVersion: string
  version: string // 인스턴스 태그(예: pr-123-sha-abc)
  pins: PinRow[]
}

// 인스턴스 스펙 조립(template 참조 + pins).
export function buildInstance(s: InstanceState): Record<string, unknown> {
  const pins: Record<string, string> = {}
  for (const p of s.pins) if (p.slot.trim() && p.value.trim()) pins[p.slot.trim()] = p.value.trim()
  return {
    template: { id: s.templateId, version: s.templateVersion },
    id: s.templateId, // 인스턴스 id = 템플릿 id(관례)
    version: s.version,
    pins,
  }
}

export const INITIAL_TEMPLATE: TemplateState = {
  kind: 'service',
  category: 'topology',
  id: '',
  version: '1',
  services: [{ name: 'agent-server', slot: 'agent-server', port: '8080', needs: '', perRun: '', replicas: '1' }],
  deps: [],
  frontDoorService: 'agent-server',
  frontDoorSubmit: 'POST /runs',
  frontDoorTrace: '',
  traceKind: 'mlflow',
  traceEndpoint: '',
  targetEnabled: false,
  targetLifecycle: 'per-case-instance',
  targetObserve: ['dom', 'screenshot', 'url'],
  targetExtensionRef: '',
  image: '',
  workDir: '',
  setup: '',
  command: '',
  model: '',
  envText: '',
  cmdTraceKind: 'none',
  cmdTraceEndpoint: '',
}

export const INITIAL_INSTANCE: InstanceState = {
  templateId: '',
  templateVersion: '1',
  version: '',
  pins: [{ slot: 'agent-server', value: '' }],
}

// raw 인스턴스 스펙 → 인스턴스 폼 상태(새 버전 편집 프리필). version 은 빈 값으로 둬 새 태그를 강제한다
// (같은 태그 재등록은 불변성 위반 409). slots 가 주어지면 그 슬롯 전부를 행으로 펼쳐(누락 없이) 기존 값을 병합한다.
export function instanceStateFromSpec(
  inst: { template: { id: string; version: string }; id: string; version: string; pins: Record<string, string> },
  slots?: string[],
): InstanceState {
  const rows: PinRow[] =
    slots && slots.length > 0
      ? slots.map((slot) => ({ slot, value: inst.pins[slot] ?? '' }))
      : Object.entries(inst.pins).map(([slot, value]) => ({ slot, value }))
  return {
    templateId: inst.template.id,
    templateVersion: inst.template.version,
    version: '',
    pins: rows.length > 0 ? rows : [{ slot: '', value: '' }],
  }
}
