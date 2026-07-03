'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ChevronDown, Plus, SlidersHorizontal, Trash2 } from 'lucide-react'

import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label, Textarea } from '@/shared/ui/input'

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

// front-door submit 본문 값 오버라이드 편집기의 안내 예시(자유 형식 JSON 객체).
const BODY_PLACEHOLDER = `{ "max_steps": 30, "system_prompt": "..." }`

const STORES = ['postgres', 'redis', 'minio']
const ISOLATE = ['thread_id', 'key-prefix', 'object-prefix', 'schema', 'external']
const CATEGORIES = ['topology', 'claude-code', 'codex', 'cli-agent', 'desktop', 'custom']

type Tab = 'template' | 'instance'

export function RegisterHarnessWizard() {
  const { workspace } = useParams<{ workspace: string }>()
  const [tab, setTab] = useState<Tab>('template')

  return (
    <div className="max-w-2xl space-y-5">
      <div className="inline-flex rounded-md border border-border bg-secondary/50 p-0.5 text-[13px]">
        <TabBtn active={tab === 'template'} onClick={() => setTab('template')}>
          템플릿 (대분류)
        </TabBtn>
        <TabBtn active={tab === 'instance'} onClick={() => setTab('instance')}>
          인스턴스 (template + pins)
        </TabBtn>
      </div>
      <p className="text-[12px] text-muted-foreground">
        {tab === 'template'
          ? '대분류 = 구조/슬롯(버전 미고정). 같은 토폴로지의 변형(인스턴스)은 이 위에서 서비스 버전만 핀해 만듭니다.'
          : '인스턴스 = 등록된 템플릿을 참조해 슬롯마다 이미지/버전을 핀한 하나의 하니스(보통 PR/SHA 마다 하나).'}
      </p>
      {tab === 'template' ? (
        <TemplateForm workspace={workspace} />
      ) : (
        <InstanceForm workspace={workspace} />
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
}: {
  workspace: string
  initial?: TemplateState
  lockId?: boolean
  onRegistered?: (version: string) => void
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
          <Label>kind</Label>
          <Combobox
            value={s.kind}
            onChange={(v) => set({ kind: v as Kind })}
            disabled={lockId}
            options={[{ value: 'service' }, { value: 'command' }, { value: 'process' }]}
            className={cn('w-full', lockId && 'opacity-60')}
            aria-label="kind"
          />
        </div>
        <div className="space-y-1.5">
          <Label>category (대분류)</Label>
          <Combobox
            value={s.category}
            onChange={(v) => set({ category: v })}
            options={CATEGORIES.map((c) => ({ value: c }))}
            className="w-full"
            aria-label="category"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tid">id</Label>
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
      <div className="space-y-1.5">
        <Label htmlFor="tver">version (구조 버전 — 모양이 바뀔 때만 올림)</Label>
        <Input
          id="tver"
          value={s.version}
          onChange={(e) => set({ version: e.target.value })}
          placeholder="1"
        />
      </div>

      {mode === 'form' && s.kind === 'service' && (
        <div className="space-y-6">
          <Section
            title="Services (슬롯 — 인스턴스가 이미지를 핀)"
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
                    env: '',
                    volumes: '',
                    readinessTimeout: '',
                    readinessInterval: '',
                  },
                ],
              })
            }
          >
            {s.services.map((sv, i) => (
              <div key={i} className="space-y-2 rounded-lg border bg-card p-3">
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    value={sv.name}
                    onChange={(e) => setService(i, { name: e.target.value })}
                    placeholder="name (agent-server)"
                  />
                  <Input
                    value={sv.slot}
                    onChange={(e) => setService(i, { slot: e.target.value })}
                    placeholder="slot (비우면 name)"
                  />
                  <Input
                    value={sv.port}
                    onChange={(e) => setService(i, { port: e.target.value })}
                    placeholder="port (8080)"
                  />
                  <Input
                    value={sv.replicas}
                    onChange={(e) => setService(i, { replicas: e.target.value })}
                    placeholder="replicas (1)"
                  />
                  <Input
                    value={sv.needs}
                    onChange={(e) => setService(i, { needs: e.target.value })}
                    placeholder="needs (콤마구분)"
                  />
                  <Input
                    value={sv.perRun}
                    onChange={(e) => setService(i, { perRun: e.target.value })}
                    placeholder="perRun (thread_id,…)"
                  />
                </div>
                <Textarea
                  className="min-h-14 text-[12px]"
                  value={sv.env}
                  onChange={(e) => setService(i, { env: e.target.value })}
                  placeholder="env (KEY=VALUE 줄바꿈 구분: LOG_LEVEL=debug)"
                />
                <Textarea
                  className="min-h-14 text-[12px]"
                  value={sv.volumes}
                  onChange={(e) => setService(i, { volumes: e.target.value })}
                  placeholder="volumes (줄바꿈 구분: pgdata:/var/lib/postgresql/data)"
                />
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    value={sv.readinessTimeout}
                    onChange={(e) => setService(i, { readinessTimeout: e.target.value })}
                    placeholder="readiness timeout ms (60000)"
                  />
                  <Input
                    value={sv.readinessInterval}
                    onChange={(e) => setService(i, { readinessInterval: e.target.value })}
                    placeholder="readiness interval ms (1000)"
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
            title="Dependencies (공유 스토어 · external=BYO 외부)"
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
              <div key={i} className="space-y-2 rounded-lg border bg-card p-3">
                <div className="flex items-center gap-2">
                  <Combobox
                    value={d.store}
                    onChange={(v) => setDep(i, { store: v })}
                    options={STORES.map((x) => ({ value: x }))}
                    className="w-full"
                    aria-label="store"
                  />
                  <Input
                    value={d.role}
                    onChange={(e) => setDep(i, { role: e.target.value })}
                    placeholder="role"
                  />
                  <Combobox
                    value={d.isolateBy}
                    onChange={(v) => setDep(i, { isolateBy: v })}
                    options={ISOLATE.map((x) => ({ value: x }))}
                    className="w-full"
                    aria-label="isolateBy"
                  />
                  <RemoveBtn onClick={() => set({ deps: s.deps.filter((_, j) => j !== i) })} />
                </div>
                <Input
                  value={d.service}
                  onChange={(e) => setDep(i, { service: e.target.value })}
                  placeholder="service (이 스토어를 쓰는 서비스, 선택)"
                />
                {d.isolateBy === 'external' && (
                  <p className="text-[11px] text-muted-foreground">
                    external = BYO 외부/공유 스토어(다른 클러스터 등). Assay 가 배포·격리하지 않고,
                    연결은 배포 시 env(storeEnv)로 주입됩니다.
                  </p>
                )}
              </div>
            ))}
          </Section>
          <div className="space-y-3">
            <h3 className="text-[13px] font-[560]">Front door</h3>
            <div className="grid grid-cols-3 gap-2">
              <Input
                value={s.frontDoorService}
                onChange={(e) => set({ frontDoorService: e.target.value })}
                placeholder="service"
              />
              <Input
                value={s.frontDoorSubmit}
                onChange={(e) => set({ frontDoorSubmit: e.target.value })}
                placeholder="submit (POST /runs)"
              />
              <Input
                value={s.frontDoorTrace}
                onChange={(e) => set({ frontDoorTrace: e.target.value })}
                placeholder="trace (optional)"
              />
            </div>
          </div>
          <div className="space-y-3">
            <h3 className="text-[13px] font-[560]">Trace source</h3>
            <div className="grid grid-cols-3 gap-2">
              <Combobox
                value={s.traceKind}
                onChange={(v) => set({ traceKind: v })}
                options={[{ value: 'mlflow' }, { value: 'otel' }]}
                className="w-full"
                aria-label="trace source kind"
              />
              <Input
                className="col-span-2"
                value={s.traceEndpoint}
                onChange={(e) => set({ traceEndpoint: e.target.value })}
                placeholder="endpoint (http://…:5501)"
              />
            </div>
          </div>
        </div>
      )}

      {mode === 'form' && s.kind === 'command' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={s.image}
              onChange={(e) => set({ image: e.target.value })}
              placeholder="image (기본; 인스턴스가 override)"
            />
            <Input
              value={s.model}
              onChange={(e) => set({ model: e.target.value })}
              placeholder="model (기본)"
            />
            <Input
              value={s.workDir}
              onChange={(e) => set({ workDir: e.target.value })}
              placeholder="workDir (예: /tmp)"
            />
          </div>
          <Input
            value={s.command}
            onChange={(e) => set({ command: e.target.value })}
            placeholder="command (예: aider --message {{task}} --model {{model}} .)"
          />
          <Textarea
            className="min-h-20 text-[12px]"
            value={s.setup}
            onChange={(e) => set({ setup: e.target.value })}
            placeholder="setup (줄바꿈 구분: pip install …)"
          />
          <Textarea
            className="min-h-16 text-[12px]"
            value={s.envText}
            onChange={(e) => set({ envText: e.target.value })}
            placeholder="env (KEY=VALUE 줄바꿈 구분)"
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
}: {
  workspace: string
  initial?: InstanceState
  lockId?: boolean
  redirectDetailId?: string
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
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="itid">template id</Label>
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
          <Label htmlFor="itver">template version</Label>
          <Input
            id="itver"
            value={s.templateVersion}
            onChange={(e) => set({ templateVersion: e.target.value })}
            placeholder="1"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="iver">instance version</Label>
          <Input
            id="iver"
            value={s.version}
            onChange={(e) => set({ version: e.target.value })}
            placeholder="pr-123-sha-abc"
          />
        </div>
      </div>

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

      <OverridesEditor s={s} set={set} setSvcOv={setSvcOv} bodyError={bodyError} />

      <JsonPreview value={buildInstance(s)} />
      {result && <ValidateBanner result={result} />}
      {regError && <Callout tone="danger">{regError}</Callout>}
      <p className="text-[12px] text-muted-foreground">
        템플릿이 먼저 등록돼 있어야 합니다 — 없거나 슬롯 pin 이 빠지면 검증/등록이 거부됩니다(버전
        불변).
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
    s.cmdEnv.trim() !== '' ||
    s.cmdParams.trim() !== ''
  )
}

function OverridesEditor({
  s,
  set,
  setSvcOv,
  bodyError,
}: {
  s: InstanceState
  set: (patch: Partial<InstanceState>) => void
  setSvcOv: (i: number, patch: Partial<ServiceOverrideRow>) => void
  bodyError?: string
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
                서비스별 env·replicas·resources·volumes·readiness 를 덮어씁니다 (서비스명은 템플릿에
                존재해야 함). 이미지 교체는 위 Pins 로.
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
                  <Textarea
                    value={r.env}
                    onChange={(e) => setSvcOv(i, { env: e.target.value })}
                    placeholder="env (KEY=VALUE 줄바꿈 — MODEL=claude-opus-4-8)"
                    rows={2}
                    className="font-mono text-[12px]"
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
            <div className="space-y-1.5">
              <Label htmlFor="ovcmdenv">env (KEY=VALUE 줄바꿈)</Label>
              <Textarea
                id="ovcmdenv"
                value={s.cmdEnv}
                onChange={(e) => set({ cmdEnv: e.target.value })}
                placeholder="AIDER_TEMPERATURE=0"
                rows={2}
                className="font-mono text-[12px]"
              />
            </div>
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
        JSON 모드 편집은 구조화 폼과 동기화되지 않습니다.
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
        {busy ? '…' : '검증 (dry-run)'}
      </Button>
      <Button type="button" onClick={onRegister} disabled={busy}>
        {busy ? '처리 중…' : registerLabel}
      </Button>
    </div>
  )
}

function Section({
  title,
  onAdd,
  children,
}: {
  title: string
  onAdd: () => void
  children: React.ReactNode
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-[560] text-foreground">{title}</h3>
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
  if (result.error) return <Callout tone="danger">검증 호출 실패: {result.error}</Callout>
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
          {result.versionExists && ' — 동일하면 no-op, 다르면 409.'}
        </div>
      )}
    </Callout>
  )
}
