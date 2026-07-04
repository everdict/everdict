'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Loader2, Plug } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'

import { createRuntimeAction, probeRuntimeAction } from '../api/register-runtime'

type Kind = 'nomad' | 'k8s'

// 등록 인프라 종류 — local(dev 전용) 과 docker(단일 호스트, slice 5b 에서 self-hosted 러너로 흡수)는 등록 UI 에서
// 제외. "내 머신/단일 docker 호스트"는 러너로 연결하고, 컨테이너 실행은 런타임 kind 가 아니라 docker capability 다.
const KINDS: { value: Kind; label: string; description: string }[] = [
  {
    value: 'nomad',
    label: 'Nomad',
    description: 'Nomad 클러스터 — alloc 으로 러너 에이전트 배치 (runsc 등 격리).',
  },
  {
    value: 'k8s',
    label: 'Kubernetes',
    description: 'K8s 클러스터 — Job 으로 배치 (runtimeClassName 격리).',
  },
]

interface Fields {
  kind: Kind
  id: string
  version: string
  description: string
  tags: string
  image: string
  addr: string
  namespace: string
  datacenters: string
  runtime: string
  context: string
  runtimeClass: string
  server: string
  authSecret: string
  kubeconfigSecret: string
  supportsTopology: boolean
  browserImage: string
  traceKind: 'otel' | 'mlflow'
  traceEndpoint: string
}

const INITIAL: Fields = {
  kind: 'nomad',
  id: '',
  version: '1.0.0',
  description: '',
  tags: '',
  image: '',
  addr: '',
  namespace: '',
  datacenters: '',
  runtime: '',
  context: '',
  runtimeClass: '',
  server: '',
  authSecret: '',
  kubeconfigSecret: '',
  supportsTopology: false,
  browserImage: '',
  traceKind: 'otel',
  traceEndpoint: '',
}

const csv = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

// 폼 → RuntimeSpec. 빈 옵셔널은 제외해 서버 스키마(discriminatedUnion)에 정확히 맞춘다.
function buildSpec(f: Fields): Record<string, unknown> {
  const t = (v: string) => v.trim()
  const base: Record<string, unknown> = {
    kind: f.kind,
    id: t(f.id),
    version: t(f.version) || '1.0.0',
    ...(t(f.description) ? { description: t(f.description) } : {}),
    ...(csv(f.tags).length ? { tags: csv(f.tags) } : {}),
  }
  const opt = (k: string, v: string) => (t(v) ? { [k]: t(v) } : {})
  // topology 지원(nomad/k8s): traceSource + browserImage + topology capability 를 스펙에 실는다.
  const topology = f.supportsTopology
    ? {
        traceSource: { kind: f.traceKind, endpoint: t(f.traceEndpoint) },
        ...opt('browserImage', f.browserImage),
        capabilities: ['topology'],
      }
    : {}
  if (f.kind === 'nomad')
    return {
      ...base,
      addr: t(f.addr),
      image: t(f.image),
      ...opt('namespace', f.namespace),
      ...(csv(f.datacenters).length ? { datacenters: csv(f.datacenters) } : {}),
      ...opt('runtime', f.runtime),
      ...opt('authSecret', f.authSecret),
      ...topology,
    }
  // k8s
  return {
    ...base,
    image: t(f.image),
    ...opt('context', f.context),
    ...opt('namespace', f.namespace),
    ...opt('runtimeClass', f.runtimeClass),
    ...opt('server', f.server),
    ...opt('authSecret', f.authSecret),
    ...opt('kubeconfigSecret', f.kubeconfigSecret),
    ...topology,
  }
}

// 클라이언트 필수값 점검(서버도 강제하지만 즉시 피드백). null=통과.
function requiredError(f: Fields): string | null {
  if (!f.id.trim()) return 'ID를 입력하세요.'
  if (!f.version.trim()) return '버전을 입력하세요.'
  if (f.kind === 'nomad' && (!f.addr.trim() || !f.image.trim()))
    return 'Nomad 는 주소(addr)와 이미지가 필요해요.'
  if (f.kind === 'k8s' && !f.image.trim()) return 'K8s 는 러너 이미지가 필요해요.'
  if (f.supportsTopology && !f.traceEndpoint.trim())
    return '토폴로지 지원은 트레이스 엔드포인트가 필요해요.'
  return null
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-[12px] text-faint">{hint}</p>}
    </div>
  )
}

// 워크스페이스 인프라 런타임 등록 폼(nomad/k8s/topology). 자격증명은 여기 넣지 않고 SecretStore 키 이름으로 참조.
export function RegisterRuntimeForm({ workspace }: { workspace: string }) {
  const router = useRouter()
  const [f, setF] = useState<Fields>(INITIAL)
  const [error, setError] = useState<string>()
  const [probe, setProbe] = useState<{ reachable?: boolean; detail?: string; error?: string }>()
  const [probing, startProbe] = useTransition()
  const [saving, startSave] = useTransition()

  const set = <K extends keyof Fields>(k: K, v: Fields[K]) => setF((p) => ({ ...p, [k]: v }))
  const kindMeta = useMemo(() => KINDS.find((k) => k.value === f.kind), [f.kind])
  const secretHint = '워크스페이스 시크릿 "이름" (값 아님). 설정 → 시크릿에서 먼저 등록하세요.'

  function onProbe() {
    setError(undefined)
    setProbe(undefined)
    const err = requiredError(f)
    if (err) {
      setError(err)
      return
    }
    startProbe(async () => {
      const r = await probeRuntimeAction(buildSpec(f))
      if (r.ok) setProbe({ reachable: r.reachable, detail: r.detail })
      else setProbe({ error: r.error })
    })
  }

  function onSubmit() {
    setError(undefined)
    const err = requiredError(f)
    if (err) {
      setError(err)
      return
    }
    startSave(async () => {
      const r = await createRuntimeAction(buildSpec(f))
      if (r.ok) {
        toast.success(`런타임 ${r.id}@${r.version} 등록됨`)
        router.push(`/${workspace}/runtimes`)
        router.refresh()
      } else {
        setError(r.error ?? '등록하지 못했어요.')
      }
    })
  }

  const cluster = f.kind === 'nomad' || f.kind === 'k8s'

  return (
    <div className="max-w-2xl space-y-6">
      {/* 종류 */}
      <div className="space-y-1.5">
        <Label>종류</Label>
        <Combobox
          value={f.kind}
          onChange={(v) => set('kind', v as Kind)}
          options={KINDS.map((k) => ({
            value: k.value,
            label: k.label,
            description: k.description,
          }))}
        />
        {kindMeta && <p className="text-[12px] text-muted-foreground">{kindMeta.description}</p>}
      </div>

      {/* 공통 */}
      <div className="grid grid-cols-2 gap-4">
        <Field label="ID" hint="이 워크스페이스에서 런타임을 부르는 이름 (예: prod-k8s).">
          <Input
            value={f.id}
            onChange={(e) => set('id', e.target.value)}
            placeholder="prod-k8s"
            autoComplete="off"
          />
        </Field>
        <Field label="버전" hint="불변. 바꾸면 새 버전으로 등록돼요.">
          <Input
            value={f.version}
            onChange={(e) => set('version', e.target.value)}
            placeholder="1.0.0"
            autoComplete="off"
          />
        </Field>
      </div>

      {/* nomad */}
      {f.kind === 'nomad' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="주소 (addr)" hint="Nomad HTTP 엔드포인트.">
              <Input
                value={f.addr}
                onChange={(e) => set('addr', e.target.value)}
                placeholder="http://nomad.internal:4646"
                autoComplete="off"
              />
            </Field>
            <Field label="러너 이미지" hint="에이전트 이미지(테넌트 레지스트리).">
              <Input
                value={f.image}
                onChange={(e) => set('image', e.target.value)}
                placeholder="ghcr.io/acme/agent:latest"
                autoComplete="off"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="네임스페이스 (선택)">
              <Input
                value={f.namespace}
                onChange={(e) => set('namespace', e.target.value)}
                placeholder="default"
                autoComplete="off"
              />
            </Field>
            <Field label="격리 런타임 (선택)" hint="docker 격리 런타임 (예: runsc = gVisor).">
              <Input
                value={f.runtime}
                onChange={(e) => set('runtime', e.target.value)}
                placeholder="runsc"
                autoComplete="off"
              />
            </Field>
          </div>
          <Field label="데이터센터 (선택)" hint="쉼표로 구분.">
            <Input
              value={f.datacenters}
              onChange={(e) => set('datacenters', e.target.value)}
              placeholder="dc1, dc2"
              autoComplete="off"
            />
          </Field>
          <Field label="ACL 토큰 시크릿 (선택)" hint={secretHint}>
            <Input
              value={f.authSecret}
              onChange={(e) => set('authSecret', e.target.value)}
              placeholder="nomad-token"
              autoComplete="off"
            />
          </Field>
        </div>
      )}

      {/* k8s */}
      {f.kind === 'k8s' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="러너 이미지" hint="Job 컨테이너 이미지.">
              <Input
                value={f.image}
                onChange={(e) => set('image', e.target.value)}
                placeholder="ghcr.io/acme/agent:latest"
                autoComplete="off"
              />
            </Field>
            <Field label="네임스페이스 (선택)">
              <Input
                value={f.namespace}
                onChange={(e) => set('namespace', e.target.value)}
                placeholder="assay"
                autoComplete="off"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="컨텍스트 (선택)" hint="로컬 kubeconfig 컨텍스트로 인증할 때.">
              <Input
                value={f.context}
                onChange={(e) => set('context', e.target.value)}
                placeholder="prod-cluster"
                autoComplete="off"
              />
            </Field>
            <Field label="runtimeClass (선택)" hint="격리 런타임클래스 (예: gvisor).">
              <Input
                value={f.runtimeClass}
                onChange={(e) => set('runtimeClass', e.target.value)}
                placeholder="gvisor"
                autoComplete="off"
              />
            </Field>
          </div>
          <Field label="API 서버 URL (선택)" hint="context 대신 bearer 토큰으로 인증할 때.">
            <Input
              value={f.server}
              onChange={(e) => set('server', e.target.value)}
              placeholder="https://k8s.acme.io:6443"
              autoComplete="off"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Bearer 토큰 시크릿 (선택)" hint={secretHint}>
              <Input
                value={f.authSecret}
                onChange={(e) => set('authSecret', e.target.value)}
                placeholder="k8s-token"
                autoComplete="off"
              />
            </Field>
            <Field
              label="kubeconfig 시크릿 (선택)"
              hint="EKS/GKE 등 exec-plugin 인증용 전체 kubeconfig 시크릿 이름."
            >
              <Input
                value={f.kubeconfigSecret}
                onChange={(e) => set('kubeconfigSecret', e.target.value)}
                placeholder="prod-kubeconfig"
                autoComplete="off"
              />
            </Field>
          </div>
        </div>
      )}

      {/* topology 지원 — traceSource 를 넣으면 이 nomad/k8s 런타임이 서비스 토폴로지 하니스(browser-use 등)도 호스팅(topology capability) */}
      <div className="space-y-3 rounded-lg border bg-card px-4 py-3.5 shadow-raise">
        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            className="accent-primary"
            checked={f.supportsTopology}
            onChange={(e) => set('supportsTopology', e.target.checked)}
          />
          <span className="text-[13px] font-[510] text-foreground">
            서비스 토폴로지 하니스도 이 런타임으로 (topology)
          </span>
        </label>
        {f.supportsTopology && (
          <div className="space-y-4 pl-[26px]">
            <div className="grid grid-cols-2 gap-4">
              <Field label="트레이스 소스">
                <Combobox
                  value={f.traceKind}
                  onChange={(v) => set('traceKind', v as 'otel' | 'mlflow')}
                  options={[
                    { value: 'otel', label: 'OTel' },
                    { value: 'mlflow', label: 'MLflow' },
                  ]}
                />
              </Field>
              <Field label="트레이스 엔드포인트" hint="채점용 트레이스를 당겨올 소스.">
                <Input
                  value={f.traceEndpoint}
                  onChange={(e) => set('traceEndpoint', e.target.value)}
                  placeholder="http://mlflow.internal:5000"
                  autoComplete="off"
                />
              </Field>
            </div>
            <Field label="브라우저 이미지 (선택)" hint="per-case 브라우저 이미지(browser-use 등).">
              <Input
                value={f.browserImage}
                onChange={(e) => set('browserImage', e.target.value)}
                placeholder="ghcr.io/acme/browser:latest"
                autoComplete="off"
              />
            </Field>
          </div>
        )}
      </div>

      {/* 공통: 설명·태그 */}
      <div className="grid grid-cols-2 gap-4">
        <Field label="설명 (선택)">
          <Input
            value={f.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="프로덕션 클러스터"
            autoComplete="off"
          />
        </Field>
        <Field label="태그 (선택)" hint="쉼표로 구분.">
          <Input
            value={f.tags}
            onChange={(e) => set('tags', e.target.value)}
            placeholder="prod, gpu"
            autoComplete="off"
          />
        </Field>
      </div>

      {probe?.reachable !== undefined && (
        <Callout tone={probe.reachable ? 'info' : 'warning'}>
          {probe.reachable ? '✓ 연결 성공' : '도달 실패'}
          {probe.detail ? ` — ${probe.detail}` : ''}
        </Callout>
      )}
      {probe?.error && (
        <Callout tone="danger" className="py-1.5">
          연결 테스트 실패: {probe.error}
        </Callout>
      )}
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      <div className="flex items-center gap-2.5 border-t border-border pt-5">
        <Button onClick={onSubmit} disabled={saving} className="gap-1.5">
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <CheckCircle2 className="size-4" />
          )}
          {saving ? '등록 중…' : '런타임 등록'}
        </Button>
        {cluster && (
          <Button variant="secondary" onClick={onProbe} disabled={probing} className="gap-1.5">
            {probing ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
            연결 테스트
          </Button>
        )}
        <Button variant="ghost" onClick={() => router.push(`/${workspace}/runtimes`)}>
          취소
        </Button>
      </div>
    </div>
  )
}
