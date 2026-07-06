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
  env: EnvRow[] // 정적 env(비-스토어 설정) — 리터럴 또는 시크릿 참조
  volumes: string // docker -v 마운트, 줄바꿈 구분("vol:/data" · "/host:/c:ro")
  readinessTimeout: string // readiness 폴링 상한(ms) — 비우면 미설정
  readinessInterval: string // readiness 폴링 간격(ms)
}
export interface DepRow {
  store: string
  role: string
  isolateBy: string // …/schema | external(BYO 외부 스토어 — Assay 미배포, 연결은 배포 시 env)
  service: string // 이 스토어를 쓰는 서비스(선택; 비우면 토폴로지 공용)
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
  envRows: EnvRow[] // command env — 리터럴 또는 시크릿 참조
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

// env 한 줄 — 이름(key) + [리터럴 값 | 시크릿 이름 참조]. secret=true 면 스펙에 {secretRef,scope} 로 나가
// 평문이 레지스트리에 남지 않는다(값은 실행 직전 컨트롤플레인이 SecretStore 에서 주입).
// scope: "workspace"(공유) | "user"(내 개인) — secret=true 일 때만 의미. user 참조 하니스는 그 개인만 볼 수 있다.
export type SecretRefScope = 'user' | 'workspace'
export interface EnvRow {
  key: string
  secret: boolean
  value: string // secret=false → 리터럴 값 · secret=true → 시크릿 이름
  scope?: SecretRefScope // secret=true 일 때 참조 티어(미지정=workspace)
}
export type EnvValue = string | { secretRef: string; scope?: SecretRefScope }

// env 행들 → 스펙 env 맵(빈 key 제외). 리터럴=문자열, 시크릿=참조 객체(+scope; workspace 는 기본이라 생략).
export function envRowsToSpec(rows: EnvRow[]): Record<string, EnvValue> {
  const out: Record<string, EnvValue> = {}
  for (const r of rows) {
    const k = r.key.trim()
    if (!k) continue
    out[k] = r.secret
      ? { secretRef: r.value.trim(), ...(r.scope === 'user' ? { scope: 'user' as const } : {}) }
      : r.value
  }
  return out
}

// 스펙 env 맵 → env 행들(프리필 역변환). {secretRef} 는 시크릿 행(+scope), 그 외 문자열은 리터럴 행.
export function envRowsFromSpec(env: unknown): EnvRow[] {
  if (typeof env !== 'object' || env === null || Array.isArray(env)) return []
  return Object.entries(env as Record<string, unknown>).map(([key, v]) => {
    if (
      typeof v === 'object' &&
      v !== null &&
      !Array.isArray(v) &&
      typeof (v as { secretRef?: unknown }).secretRef === 'string'
    ) {
      const ref = v as { secretRef: string; scope?: unknown }
      return {
        key,
        secret: true,
        value: ref.secretRef,
        scope: ref.scope === 'user' ? ('user' as const) : ('workspace' as const),
      }
    }
    return {
      key,
      secret: false,
      value: typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '',
    }
  })
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
      env: envRowsToSpec(s.envRows),
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
    services: s.services.map((sv) => {
      const env = envRowsToSpec(sv.env)
      const volumes = lines(sv.volumes)
      const hasReadiness = sv.readinessTimeout.trim() !== '' || sv.readinessInterval.trim() !== ''
      return {
        name: sv.name,
        ...(sv.slot.trim() ? { slot: sv.slot } : {}), // 비우면 컨트롤플레인이 name 을 슬롯으로
        ...(sv.port.trim() ? { port: Number(sv.port) } : {}),
        needs: csv(sv.needs),
        perRun: csv(sv.perRun),
        replicas: sv.replicas.trim() ? Number(sv.replicas) : 1,
        ...(Object.keys(env).length ? { env } : {}),
        ...(volumes.length ? { volumes } : {}),
        ...(hasReadiness
          ? {
              readiness: {
                timeoutMs: Number(sv.readinessTimeout.trim() || 60000),
                intervalMs: Number(sv.readinessInterval.trim() || 1000),
              },
            }
          : {}),
      }
    }),
    dependencies: s.deps.map((d) => ({
      store: d.store,
      role: d.role,
      isolateBy: d.isolateBy,
      ...(d.service.trim() ? { service: d.service.trim() } : {}),
    })),
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
      env: envRowsFromSpec(s.env),
      volumes: (s.volumes ?? []).join('\n'),
      readinessTimeout: s.readiness?.timeoutMs !== undefined ? String(s.readiness.timeoutMs) : '',
      readinessInterval:
        s.readiness?.intervalMs !== undefined ? String(s.readiness.intervalMs) : '',
    })),
    deps: (t.dependencies ?? []).map((d) => ({
      store: d.store,
      role: d.role,
      isolateBy: d.isolateBy,
      service: d.service ?? '',
    })),
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
    envRows: envRowsFromSpec(env),
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

// 서비스별 변주 행(overrides.services[name]) — 구조(템플릿)는 그대로, 동작 노브만 델타.
export interface ServiceOverrideRow {
  service: string // 대상 서비스명(템플릿에 존재해야 함)
  env: EnvRow[] // 서비스 env 오버레이 — 리터럴 또는 시크릿 참조
  replicas: string // 숫자 또는 빈값
  cpu: string // resources.cpu (millicores, 1000=1코어)
  memoryMb: string // resources.memoryMb
  volumes: string // 줄바꿈("vol:/data" · "/host:/c:ro")
  readinessTimeout: string // ms
  readinessInterval: string // ms
}

export interface InstanceState {
  templateId: string
  templateVersion: string
  version: string // 인스턴스 태그(예: pr-123-sha-abc)
  description: string // 이 버전의 변경 내역(자유 텍스트) — 배포 시 입력, 상세에 표시
  pins: PinRow[]
  // 변주(overrides) — 구조 불변 동작 델타(구조적 편집). 컨트롤플레인이 스키마를 최종 검증.
  serviceOverrides: ServiceOverrideRow[] // service 템플릿: 서비스별 env/replicas/resources/volumes/readiness
  bodyTemplate: string // service: front-door submit 본문 값(JSON 객체; 자유 형식)
  completionTimeout: string // service: front-door 완료 timeoutMs
  completionInterval: string // service: front-door 완료(poll) intervalMs
  targetExtensionRef: string // service: 브라우저 타깃 익스텐션 ref 핀
  cmdEnvRows: EnvRow[] // command: env 오버레이 — 리터럴 또는 시크릿 참조
  cmdParams: string // command: {{var}} 값(KEY=VALUE 줄바꿈)
}

const EMPTY_SERVICE_OVERRIDE: ServiceOverrideRow = {
  service: '',
  env: [],
  replicas: '',
  cpu: '',
  memoryMb: '',
  volumes: '',
  readinessTimeout: '',
  readinessInterval: '',
}

// JSON 객체 텍스트 파싱(front-door 본문용) — 빈값=미설정(ok). 객체 아님/JSON 오류면 error(폼이 등록 차단).
export function parseJsonObject(
  text: string
): { ok: true; value?: Record<string, unknown> } | { ok: false; error: string } {
  const t = text.trim()
  if (!t) return { ok: true }
  let parsed: unknown
  try {
    parsed = JSON.parse(t)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '유효한 JSON 이 아닙니다.' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'JSON 객체여야 합니다.' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

// 구조적 변주 폼 상태 → overrides 객체(빈 노브는 생략). bodyTemplate 파싱 오류는 폼이 차단(여기선 무시).
export function buildOverrides(s: InstanceState): Record<string, unknown> | undefined {
  const overrides: Record<string, unknown> = {}
  // 서비스별 변주
  const services: Record<string, unknown> = {}
  for (const r of s.serviceOverrides) {
    const name = r.service.trim()
    if (!name) continue
    const o: Record<string, unknown> = {}
    const env = envRowsToSpec(r.env)
    if (Object.keys(env).length) o.env = env
    if (r.replicas.trim()) o.replicas = Number(r.replicas)
    const resources: Record<string, number> = {}
    if (r.cpu.trim()) resources.cpu = Number(r.cpu)
    if (r.memoryMb.trim()) resources.memoryMb = Number(r.memoryMb)
    if (Object.keys(resources).length) o.resources = resources
    const vols = lines(r.volumes)
    if (vols.length) o.volumes = vols
    if (r.readinessTimeout.trim() || r.readinessInterval.trim()) {
      o.readiness = {
        timeoutMs: Number(r.readinessTimeout.trim() || 60000),
        intervalMs: Number(r.readinessInterval.trim() || 1000),
      }
    }
    if (Object.keys(o).length) services[name] = o
  }
  if (Object.keys(services).length) overrides.services = services
  // front-door: 본문 값 + 완료 타이밍
  const frontDoor: Record<string, unknown> = {}
  const body = parseJsonObject(s.bodyTemplate)
  if (body.ok && body.value) frontDoor.request = { bodyTemplate: body.value }
  const completion: Record<string, number> = {}
  if (s.completionTimeout.trim()) completion.timeoutMs = Number(s.completionTimeout)
  if (s.completionInterval.trim()) completion.intervalMs = Number(s.completionInterval)
  if (Object.keys(completion).length) frontDoor.completion = completion
  if (Object.keys(frontDoor).length) overrides.frontDoor = frontDoor
  // target 익스텐션 ref
  if (s.targetExtensionRef.trim())
    overrides.target = { extension: { ref: s.targetExtensionRef.trim() } }
  // command env/params
  const cmdEnv = envRowsToSpec(s.cmdEnvRows)
  if (Object.keys(cmdEnv).length) overrides.env = cmdEnv
  const cmdParams = kvLines(s.cmdParams)
  if (Object.keys(cmdParams).length) overrides.params = cmdParams
  return Object.keys(overrides).length ? overrides : undefined
}

// 인스턴스 스펙 조립(template 참조 + pins + overrides). overrides 는 비어있지 않을 때만 포함.
export function buildInstance(s: InstanceState): Record<string, unknown> {
  const pins: Record<string, string> = {}
  for (const p of s.pins) if (p.slot.trim() && p.value.trim()) pins[p.slot.trim()] = p.value.trim()
  const overrides = buildOverrides(s)
  return {
    template: { id: s.templateId, version: s.templateVersion },
    id: s.templateId, // 인스턴스 id = 템플릿 id(관례)
    version: s.version,
    ...(s.description.trim() ? { description: s.description.trim() } : {}),
    pins,
    ...(overrides ? { overrides } : {}),
  }
}

export const INITIAL_TEMPLATE: TemplateState = {
  kind: 'command',
  category: 'cli-agent',
  id: '',
  version: '1.0.0',
  services: [
    {
      name: 'agent-server',
      slot: 'agent-server',
      port: '8080',
      needs: '',
      perRun: '',
      replicas: '1',
      env: [],
      volumes: '',
      readinessTimeout: '',
      readinessInterval: '',
    },
  ],
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
  envRows: [],
  cmdTraceKind: 'none',
  cmdTraceEndpoint: '',
}

export const INITIAL_INSTANCE: InstanceState = {
  templateId: '',
  templateVersion: '1.0.0',
  version: '',
  description: '',
  pins: [{ slot: 'image', value: '' }],
  serviceOverrides: [],
  bodyTemplate: '',
  completionTimeout: '',
  completionInterval: '',
  targetExtensionRef: '',
  cmdEnvRows: [],
  cmdParams: '',
}

// raw 인스턴스 스펙 → 인스턴스 폼 상태(새 버전 편집 프리필). version 은 빈 값으로 둬 새 태그를 강제한다
// (같은 태그 재등록은 불변성 위반 409). slots 가 주어지면 그 슬롯 전부를 행으로 펼쳐(누락 없이) 기존 값을 병합한다.
// overrides(느슨 JSON) 안전 추출 헬퍼 — 폼은 문자열 기반이라 숫자/맵을 문자열/줄바꿈으로 환원한다.
const asObj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
const asStr = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
const numStr = (v: unknown): string => (typeof v === 'number' ? String(v) : '')
const kvToLines = (v: unknown): string => {
  const o = asObj(v)
  return o
    ? Object.entries(o)
        .map(([k, val]) => `${k}=${asStr(val)}`)
        .join('\n')
    : ''
}

// 기존 overrides → 구조적 폼 상태(새 버전 편집 프리필의 출발점). buildOverrides 의 역변환.
function serviceOverridesFromSpec(ov: Record<string, unknown>): ServiceOverrideRow[] {
  const services = asObj(ov.services)
  if (!services) return []
  return Object.entries(services).map(([service, raw]) => {
    const o = asObj(raw) ?? {}
    const res = asObj(o.resources) ?? {}
    const rd = asObj(o.readiness) ?? {}
    return {
      service,
      env: envRowsFromSpec(o.env),
      replicas: numStr(o.replicas),
      cpu: numStr(res.cpu),
      memoryMb: numStr(res.memoryMb),
      volumes: Array.isArray(o.volumes) ? o.volumes.map(asStr).filter(Boolean).join('\n') : '',
      readinessTimeout: numStr(rd.timeoutMs),
      readinessInterval: numStr(rd.intervalMs),
    }
  })
}

export function instanceStateFromSpec(
  inst: {
    template: { id: string; version: string }
    id: string
    version: string
    pins: Record<string, string>
    overrides?: Record<string, unknown>
  },
  slots?: string[]
): InstanceState {
  const rows: PinRow[] =
    slots && slots.length > 0
      ? slots.map((slot) => ({ slot, value: inst.pins[slot] ?? '' }))
      : Object.entries(inst.pins).map(([slot, value]) => ({ slot, value }))
  const ov = inst.overrides ?? {}
  const fd = asObj(ov.frontDoor)
  const body = asObj(asObj(fd?.request)?.bodyTemplate)
  const completion = asObj(fd?.completion)
  const ext = asObj(asObj(ov.target)?.extension)
  return {
    templateId: inst.template.id,
    templateVersion: inst.template.version,
    version: '',
    description: '', // 새 버전은 새 변경 내역 — 이전 버전 설명을 물려받지 않는다(버전 태그와 동일 정신)
    pins: rows.length > 0 ? rows : [{ slot: '', value: '' }],
    serviceOverrides: serviceOverridesFromSpec(ov),
    bodyTemplate: body ? JSON.stringify(body, null, 2) : '',
    completionTimeout: numStr(completion?.timeoutMs),
    completionInterval: numStr(completion?.intervalMs),
    targetExtensionRef: asStr(ext?.ref),
    cmdEnvRows: envRowsFromSpec(ov.env),
    cmdParams: kvToLines(ov.params),
  }
}

export { EMPTY_SERVICE_OVERRIDE }
