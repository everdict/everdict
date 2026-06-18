'use client'

import { Plus, Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/shared/ui/button'
import { Input, Label, Select, Textarea } from '@/shared/ui/input'
import { type RegisterHarnessResult, registerHarnessAction, type ValidateHarnessResult, validateHarnessAction } from '../api/register-harness'
import { type DepRow, INITIAL, type ServiceRow, type WizardState, buildSpec } from '../lib/build-spec'

const STORES = ['postgres', 'redis', 'minio']
const ISOLATE = ['thread_id', 'key-prefix', 'object-prefix', 'schema']
const OBSERVE = ['dom', 'screenshot', 'url']

export function RegisterHarnessWizard() {
  const router = useRouter()
  const [s, setS] = useState<WizardState>(INITIAL)
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [jsonText, setJsonText] = useState('')
  const [result, setResult] = useState<ValidateHarnessResult>()
  const [regError, setRegError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const set = (patch: Partial<WizardState>) => setS((prev) => ({ ...prev, ...patch }))
  const setService = (i: number, patch: Partial<ServiceRow>) =>
    set({ services: s.services.map((row, j) => (j === i ? { ...row, ...patch } : row)) })
  const setDep = (i: number, patch: Partial<DepRow>) =>
    set({ deps: s.deps.map((row, j) => (j === i ? { ...row, ...patch } : row)) })

  function currentSpec(): unknown {
    if (mode === 'json') return JSON.parse(jsonText)
    return buildSpec(s)
  }
  function toJsonMode() {
    setJsonText(JSON.stringify(buildSpec(s), null, 2))
    setMode('json')
  }

  async function onValidate() {
    setBusy(true)
    setRegError(undefined)
    let spec: unknown
    try {
      spec = currentSpec()
    } catch {
      setBusy(false)
      setResult({ ok: false, error: 'JSON 파싱 실패' })
      return
    }
    const res = await validateHarnessAction(spec)
    setBusy(false)
    setResult(res)
  }

  async function onRegister() {
    setBusy(true)
    setRegError(undefined)
    let spec: unknown
    try {
      spec = currentSpec()
    } catch {
      setBusy(false)
      setRegError('JSON 파싱 실패')
      return
    }
    const res: RegisterHarnessResult = await registerHarnessAction(spec)
    setBusy(false)
    if (res.ok) router.push('/dashboard/harnesses')
    else setRegError(res.error ?? '등록 실패')
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* 모드 토글 */}
      <div className="flex gap-1 rounded-xl bg-secondary p-1 text-sm">
        <button
          type="button"
          onClick={() => setMode('form')}
          className={`flex-1 rounded-lg px-3 py-1.5 ${mode === 'form' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground'}`}
        >
          구조화
        </button>
        <button
          type="button"
          onClick={toJsonMode}
          className={`flex-1 rounded-lg px-3 py-1.5 ${mode === 'json' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground'}`}
        >
          JSON
        </button>
      </div>

      {/* 공통: kind / id / version */}
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label>종류 (kind)</Label>
          <div className="flex gap-4 text-sm">
            {(['service', 'process'] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="radio" name="kind" checked={s.kind === k} onChange={() => set({ kind: k })} />
                {k}
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="id">id</Label>
            <Input id="id" value={s.id} onChange={(e) => set({ id: e.target.value })} placeholder="bu" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="version">version</Label>
            <Input id="version" value={s.version} onChange={(e) => set({ version: e.target.value })} placeholder="1.2.0" />
          </div>
        </div>
      </div>

      {/* service 토폴로지 (form 모드) */}
      {mode === 'form' && s.kind === 'service' && (
        <div className="space-y-6">
          <Section title="Services" onAdd={() => set({ services: [...s.services, { name: '', image: '', port: '', needs: '', perRun: '', replicas: '1' }] })}>
            {s.services.map((sv, i) => (
              <div key={i} className="space-y-2 rounded-xl border p-3">
                <div className="grid grid-cols-2 gap-2">
                  <Input value={sv.name} onChange={(e) => setService(i, { name: e.target.value })} placeholder="name (agent-server)" />
                  <Input value={sv.image} onChange={(e) => setService(i, { image: e.target.value })} placeholder="image" />
                  <Input value={sv.port} onChange={(e) => setService(i, { port: e.target.value })} placeholder="port (8080)" />
                  <Input value={sv.replicas} onChange={(e) => setService(i, { replicas: e.target.value })} placeholder="replicas (1)" />
                  <Input value={sv.needs} onChange={(e) => setService(i, { needs: e.target.value })} placeholder="needs (콤마구분)" />
                  <Input value={sv.perRun} onChange={(e) => setService(i, { perRun: e.target.value })} placeholder="perRun (thread_id,…)" />
                </div>
                {s.services.length > 1 && <RemoveBtn onClick={() => set({ services: s.services.filter((_, j) => j !== i) })} />}
              </div>
            ))}
          </Section>

          <Section title="Dependencies" onAdd={() => set({ deps: [...s.deps, { store: 'postgres', role: '', isolateBy: 'thread_id' }] })}>
            {s.deps.length === 0 && <p className="text-xs text-muted-foreground">없음</p>}
            {s.deps.map((d, i) => (
              <div key={i} className="flex items-center gap-2 rounded-xl border p-3">
                <Select value={d.store} onChange={(e) => setDep(i, { store: e.target.value })}>
                  {STORES.map((x) => <option key={x}>{x}</option>)}
                </Select>
                <Input value={d.role} onChange={(e) => setDep(i, { role: e.target.value })} placeholder="role (checkpoints)" />
                <Select value={d.isolateBy} onChange={(e) => setDep(i, { isolateBy: e.target.value })}>
                  {ISOLATE.map((x) => <option key={x}>{x}</option>)}
                </Select>
                <RemoveBtn onClick={() => set({ deps: s.deps.filter((_, j) => j !== i) })} />
              </div>
            ))}
          </Section>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Front door</h3>
            <div className="grid grid-cols-3 gap-2">
              <Input value={s.frontDoorService} onChange={(e) => set({ frontDoorService: e.target.value })} placeholder="service" />
              <Input value={s.frontDoorSubmit} onChange={(e) => set({ frontDoorSubmit: e.target.value })} placeholder="submit (POST /runs)" />
              <Input value={s.frontDoorTrace} onChange={(e) => set({ frontDoorTrace: e.target.value })} placeholder="trace (optional)" />
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Trace source</h3>
            <div className="grid grid-cols-3 gap-2">
              <Select value={s.traceKind} onChange={(e) => set({ traceKind: e.target.value })}>
                <option value="mlflow">mlflow</option>
                <option value="otel">otel</option>
              </Select>
              <Input className="col-span-2" value={s.traceEndpoint} onChange={(e) => set({ traceEndpoint: e.target.value })} placeholder="endpoint (http://…:5501)" />
            </div>
          </div>

          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input type="checkbox" checked={s.targetEnabled} onChange={(e) => set({ targetEnabled: e.target.checked })} />
              Target (browser+extension)
            </label>
            {s.targetEnabled && (
              <div className="space-y-2 rounded-xl border p-3">
                <div className="grid grid-cols-2 gap-2">
                  <Select value={s.targetLifecycle} onChange={(e) => set({ targetLifecycle: e.target.value })}>
                    <option value="per-case-instance">per-case-instance</option>
                    <option value="per-case-context">per-case-context</option>
                  </Select>
                  <Input value={s.targetExtensionRef} onChange={(e) => set({ targetExtensionRef: e.target.value })} placeholder="extension ref (optional)" />
                </div>
                <div className="flex gap-4 text-sm">
                  {OBSERVE.map((o) => (
                    <label key={o} className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={s.targetObserve.includes(o)}
                        onChange={(e) =>
                          set({ targetObserve: e.target.checked ? [...s.targetObserve, o] : s.targetObserve.filter((x) => x !== o) })
                        }
                      />
                      {o}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* JSON 모드 */}
      {mode === 'json' && (
        <div className="space-y-1.5">
          <Label htmlFor="json">HarnessSpec (JSON)</Label>
          <Textarea id="json" className="min-h-72" value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} />
          <p className="text-xs text-muted-foreground">JSON 모드 편집은 구조화 폼과 동기화되지 않습니다.</p>
        </div>
      )}

      {/* JSON 미리보기 (form 모드) */}
      {mode === 'form' && (
        <details className="rounded-xl border bg-secondary/30 p-3 text-sm">
          <summary className="cursor-pointer font-medium">JSON 미리보기</summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">
            {JSON.stringify(buildSpec(s), null, 2)}
          </pre>
        </details>
      )}

      {/* 검증 결과 */}
      {result && <ValidateBanner result={result} />}
      {regError && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{regError}</div>
      )}

      <p className="text-xs text-muted-foreground">버전은 불변입니다 — 같은 (id, version)을 다른 스펙으로 다시 등록하면 409 로 거부됩니다.</p>

      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={onValidate} disabled={busy}>
          {busy ? '…' : '검증 (dry-run)'}
        </Button>
        <Button type="button" onClick={onRegister} disabled={busy}>
          {busy ? '처리 중…' : '하니스 등록'}
        </Button>
      </div>
    </div>
  )
}

function Section({ title, onAdd, children }: { title: string; onAdd: () => void; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <button type="button" onClick={onAdd} className="flex items-center gap-1 text-sm text-primary hover:opacity-80">
          <Plus className="size-3.5" /> 추가
        </button>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function RemoveBtn({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive">
      <Trash2 className="size-3.5" /> 삭제
    </button>
  )
}

function ValidateBanner({ result }: { result: ValidateHarnessResult }) {
  if (result.error)
    return <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">검증 호출 실패: {result.error}</div>
  if (!result.ok)
    return (
      <div className="space-y-1 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        <div className="font-medium">스키마 오류</div>
        <ul className="list-disc pl-5">{result.errors?.map((e) => <li key={e}>{e}</li>)}</ul>
      </div>
    )
  return (
    <div className="space-y-1 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm">
      <div className="font-medium text-emerald-700">
        ✓ 스키마 정상 · {result.id}@{result.version} {result.versionExists ? '(이미 존재)' : '(새 버전)'}
      </div>
      <div className="text-muted-foreground">
        기존 버전: {result.existingVersions && result.existingVersions.length > 0 ? result.existingVersions.join(', ') : '없음'}
        {result.versionExists && ' — 동일 스펙이면 no-op, 다르면 409 로 거부됩니다.'}
      </div>
    </div>
  )
}
