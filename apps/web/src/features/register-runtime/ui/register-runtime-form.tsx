'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Loader2, Plug } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'

import { createRuntimeAction, probeRuntimeAction } from '../api/register-runtime'

type Kind = 'nomad' | 'k8s'

// 등록 인프라 종류 — local(dev 전용) 과 docker(단일 호스트, slice 5b 에서 self-hosted 러너로 흡수)는 등록 UI 에서
// 제외. "내 머신/단일 docker 호스트"는 러너로 연결하고, 컨테이너 실행은 런타임 kind 가 아니라 docker capability 다.
const KINDS: { value: Kind; label: string; descriptionKey: string }[] = [
  { value: 'nomad', label: 'Nomad', descriptionKey: 'kindNomadDescription' },
  { value: 'k8s', label: 'Kubernetes', descriptionKey: 'kindK8sDescription' },
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

// 하드닝(강격리) 런타임 이름 — core trust-zone HARDENED_RUNTIMES 미러(nomad runtime / k8s runtimeClass).
const HARDENED = new Set(['runsc', 'gvisor', 'kata', 'kata-runtime', 'firecracker', 'fc'])

// 이 런타임이 자동으로 제공하는 capability — 앱이 스펙에서 라벨한다(유저 수동입력 없음; core defaultRuntimeCapabilities 미러).
function runtimeCaps(f: Fields): string[] {
  const caps = ['docker'] // nomad/k8s 는 컨테이너 이미지 실행
  const iso = (f.kind === 'nomad' ? f.runtime : f.runtimeClass).trim()
  if (iso && HARDENED.has(iso)) caps.push('sandbox') // 강격리 런타임
  if (f.supportsTopology) caps.push('topology')
  return caps
}

// 폼 → RuntimeSpec. 빈 옵셔널은 제외해 서버 스키마(discriminatedUnion)에 맞춘다. capabilities 는 앱이 자동 라벨.
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
  const topology = f.supportsTopology
    ? {
        traceSource: { kind: f.traceKind, endpoint: t(f.traceEndpoint) },
        ...opt('browserImage', f.browserImage),
      }
    : {}
  const capabilities = runtimeCaps(f)
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
      capabilities,
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
    capabilities,
  }
}

// 클라이언트 필수값 점검(서버도 강제하지만 즉시 피드백). null=통과. 반환값은 메시지 카탈로그 키.
function requiredErrorKey(f: Fields): string | null {
  if (!f.id.trim()) return 'errorIdRequired'
  if (!f.version.trim()) return 'errorVersionRequired'
  if (f.kind === 'nomad' && (!f.addr.trim() || !f.image.trim())) return 'errorNomadRequired'
  if (f.kind === 'k8s' && !f.image.trim()) return 'errorK8sImageRequired'
  if (f.supportsTopology && !f.traceEndpoint.trim()) return 'errorTopologyEndpointRequired'
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
  const t = useTranslations('registerRuntime')
  const [f, setF] = useState<Fields>(INITIAL)
  const [error, setError] = useState<string>()
  const [probe, setProbe] = useState<{ reachable?: boolean; detail?: string; error?: string }>()
  const [probing, startProbe] = useTransition()
  const [saving, startSave] = useTransition()

  const set = <K extends keyof Fields>(k: K, v: Fields[K]) => setF((p) => ({ ...p, [k]: v }))
  const kindMeta = useMemo(() => KINDS.find((k) => k.value === f.kind), [f.kind])
  const secretHint = t('secretHint')

  function onProbe() {
    setError(undefined)
    setProbe(undefined)
    const errKey = requiredErrorKey(f)
    if (errKey) {
      setError(t(errKey))
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
    const errKey = requiredErrorKey(f)
    if (errKey) {
      setError(t(errKey))
      return
    }
    startSave(async () => {
      const r = await createRuntimeAction(buildSpec(f))
      if (r.ok) {
        toast.success(t('registered', { id: r.id ?? '', version: r.version ?? '' }))
        router.push(`/${workspace}/runtimes`)
        router.refresh()
      } else {
        setError(r.error ?? t('errorGeneric'))
      }
    })
  }

  const cluster = f.kind === 'nomad' || f.kind === 'k8s'

  return (
    <div className="max-w-2xl space-y-6">
      {/* 종류 */}
      <div className="space-y-1.5">
        <Label>{t('kindLabel')}</Label>
        <Combobox
          value={f.kind}
          onChange={(v) => set('kind', v as Kind)}
          options={KINDS.map((k) => ({
            value: k.value,
            label: k.label,
            description: t(k.descriptionKey),
          }))}
        />
        {kindMeta && (
          <p className="text-[12px] text-muted-foreground">{t(kindMeta.descriptionKey)}</p>
        )}
      </div>

      {/* 공통 */}
      <div className="grid grid-cols-2 gap-4">
        <Field label={t('idLabel')} hint={t('idHint')}>
          <Input
            value={f.id}
            onChange={(e) => set('id', e.target.value)}
            placeholder="prod-k8s"
            autoComplete="off"
          />
        </Field>
        <Field label={t('versionLabel')} hint={t('versionHint')}>
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
            <Field label={t('addrLabel')} hint={t('addrHint')}>
              <Input
                value={f.addr}
                onChange={(e) => set('addr', e.target.value)}
                placeholder="http://nomad.internal:4646"
                autoComplete="off"
              />
            </Field>
            <Field label={t('runnerImageLabel')} hint={t('nomadImageHint')}>
              <Input
                value={f.image}
                onChange={(e) => set('image', e.target.value)}
                placeholder="ghcr.io/acme/agent:latest"
                autoComplete="off"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('namespaceLabel')}>
              <Input
                value={f.namespace}
                onChange={(e) => set('namespace', e.target.value)}
                placeholder="default"
                autoComplete="off"
              />
            </Field>
            <Field label={t('isolationRuntimeLabel')} hint={t('isolationRuntimeHint')}>
              <Input
                value={f.runtime}
                onChange={(e) => set('runtime', e.target.value)}
                placeholder="runsc"
                autoComplete="off"
              />
            </Field>
          </div>
          <Field label={t('datacentersLabel')} hint={t('commaSeparatedHint')}>
            <Input
              value={f.datacenters}
              onChange={(e) => set('datacenters', e.target.value)}
              placeholder="dc1, dc2"
              autoComplete="off"
            />
          </Field>
          <Field label={t('nomadAclSecretLabel')} hint={secretHint}>
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
            <Field label={t('runnerImageLabel')} hint={t('k8sImageHint')}>
              <Input
                value={f.image}
                onChange={(e) => set('image', e.target.value)}
                placeholder="ghcr.io/acme/agent:latest"
                autoComplete="off"
              />
            </Field>
            <Field label={t('namespaceLabel')}>
              <Input
                value={f.namespace}
                onChange={(e) => set('namespace', e.target.value)}
                placeholder="everdict"
                autoComplete="off"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('contextLabel')} hint={t('contextHint')}>
              <Input
                value={f.context}
                onChange={(e) => set('context', e.target.value)}
                placeholder="prod-cluster"
                autoComplete="off"
              />
            </Field>
            <Field label={t('runtimeClassLabel')} hint={t('runtimeClassHint')}>
              <Input
                value={f.runtimeClass}
                onChange={(e) => set('runtimeClass', e.target.value)}
                placeholder="gvisor"
                autoComplete="off"
              />
            </Field>
          </div>
          <Field label={t('apiServerLabel')} hint={t('apiServerHint')}>
            <Input
              value={f.server}
              onChange={(e) => set('server', e.target.value)}
              placeholder="https://k8s.acme.io:6443"
              autoComplete="off"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('k8sAuthSecretLabel')} hint={secretHint}>
              <Input
                value={f.authSecret}
                onChange={(e) => set('authSecret', e.target.value)}
                placeholder="k8s-token"
                autoComplete="off"
              />
            </Field>
            <Field label={t('kubeconfigSecretLabel')} hint={t('kubeconfigSecretHint')}>
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
          <span className="text-[13px] font-[510] text-foreground">{t('topologyToggle')}</span>
        </label>
        {f.supportsTopology && (
          <div className="space-y-4 pl-[26px]">
            <div className="grid grid-cols-2 gap-4">
              <Field label={t('traceSourceLabel')}>
                <Combobox
                  value={f.traceKind}
                  onChange={(v) => set('traceKind', v as 'otel' | 'mlflow')}
                  options={[
                    { value: 'otel', label: 'OTel' },
                    { value: 'mlflow', label: 'MLflow' },
                  ]}
                />
              </Field>
              <Field label={t('traceEndpointLabel')} hint={t('traceEndpointHint')}>
                <Input
                  value={f.traceEndpoint}
                  onChange={(e) => set('traceEndpoint', e.target.value)}
                  placeholder="http://mlflow.internal:5000"
                  autoComplete="off"
                />
              </Field>
            </div>
            <Field label={t('browserImageLabel')} hint={t('browserImageHint')}>
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
        <Field label={t('descriptionLabel')}>
          <Input
            value={f.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder={t('descriptionPlaceholder')}
            autoComplete="off"
          />
        </Field>
        <Field label={t('tagsLabel')} hint={t('commaSeparatedHint')}>
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
          {probe.reachable ? t('probeReachable') : t('probeUnreachable')}
          {probe.detail ? ` — ${probe.detail}` : ''}
        </Callout>
      )}
      {probe?.error && (
        <Callout tone="danger" className="py-1.5">
          {t('probeFailed', { error: probe.error })}
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
          {saving ? t('submitting') : t('submit')}
        </Button>
        {cluster && (
          <Button variant="secondary" onClick={onProbe} disabled={probing} className="gap-1.5">
            {probing ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
            {t('probe')}
          </Button>
        )}
        <Button variant="ghost" onClick={() => router.push(`/${workspace}/runtimes`)}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  )
}
