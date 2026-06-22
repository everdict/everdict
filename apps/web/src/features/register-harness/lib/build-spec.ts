// 마법사 폼 상태 → HarnessSpec 객체 조립(순수). 컨트롤플레인이 스키마/충돌을 최종 검증한다.
export type Kind = 'process' | 'service'

export interface ServiceRow {
  name: string
  image: string
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
export interface WizardState {
  kind: Kind
  id: string
  version: string
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
}

const csv = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

export function buildSpec(s: WizardState): Record<string, unknown> {
  if (s.kind === 'process') return { kind: 'process', id: s.id, version: s.version }

  const spec: Record<string, unknown> = {
    kind: 'service',
    id: s.id,
    version: s.version,
    services: s.services.map((sv) => ({
      name: sv.name,
      image: sv.image,
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

export const INITIAL: WizardState = {
  kind: 'service',
  id: '',
  version: '',
  services: [
    { name: 'agent-server', image: '', port: '8080', needs: '', perRun: '', replicas: '1' },
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
}
