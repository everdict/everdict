'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ChevronDown, Plus, SlidersHorizontal, Trash2 } from 'lucide-react'

import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox, type ComboboxOption } from '@/shared/ui/combobox'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'
import { VersionField } from '@/shared/ui/version-field'

import {
  registerHarnessAction,
  registerHarnessTemplateAction,
  validateHarnessAction,
  validateHarnessTemplateAction,
  type RegisterHarnessResult,
  type ValidateHarnessResult,
} from '../api/register-harness'
import {
  buildInstance,
  buildTemplate,
  EMPTY_SERVICE_OVERRIDE,
  INITIAL_INSTANCE,
  INITIAL_TEMPLATE,
  parseJsonObject,
  type DepRow,
  type InstanceState,
  type Kind,
  type PinRow,
  type ServiceOverrideRow,
  type ServiceRow,
  type TemplateState,
} from '../lib/build-spec'
import { EnvEditor, type ScopedSecretNames } from './env-editor'

const EMPTY_SECRETS: ScopedSecretNames = { workspace: [], user: [] }

// front-door submit 본문 값 오버라이드 편집기의 안내 예시(자유 형식 JSON 객체).
const BODY_PLACEHOLDER = `{ "max_steps": 30, "system_prompt": "..." }`

const STORE_OPTIONS: ComboboxOption[] = [
  { value: 'postgres', description: '관계형 DB' },
  { value: 'redis', description: '인메모리 캐시·큐' },
  { value: 'minio', description: 'S3 호환 오브젝트 스토어' },
]
const ISOLATE_OPTIONS: ComboboxOption[] = [
  { value: 'thread_id', description: '케이스별 thread_id 로 논리 격리' },
  { value: 'key-prefix', description: '케이스별 키 접두사로 격리' },
  { value: 'object-prefix', description: '케이스별 오브젝트 경로 접두사로 격리' },
  { value: 'schema', description: '케이스별 DB 스키마로 격리' },
  { value: 'external', description: '외부·공유 스토어 — Assay 미배포, 연결만 넘김' },
]

// kind = 하니스를 실제로 어떻게 실행하는지(런타임 방식). process 는 코드로 정의하는 하니스라
// 폼(선언형)으로는 빈 껍데기만 나와 여기선 제외한다 — command / service 둘만 노출.
const KIND_OPTIONS: ComboboxOption[] = [
  {
    value: 'command',
    label: 'command · 명령형 CLI',
    description: 'aider·codex 같은 CLI 에이전트를 명령 한 줄로 정의해요. 대부분 여기서 시작해요.',
  },
  {
    value: 'service',
    label: 'service · 서비스 토폴로지',
    description:
      '에이전트 서버 + DB 같은 여러 컨테이너를 띄우고 front-door 로 케이스를 보내요. 고급.',
  },
]

// category = 목록에서 묶어보기 위한 분류 라벨(실행 방식은 kind 가 정함 — category 는 실행에 영향 없음).
// kind 별로 흔한 것만 노출해 선택을 좁힌다.
const CATEGORY_OPTIONS: Record<'command' | 'service', ComboboxOption[]> = {
  command: [
    { value: 'cli-agent', label: 'cli-agent', description: '일반 CLI 에이전트 (aider 등)' },
    { value: 'claude-code', label: 'claude-code', description: 'Claude Code 하니스' },
    { value: 'codex', label: 'codex', description: 'OpenAI Codex CLI 하니스' },
    { value: 'desktop', label: 'desktop', description: '데스크탑/OS 조작 에이전트' },
    { value: 'custom', label: 'custom', description: '기타 — 분류만' },
  ],
  service: [
    { value: 'topology', label: 'topology', description: '멀티 서비스 토폴로지' },
    { value: 'custom', label: 'custom', description: '기타 — 분류만' },
  ],
}
const categoriesForKind = (k: Kind): ComboboxOption[] =>
  k === 'service' ? CATEGORY_OPTIONS.service : CATEGORY_OPTIONS.command

// 라벨 + info 툴팁(안내는 인라인 금지 — info 아이콘에만). 등록 폼 전반에서 필드 설명에 사용.
function FieldLabel({
  children,
  tip,
  htmlFor,
}: {
  children: React.ReactNode
  tip?: React.ReactNode
  htmlFor?: string
}) {
  return (
    <span className="flex items-center gap-1">
      <Label {...(htmlFor ? { htmlFor } : {})}>{children}</Label>
      {tip != null && <InfoTip content={tip} />}
    </span>
  )
}

// 버전 입력 — existing 이 주어지면 semver 범프 드롭다운(신규=1.0.0), 없으면 raw 입력(참조용 태그 등).
function VersionRow({
  existing,
  value,
  onChange,
  rawLabel,
  rawId,
  placeholder,
}: {
  existing?: string[]
  value: string
  onChange: (v: string) => void
  rawLabel: React.ReactNode
  rawId: string
  placeholder: string
}) {
  if (existing) return <VersionField existing={existing} value={value} onChange={onChange} />
  return (
    <div className="space-y-1.5">
      <Label htmlFor={rawId}>{rawLabel}</Label>
      <Input
        id={rawId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  )
}

type Tab = 'template' | 'instance'

export function RegisterHarnessWizard({
  secrets = EMPTY_SECRETS,
}: {
  secrets?: ScopedSecretNames
}) {
  const { workspace } = useParams<{ workspace: string }>()
  const [tab, setTab] = useState<Tab>('template')

  return (
    <div className="max-w-2xl space-y-5">
      <div className="inline-flex rounded-md border border-border bg-secondary/50 p-0.5 text-[13px]">
        <TabBtn active={tab === 'template'} onClick={() => setTab('template')}>
          템플릿 (대분류)
        </TabBtn>
        <TabBtn active={tab === 'instance'} onClick={() => setTab('instance')}>
          인스턴스 (템플릿 + 핀)
        </TabBtn>
      </div>
      <p className="text-[12px] text-muted-foreground">
        {tab === 'template'
          ? '템플릿은 구조와 슬롯을 정해요. 여기에 버전을 핀하면 인스턴스가 돼요.'
          : '인스턴스는 템플릿의 슬롯마다 이미지·버전을 핀한 하나의 하니스예요. 보통 PR마다 하나씩 만들어요.'}
      </p>
      {tab === 'template' ? (
        <TemplateForm workspace={workspace} existingVersions={[]} secrets={secrets} />
      ) : (
        <InstanceForm workspace={workspace} existingVersions={[]} secrets={secrets} />
      )}
    </div>
  )
}

// --- 템플릿(대분류) 등록 ---
// initial 프리필 + lockId(같은 대분류의 새 구조 버전 — id/kind 고정) + onRegistered(성공 시 호출자가 후처리,
// 예: 새 버전을 참조하는 인스턴스 탭으로 이동). onRegistered 없으면 기본은 하니스 목록으로 이동.
export function TemplateForm({
  workspace,
  initial,
  lockId = false,
  onRegistered,
  existingVersions,
  secrets = EMPTY_SECRETS,
}: {
  workspace: string
  initial?: TemplateState
  lockId?: boolean
  onRegistered?: (version: string) => void
  existingVersions?: string[]
  secrets?: ScopedSecretNames
}) {
  const router = useRouter()
  const [s, setS] = useState<TemplateState>(initial ?? INITIAL_TEMPLATE)
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [jsonText, setJsonText] = useState('')
  const [result, setResult] = useState<ValidateHarnessResult>()
  const [regError, setRegError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const set = (patch: Partial<TemplateState>) => setS((prev) => ({ ...prev, ...patch }))
  const setService = (i: number, patch: Partial<ServiceRow>) =>
    set({ services: s.services.map((row, j) => (j === i ? { ...row, ...patch } : row)) })
  const setDep = (i: number, patch: Partial<DepRow>) =>
    set({ deps: s.deps.map((row, j) => (j === i ? { ...row, ...patch } : row)) })

  const spec = (): unknown => (mode === 'json' ? JSON.parse(jsonText) : buildTemplate(s))

  async function onValidate() {
    setBusy(true)
    setRegError(undefined)
    try {
      setResult(await validateHarnessTemplateAction(spec()))
    } catch {
      setResult({ ok: false, error: 'JSON 파싱 실패' })
    }
    setBusy(false)
  }
  async function onRegister() {
    setBusy(true)
    setRegError(undefined)
    let res: RegisterHarnessResult
    try {
      res = await registerHarnessTemplateAction(spec())
    } catch {
      setBusy(false)
      setRegError('JSON 파싱 실패')
      return
    }
    setBusy(false)
    if (res.ok) {
      if (onRegistered) onRegistered(res.version ?? s.version)
      else router.push(`/${workspace}/harnesses`)
    } else setRegError(res.error ?? '등록 실패')
  }

  return (
    <div className="space-y-5">
      <ModeToggle
        mode={mode}
        setForm={() => setMode('form')}
        setJson={() => {
          setJsonText(JSON.stringify(buildTemplate(s), null, 2))
          setMode('json')
        }}
      />

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <FieldLabel
            tip={
              <>
                하니스를 <b>어떻게 실행</b>하는지예요.
                <br />
                <b>command</b> — CLI 한 줄로 정의(대부분 여기).
                <br />
                <b>service</b> — 여러 컨테이너를 띄우는 토폴로지(고급).
              </>
            }
          >
            kind
          </FieldLabel>
          <Combobox
            value={s.kind}
            onChange={(v) =>
              set({
                kind: v as Kind,
                category: categoriesForKind(v as Kind)[0]?.value ?? 'custom',
              })
            }
            disabled={lockId}
            options={KIND_OPTIONS}
            className={cn('w-full', lockId && 'opacity-60')}
            aria-label="kind"
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel tip="목록에서 묶어보기 위한 분류 라벨이에요. 실행 방식은 kind 가 정해요 — category 는 실행에 영향 없어요.">
            category
          </FieldLabel>
          <Combobox
            value={s.category}
            onChange={(v) => set({ category: v })}
            options={categoriesForKind(s.kind)}
            className="w-full"
            aria-label="category"
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="tid" tip="이 하니스(대분류)의 이름이에요. 예: bu, aider, codex.">
            id
          </FieldLabel>
          <Input
            id="tid"
            value={s.id}
            onChange={(e) => set({ id: e.target.value })}
            placeholder="bu"
            readOnly={lockId}
            className={cn(lockId && 'opacity-60')}
          />
        </div>
      </div>
      <VersionRow
        existing={existingVersions}
        value={s.version}
        onChange={(v) => set({ version: v })}
        rawLabel="version (구조가 바뀔 때만 올려요)"
        rawId="tver"
        placeholder="1"
      />

      {mode === 'form' && s.kind === 'service' && (
        <div className="space-y-6">
          <Section
            title="서비스"
            tip={
              <>
                토폴로지를 이루는 컨테이너들이에요. 각 서비스는 <b>슬롯</b>이 되고, 인스턴스가
                거기에 이미지를 핀해요. 최소 하나(보통 에이전트 서버)가 필요해요.
              </>
            }
            onAdd={() =>
              set({
                services: [
                  ...s.services,
                  {
                    name: '',
                    slot: '',
                    port: '',
                    needs: '',
                    perRun: '',
                    replicas: '1',
                    env: [],
                    volumes: '',
                    readinessTimeout: '',
                    readinessInterval: '',
                  },
                ],
              })
            }
          >
            {s.services.map((sv, i) => (
              <div key={i} className="space-y-2.5 rounded-lg border bg-card p-3">
                <div className="grid grid-cols-2 gap-2.5">
                  <LabeledInput
                    label="name"
                    tip="서비스(컨테이너) 이름이에요. 예: agent-server, db."
                    value={sv.name}
                    onChange={(v) => setService(i, { name: v })}
                    placeholder="agent-server"
                  />
                  <LabeledInput
                    label="slot"
                    tip="인스턴스가 이미지를 핀할 때 쓰는 이름이에요. 비우면 name 을 그대로 슬롯으로 써요."
                    value={sv.slot}
                    onChange={(v) => setService(i, { slot: v })}
                    placeholder="비우면 name"
                  />
                  <LabeledInput
                    label="port"
                    tip="이 서비스가 여는 포트예요. 에이전트 서버라면 front-door 가 이 포트로 케이스를 보내요."
                    value={sv.port}
                    onChange={(v) => setService(i, { port: v })}
                    placeholder="8080"
                    inputMode="numeric"
                  />
                  <LabeledInput
                    label="replicas"
                    tip="띄울 복제본 수예요. 보통 1."
                    value={sv.replicas}
                    onChange={(v) => setService(i, { replicas: v })}
                    placeholder="1"
                    inputMode="numeric"
                  />
                  <LabeledInput
                    label="needs"
                    tip="이 서비스보다 먼저 떠 있어야 하는 서비스들이에요(의존 순서). 콤마로 구분해요. 예: db, redis."
                    value={sv.needs}
                    onChange={(v) => setService(i, { needs: v })}
                    placeholder="db, redis"
                  />
                  <LabeledInput
                    label="perRun"
                    tip="케이스마다 런타임이 주입하는 키 이름들이에요(격리용). 콤마 구분. 예: thread_id."
                    value={sv.perRun}
                    onChange={(v) => setService(i, { perRun: v })}
                    placeholder="thread_id"
                  />
                </div>
                <EnvEditor
                  label="env"
                  tip={
                    <>
                      이 서비스에 넣을 환경변수예요. API 키 같은 비밀은 <b>시크릿</b>으로 전환해
                      참조하세요 — 스펙엔 이름만 저장돼요.
                    </>
                  }
                  rows={sv.env}
                  onChange={(env) => setService(i, { env })}
                  secrets={secrets}
                />
                <LabeledTextarea
                  label="volumes"
                  tip="컨테이너에 붙일 볼륨 마운트예요(docker -v). 한 줄에 하나. 예: pgdata:/var/lib/postgresql/data."
                  value={sv.volumes}
                  onChange={(v) => setService(i, { volumes: v })}
                  placeholder="pgdata:/var/lib/postgresql/data"
                />
                <div className="grid grid-cols-2 gap-2.5">
                  <LabeledInput
                    label="readiness timeout (ms)"
                    tip="이 서비스가 준비될 때까지 기다리는 최대 시간이에요(ms). 비우면 런타임 기본값."
                    value={sv.readinessTimeout}
                    onChange={(v) => setService(i, { readinessTimeout: v })}
                    placeholder="60000"
                    inputMode="numeric"
                  />
                  <LabeledInput
                    label="readiness interval (ms)"
                    tip="준비됐는지 확인하는 간격이에요(ms). 비우면 런타임 기본값."
                    value={sv.readinessInterval}
                    onChange={(v) => setService(i, { readinessInterval: v })}
                    placeholder="1000"
                    inputMode="numeric"
                  />
                </div>
                {s.services.length > 1 && (
                  <RemoveBtn
                    onClick={() => set({ services: s.services.filter((_, j) => j !== i) })}
                  />
                )}
              </div>
            ))}
          </Section>
          <Section
            title="의존 스토어"
            tip={
              <>
                서비스들이 공유하는 상태 저장소예요(DB·캐시 등). 케이스마다 <b>논리적으로 격리</b>돼
                섞이지 않아요. 필요 없으면 비워둬요.
              </>
            }
            onAdd={() =>
              set({
                deps: [
                  ...s.deps,
                  { store: 'postgres', role: '', isolateBy: 'thread_id', service: '' },
                ],
              })
            }
          >
            {s.deps.length === 0 && <p className="text-[12px] text-muted-foreground">없음</p>}
            {s.deps.map((d, i) => (
              <div key={i} className="space-y-2.5 rounded-lg border bg-card p-3">
                <div className="grid grid-cols-3 gap-2.5">
                  <div className="space-y-1">
                    <span className="flex items-center gap-1">
                      <span className="text-[11px] font-[510] text-muted-foreground">store</span>
                      <InfoTip content="저장소 종류예요." />
                    </span>
                    <Combobox
                      value={d.store}
                      onChange={(v) => setDep(i, { store: v })}
                      options={STORE_OPTIONS}
                      className="w-full"
                      aria-label="store"
                    />
                  </div>
                  <LabeledInput
                    label="role"
                    tip="이 스토어의 용도 이름이에요(자유). 예: main, cache."
                    value={d.role}
                    onChange={(v) => setDep(i, { role: v })}
                    placeholder="main"
                  />
                  <div className="space-y-1">
                    <span className="flex items-center gap-1">
                      <span className="text-[11px] font-[510] text-muted-foreground">
                        isolateBy
                      </span>
                      <InfoTip content="케이스끼리 데이터가 안 섞이게 격리하는 방식이에요." />
                    </span>
                    <Combobox
                      value={d.isolateBy}
                      onChange={(v) => setDep(i, { isolateBy: v })}
                      options={ISOLATE_OPTIONS}
                      className="w-full"
                      aria-label="isolateBy"
                    />
                  </div>
                </div>
                <LabeledInput
                  label="service (선택)"
                  tip="이 스토어를 쓰는 서비스명이에요. 비우면 토폴로지 전체가 공용으로 써요."
                  value={d.service}
                  onChange={(v) => setDep(i, { service: v })}
                  placeholder="agent-server"
                />
                {d.isolateBy === 'external' && (
                  <p className="text-[11px] text-muted-foreground">
                    external은 Assay 밖에 있는 외부·공유 스토어예요. Assay가 직접 만들지 않고, 연결
                    정보만 env로 넘겨줘요.
                  </p>
                )}
                <RemoveBtn onClick={() => set({ deps: s.deps.filter((_, j) => j !== i) })} />
              </div>
            ))}
          </Section>
          <div className="space-y-3">
            <h3 className="flex items-center gap-1 text-[13px] font-[560]">
              Front door
              <InfoTip
                content={
                  <>
                    평가 드라이버가 <b>케이스를 제출하는 입구</b>예요. 어느 서비스의 어떤 요청으로
                    케이스를 보낼지 정해요.
                  </>
                }
              />
            </h3>
            <div className="grid grid-cols-3 gap-2.5">
              <LabeledInput
                label="service"
                tip="케이스를 받을 서비스명이에요(보통 에이전트 서버)."
                value={s.frontDoorService}
                onChange={(v) => set({ frontDoorService: v })}
                placeholder="agent-server"
              />
              <LabeledInput
                label="submit"
                tip="케이스를 제출하는 HTTP 요청이에요. 예: POST /runs."
                value={s.frontDoorSubmit}
                onChange={(v) => set({ frontDoorSubmit: v })}
                placeholder="POST /runs"
              />
              <LabeledInput
                label="trace (선택)"
                tip="완료/트레이스를 확인할 경로예요. 없으면 비워둬요."
                value={s.frontDoorTrace}
                onChange={(v) => set({ frontDoorTrace: v })}
                placeholder="선택"
              />
            </div>
          </div>
          <div className="space-y-3">
            <h3 className="flex items-center gap-1 text-[13px] font-[560]">
              Trace source
              <InfoTip content="하니스가 내보낸 트레이스(OTel/MLflow)를 평가가 어디서 끌어올지예요." />
            </h3>
            <div className="grid grid-cols-3 gap-2.5">
              <div className="space-y-1">
                <span className="flex items-center gap-1">
                  <span className="text-[11px] font-[510] text-muted-foreground">kind</span>
                  <InfoTip content="트레이스 형식이에요." />
                </span>
                <Combobox
                  value={s.traceKind}
                  onChange={(v) => set({ traceKind: v })}
                  options={[
                    { value: 'mlflow', description: 'MLflow 트레이싱' },
                    { value: 'otel', description: 'OpenTelemetry' },
                  ]}
                  className="w-full"
                  aria-label="trace source kind"
                />
              </div>
              <div className="col-span-2">
                <LabeledInput
                  label="endpoint"
                  tip="트레이스를 끌어올 주소예요. 예: http://mlflow:5501."
                  value={s.traceEndpoint}
                  onChange={(v) => set({ traceEndpoint: v })}
                  placeholder="http://…:5501"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {mode === 'form' && s.kind === 'command' && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2.5">
            <LabeledInput
              label="image (선택)"
              tip="명령을 실행할 컨테이너 이미지예요. 비우면 기본 샌드박스. 인스턴스가 슬롯으로 덮어써요."
              value={s.image}
              onChange={(v) => set({ image: v })}
              placeholder="ghcr.io/…"
            />
            <LabeledInput
              label="model (선택)"
              tip="명령의 {{model}} 자리에 들어갈 기본 모델이에요. 인스턴스가 덮어써요."
              value={s.model}
              onChange={(v) => set({ model: v })}
              placeholder="claude-opus-4-8"
            />
            <LabeledInput
              label="workDir (선택)"
              tip="명령을 실행할 작업 디렉터리예요. 예: /tmp."
              value={s.workDir}
              onChange={(v) => set({ workDir: v })}
              placeholder="/tmp"
            />
          </div>
          <div className="space-y-1">
            <FieldLabel
              tip={
                <>
                  에이전트를 실행하는 <b>명령 한 줄</b>이에요. <code>{'{{task}}'}</code>·
                  <code>{'{{model}}'}</code>·<code>{'{{run_id}}'}</code> 는 케이스마다 채워져요.
                </>
              }
            >
              command (필수)
            </FieldLabel>
            <Input
              aria-label="command"
              value={s.command}
              onChange={(e) => set({ command: e.target.value })}
              placeholder="aider --message {{task}} --model {{model}} ."
            />
          </div>
          <LabeledTextarea
            label="setup (선택)"
            tip="명령 전에 한 번 실행할 설치 단계예요. 한 줄에 하나. 예: pip install aider-chat."
            value={s.setup}
            onChange={(v) => set({ setup: v })}
            placeholder="pip install aider-chat"
          />
          <EnvEditor
            label="env (선택)"
            tip={
              <>
                에이전트에 넣을 환경변수예요. API 키 같은 비밀은 <b>시크릿</b>으로 전환해 참조하세요
                — 스펙엔 이름만 저장되고 실행할 때 값이 주입돼요.
              </>
            }
            rows={s.envRows}
            onChange={(envRows) => set({ envRows })}
            secrets={secrets}
          />
        </div>
      )}

      {mode === 'json' && (
        <JsonArea label="HarnessTemplateSpec (JSON)" value={jsonText} onChange={setJsonText} />
      )}
      {mode === 'form' && <JsonPreview value={buildTemplate(s)} />}

      {result && <ValidateBanner result={result} />}
      {regError && <Callout tone="danger">{regError}</Callout>}
      <Actions
        busy={busy}
        onValidate={onValidate}
        onRegister={onRegister}
        registerLabel="템플릿 등록"
      />
    </div>
  )
}

// --- 인스턴스(template + pins) 등록 ---
// initial 프리필 + lockId(같은 하니스의 새 버전 — id 고정) + redirectDetailId(성공 시 상세로 복귀).
export function InstanceForm({
  workspace,
  initial,
  lockId = false,
  redirectDetailId,
  existingVersions,
  secrets = EMPTY_SECRETS,
}: {
  workspace: string
  initial?: InstanceState
  lockId?: boolean
  redirectDetailId?: string
  existingVersions?: string[]
  secrets?: ScopedSecretNames
}) {
  const router = useRouter()
  const [s, setS] = useState<InstanceState>(initial ?? INITIAL_INSTANCE)
  const [result, setResult] = useState<ValidateHarnessResult>()
  const [regError, setRegError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const set = (patch: Partial<InstanceState>) => setS((prev) => ({ ...prev, ...patch }))
  const setPin = (i: number, patch: Partial<PinRow>) =>
    set({ pins: s.pins.map((row, j) => (j === i ? { ...row, ...patch } : row)) })
  const setSvcOv = (i: number, patch: Partial<ServiceOverrideRow>) =>
    set({
      serviceOverrides: s.serviceOverrides.map((row, j) => (j === i ? { ...row, ...patch } : row)),
    })

  // front-door 본문 JSON 파싱 상태 — 오류면 검증/등록을 막는다(잘못된 JSON 을 컨트롤플레인에 보내지 않음).
  const bodyParse = parseJsonObject(s.bodyTemplate)
  const bodyError = bodyParse.ok ? undefined : bodyParse.error

  async function onValidate() {
    if (bodyError) return setRegError(`front-door 본문 JSON 오류: ${bodyError}`)
    setBusy(true)
    setRegError(undefined)
    setResult(await validateHarnessAction(buildInstance(s)))
    setBusy(false)
  }
  async function onRegister() {
    if (bodyError) return setRegError(`front-door 본문 JSON 오류: ${bodyError}`)
    setBusy(true)
    setRegError(undefined)
    const res = await registerHarnessAction(buildInstance(s))
    setBusy(false)
    if (res.ok) {
      // 새 버전(redirectDetailId) 이면 해당 버전 상세로, 아니면 목록으로.
      router.push(
        redirectDetailId
          ? `/${workspace}/harnesses/${encodeURIComponent(redirectDetailId)}?v=${encodeURIComponent(res.version ?? s.version)}`
          : `/${workspace}/harnesses`
      )
    } else setRegError(res.error ?? '등록 실패')
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <FieldLabel
            htmlFor="itid"
            tip="어떤 템플릿(대분류) 위에 만들지예요. 먼저 등록된 템플릿 id 를 적어요."
          >
            template id
          </FieldLabel>
          <Input
            id="itid"
            value={s.templateId}
            onChange={(e) => set({ templateId: e.target.value })}
            placeholder="bu"
            readOnly={lockId}
            className={cn(lockId && 'opacity-60')}
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel
            htmlFor="itver"
            tip="쓸 템플릿의 버전이에요. 템플릿 등록 때 정한 버전을 적어요."
          >
            template version
          </FieldLabel>
          <Input
            id="itver"
            value={s.templateVersion}
            onChange={(e) => set({ templateVersion: e.target.value })}
            placeholder="1"
          />
        </div>
      </div>
      <VersionRow
        existing={existingVersions}
        value={s.version}
        onChange={(v) => set({ version: v })}
        rawLabel="instance version"
        rawId="iver"
        placeholder="pr-123-sha-abc"
      />

      <Section
        title="Pins (슬롯 → 이미지/값)"
        onAdd={() => set({ pins: [...s.pins, { slot: '', value: '' }] })}
      >
        {s.pins.map((p, i) => (
          <div key={i} className="flex items-center gap-2 rounded-lg border bg-card p-3">
            <Input
              value={p.slot}
              onChange={(e) => setPin(i, { slot: e.target.value })}
              placeholder="slot (agent-server / image / model)"
            />
            <Input
              value={p.value}
              onChange={(e) => setPin(i, { value: e.target.value })}
              placeholder="value (ghcr.io/…/agent:abc)"
            />
            {s.pins.length > 1 && (
              <RemoveBtn onClick={() => set({ pins: s.pins.filter((_, j) => j !== i) })} />
            )}
          </div>
        ))}
      </Section>

      <OverridesEditor
        s={s}
        set={set}
        setSvcOv={setSvcOv}
        bodyError={bodyError}
        secrets={secrets}
      />

      <JsonPreview value={buildInstance(s)} />
      {result && <ValidateBanner result={result} />}
      {regError && <Callout tone="danger">{regError}</Callout>}
      <p className="text-[12px] text-muted-foreground">
        먼저 템플릿이 등록돼 있어야 해요. 슬롯 핀이 빠지면 등록되지 않아요.
      </p>
      <Actions
        busy={busy}
        onValidate={onValidate}
        onRegister={onRegister}
        registerLabel="인스턴스 등록"
      />
    </div>
  )
}

// 변주(overrides) 구조적 편집기 — 같은 템플릿 위에서 동작만 바꾸는 델타. 선택이라 접이식(disclosure)으로 숨겨
// 기본 폼(이미지 핀)은 깔끔하게 두고, 필요한 사람만 펼친다. 기존 변주가 있으면(새 버전 편집) 자동 펼침.
function hasOverrides(s: InstanceState): boolean {
  return (
    s.serviceOverrides.length > 0 ||
    s.bodyTemplate.trim() !== '' ||
    s.completionTimeout.trim() !== '' ||
    s.completionInterval.trim() !== '' ||
    s.targetExtensionRef.trim() !== '' ||
    s.cmdEnvRows.length > 0 ||
    s.cmdParams.trim() !== ''
  )
}

function OverridesEditor({
  s,
  set,
  setSvcOv,
  bodyError,
  secrets,
}: {
  s: InstanceState
  set: (patch: Partial<InstanceState>) => void
  setSvcOv: (i: number, patch: Partial<ServiceOverrideRow>) => void
  bodyError?: string
  secrets: ScopedSecretNames
}) {
  const [open, setOpen] = useState(hasOverrides(s))
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-secondary/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/50"
      >
        <span className="flex items-center gap-2 text-[13px] font-[560] text-foreground">
          <SlidersHorizontal className="size-3.5 text-muted-foreground" />
          변주 (overrides)
          <span className="font-normal text-[12px] text-muted-foreground">
            같은 템플릿, 다른 동작 · 선택
          </span>
        </span>
        <ChevronDown
          className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="space-y-6 border-t border-border px-4 py-4">
          <Section
            title="서비스 변주 (service 하니스)"
            onAdd={() =>
              set({ serviceOverrides: [...s.serviceOverrides, { ...EMPTY_SERVICE_OVERRIDE }] })
            }
          >
            {s.serviceOverrides.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                서비스마다 env·replicas 같은 설정을 덮어써요. 이미지 교체는 위 Pins에서 하고,
                서비스명은 템플릿에 있어야 해요.
              </p>
            ) : (
              s.serviceOverrides.map((r, i) => (
                <div key={i} className="space-y-2.5 rounded-lg border bg-card p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      value={r.service}
                      onChange={(e) => setSvcOv(i, { service: e.target.value })}
                      placeholder="서비스명 (agent-server)"
                    />
                    <RemoveBtn
                      onClick={() =>
                        set({ serviceOverrides: s.serviceOverrides.filter((_, j) => j !== i) })
                      }
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <NumField
                      label="replicas"
                      value={r.replicas}
                      onChange={(v) => setSvcOv(i, { replicas: v })}
                      placeholder="2"
                    />
                    <NumField
                      label="cpu (m · 1000=1코어)"
                      value={r.cpu}
                      onChange={(v) => setSvcOv(i, { cpu: v })}
                      placeholder="2000"
                    />
                    <NumField
                      label="memory (MB)"
                      value={r.memoryMb}
                      onChange={(v) => setSvcOv(i, { memoryMb: v })}
                      placeholder="4096"
                    />
                  </div>
                  <EnvEditor
                    label="env"
                    tip={
                      <>
                        이 서비스의 env 를 덮어써요. 비밀은 <b>시크릿</b>으로 참조하세요.
                      </>
                    }
                    rows={r.env}
                    onChange={(env) => setSvcOv(i, { env })}
                    secrets={secrets}
                  />
                  <Textarea
                    value={r.volumes}
                    onChange={(e) => setSvcOv(i, { volumes: e.target.value })}
                    placeholder="volumes (줄바꿈 — cache:/cache · /host:/c:ro)"
                    rows={2}
                    className="font-mono text-[12px]"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <NumField
                      label="readiness timeout (ms)"
                      value={r.readinessTimeout}
                      onChange={(v) => setSvcOv(i, { readinessTimeout: v })}
                      placeholder="60000"
                    />
                    <NumField
                      label="readiness interval (ms)"
                      value={r.readinessInterval}
                      onChange={(v) => setSvcOv(i, { readinessInterval: v })}
                      placeholder="1000"
                    />
                  </div>
                </div>
              ))
            )}
          </Section>

          <OvBlock title="Front-door (service 하니스)">
            <div className="space-y-1.5">
              <Label htmlFor="ovbody">submit 본문 값 (JSON 객체)</Label>
              <Textarea
                id="ovbody"
                value={s.bodyTemplate}
                onChange={(e) => set({ bodyTemplate: e.target.value })}
                placeholder={BODY_PLACEHOLDER}
                rows={3}
                className="font-mono text-[12px]"
              />
              {bodyError && <Callout tone="danger">본문 JSON 오류: {bodyError}</Callout>}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumField
                label="완료 timeout (ms)"
                value={s.completionTimeout}
                onChange={(v) => set({ completionTimeout: v })}
                placeholder="120000"
              />
              <NumField
                label="완료 interval (ms · poll)"
                value={s.completionInterval}
                onChange={(v) => set({ completionInterval: v })}
                placeholder="1000"
              />
            </div>
          </OvBlock>

          <OvBlock title="Target (service · browser 하니스)">
            <div className="space-y-1.5">
              <Label htmlFor="ovext">익스텐션 ref</Label>
              <Input
                id="ovext"
                value={s.targetExtensionRef}
                onChange={(e) => set({ targetExtensionRef: e.target.value })}
                placeholder="ghcr.io/acme/ext:2"
              />
            </div>
          </OvBlock>

          <OvBlock title="Command 하니스">
            <EnvEditor
              label="env"
              tip={
                <>
                  command 하니스의 env 를 덮어써요. 비밀은 <b>시크릿</b>으로 참조하세요.
                </>
              }
              rows={s.cmdEnvRows}
              onChange={(cmdEnvRows) => set({ cmdEnvRows })}
              secrets={secrets}
            />
            <div className="space-y-1.5">
              <Label htmlFor="ovcmdparams">{'params — command {{var}} 값 (KEY=VALUE)'}</Label>
              <Textarea
                id="ovcmdparams"
                value={s.cmdParams}
                onChange={(e) => set({ cmdParams: e.target.value })}
                placeholder="edit_format=diff"
                rows={2}
                className="font-mono text-[12px]"
              />
            </div>
          </OvBlock>
        </div>
      )}
    </div>
  )
}

// 작은 라벨 + 숫자 입력(폼은 문자열 보관 — Number() 환원). 행마다 반복되므로 id 충돌 없이 aria-label 로.
function NumField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="space-y-1">
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      <Input
        inputMode="numeric"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  )
}

// 변주 하위 묶음 카드 — 옅은 제목 + 내용.
function OvBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      <h4 className="text-[12px] font-[560] text-muted-foreground">{title}</h4>
      {children}
    </div>
  )
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded px-3 py-1 font-[510] transition-colors',
        active
          ? 'bg-card text-foreground shadow-raise'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

function ModeToggle({
  mode,
  setForm,
  setJson,
}: {
  mode: 'form' | 'json'
  setForm: () => void
  setJson: () => void
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-secondary/50 p-0.5 text-[13px]">
      <TabBtn active={mode === 'form'} onClick={setForm}>
        구조화
      </TabBtn>
      <TabBtn active={mode === 'json'} onClick={setJson}>
        JSON
      </TabBtn>
    </div>
  )
}

function JsonArea({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="json">{label}</Label>
      <Textarea
        id="json"
        className="min-h-72 text-[12px]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      <p className="text-[12px] text-muted-foreground">
        JSON 모드에서 고친 값은 구조화 폼에 반영되지 않아요.
      </p>
    </div>
  )
}

function JsonPreview({ value }: { value: unknown }) {
  return (
    <details className="rounded-lg border bg-muted/40 p-3 text-[13px]">
      <summary className="cursor-pointer font-[510] text-foreground">JSON 미리보기</summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-card p-2 font-mono text-[12px] text-muted-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  )
}

function Actions({
  busy,
  onValidate,
  onRegister,
  registerLabel,
}: {
  busy: boolean
  onValidate: () => void
  onRegister: () => void
  registerLabel: string
}) {
  return (
    <div className="flex gap-2">
      <Button type="button" variant="secondary" onClick={onValidate} disabled={busy}>
        {busy ? '…' : '검증하기'}
      </Button>
      <Button type="button" onClick={onRegister} disabled={busy}>
        {busy ? '처리 중…' : registerLabel}
      </Button>
    </div>
  )
}

function Section({
  title,
  tip,
  onAdd,
  children,
}: {
  title: string
  tip?: React.ReactNode
  onAdd: () => void
  children: React.ReactNode
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1 text-[13px] font-[560] text-foreground">
          {title}
          {tip != null && <InfoTip content={tip} />}
        </h3>
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-1 text-[12px] font-[510] text-link transition-colors hover:text-foreground"
        >
          <Plus className="size-3.5" /> 추가
        </button>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

// 작은 라벨 + info 툴팁이 달린 텍스트 입력(서비스 행처럼 필드가 촘촘한 곳에서 "뭐가뭔지" 안내).
function LabeledInput({
  label,
  tip,
  value,
  onChange,
  placeholder,
  inputMode,
}: {
  label: string
  tip?: React.ReactNode
  value: string
  onChange: (v: string) => void
  placeholder?: string
  inputMode?: 'numeric'
}) {
  return (
    <div className="space-y-1">
      <span className="flex items-center gap-1">
        <span className="text-[11px] font-[510] text-muted-foreground">{label}</span>
        {tip != null && <InfoTip content={tip} />}
      </span>
      <Input
        {...(inputMode ? { inputMode } : {})}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...(placeholder ? { placeholder } : {})}
      />
    </div>
  )
}

// 작은 라벨 + info 툴팁이 달린 여러 줄 입력(env·volumes 처럼 줄 단위 값).
function LabeledTextarea({
  label,
  tip,
  value,
  onChange,
  placeholder,
}: {
  label: string
  tip?: React.ReactNode
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="space-y-1">
      <span className="flex items-center gap-1">
        <span className="text-[11px] font-[510] text-muted-foreground">{label}</span>
        {tip != null && <InfoTip content={tip} />}
      </span>
      <Textarea
        className="min-h-14 text-[12px]"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...(placeholder ? { placeholder } : {})}
      />
    </div>
  )
}

function RemoveBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-destructive"
    >
      <Trash2 className="size-3.5" /> 삭제
    </button>
  )
}

function ValidateBanner({ result }: { result: ValidateHarnessResult }) {
  if (result.error) return <Callout tone="danger">검증을 실행하지 못했어요: {result.error}</Callout>
  if (!result.ok)
    return (
      <Callout tone="danger">
        <div className="font-[560]">검증 실패</div>
        <ul className="mt-1 list-disc pl-5">
          {result.errors?.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </Callout>
    )
  return (
    <Callout tone="info">
      <div className="font-[560]">
        ✓ 검증 통과 · {result.kind ? `${result.kind} ` : ''}
        {result.id}@{result.version}
      </div>
      {result.existingVersions !== undefined && (
        <div className="mt-1 text-[12px] text-muted-foreground">
          기존 버전:{' '}
          {result.existingVersions.length > 0 ? result.existingVersions.join(', ') : '없음'}
          {result.versionExists && ' — 같은 내용이면 그대로 두고, 다르면 등록이 막혀요.'}
        </div>
      )}
    </Callout>
  )
}
