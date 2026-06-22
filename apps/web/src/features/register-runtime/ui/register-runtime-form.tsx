'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'

import {
  createRuntimeAction,
  probeRuntimeAction,
  validateRuntimeAction,
  type CreateRuntimeResult,
  type ProbeRuntimeResult,
  type ValidateRuntimeResult,
} from '../api/register-runtime'

// Runtime(실행 인프라) 등록 폼 — kind(local | nomad | k8s) 토글 + 조건부 필드. 자격증명(토큰/kubeconfig)은 여기 아님 → SecretStore.
export function RegisterRuntimeForm() {
  const router = useRouter()
  const [kind, setKind] = useState<'local' | 'nomad' | 'k8s'>('local')
  const [id, setId] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [description, setDescription] = useState('')
  const [image, setImage] = useState('')
  const [namespace, setNamespace] = useState('')
  // nomad
  const [addr, setAddr] = useState('')
  const [runtime, setRuntime] = useState('')
  const [datacenters, setDatacenters] = useState('')
  // k8s
  const [context, setContext] = useState('')
  const [runtimeClass, setRuntimeClass] = useState('')
  const [server, setServer] = useState('')
  // 클러스터 API 인증 자격증명의 SecretStore '키 이름'(값 아님). 값은 워크스페이스 시크릿에 따로 저장.
  const [authSecret, setAuthSecret] = useState('')
  const [kubeconfigSecret, setKubeconfigSecret] = useState('')

  const [result, setResult] = useState<ValidateRuntimeResult>()
  const [probe, setProbe] = useState<ProbeRuntimeResult>()
  const [createError, setCreateError] = useState<string>()
  const [busy, setBusy] = useState(false)

  function buildSpec(): unknown {
    const common = { id, version, ...(description ? { description } : {}), tags: [] as string[] }
    if (kind === 'local') return { ...common, kind: 'local' }
    if (kind === 'nomad') {
      return {
        ...common,
        kind: 'nomad',
        addr,
        image,
        ...(runtime ? { runtime } : {}),
        ...(namespace ? { namespace } : {}),
        ...(authSecret ? { authSecret } : {}),
        ...(datacenters
          ? {
              datacenters: datacenters
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : {}),
      }
    }
    return {
      ...common,
      kind: 'k8s',
      image,
      ...(context ? { context } : {}),
      ...(namespace ? { namespace } : {}),
      ...(runtimeClass ? { runtimeClass } : {}),
      ...(server ? { server } : {}),
      ...(authSecret ? { authSecret } : {}),
      ...(kubeconfigSecret ? { kubeconfigSecret } : {}),
    }
  }

  async function onValidate() {
    setBusy(true)
    setCreateError(undefined)
    setResult(await validateRuntimeAction(buildSpec()))
    setBusy(false)
  }

  async function onProbe() {
    setBusy(true)
    setCreateError(undefined)
    setProbe(undefined)
    setProbe(await probeRuntimeAction(buildSpec()))
    setBusy(false)
  }

  async function onCreate() {
    setBusy(true)
    setCreateError(undefined)
    const res: CreateRuntimeResult = await createRuntimeAction(buildSpec())
    setBusy(false)
    if (res.ok) router.push('/dashboard/runtimes')
    else setCreateError(res.error ?? '등록 실패')
  }

  return (
    <div className="max-w-2xl space-y-5">
      {/* kind 토글 */}
      <div className="inline-flex rounded-md border border-border bg-secondary/50 p-0.5 text-[13px]">
        {(['local', 'nomad', 'k8s'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={cn(
              'rounded px-3 py-1 font-[510] transition-colors',
              kind === k
                ? 'bg-card text-foreground shadow-raise'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {k}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="id">id</Label>
          <Input
            id="id"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="seoul-nomad"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="version">version</Label>
          <Input
            id="version"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="1.0.0"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">설명 (선택)</Label>
        <Input
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="서울 Nomad 클러스터"
        />
      </div>

      {kind === 'nomad' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="addr">addr</Label>
              <Input
                id="addr"
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                placeholder="http://nomad:4646"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="image">image</Label>
              <Input
                id="image"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="ghcr.io/acme/agent:1"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="runtime">runtime</Label>
              <Input
                id="runtime"
                value={runtime}
                onChange={(e) => setRuntime(e.target.value)}
                placeholder="runsc"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="namespace">namespace</Label>
              <Input
                id="namespace"
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                placeholder="default"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dcs">datacenters</Label>
              <Input
                id="dcs"
                value={datacenters}
                onChange={(e) => setDatacenters(e.target.value)}
                placeholder="dc1, dc2"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nomad-authsecret">authSecret (ACL 토큰 시크릿 이름, 선택)</Label>
            <Input
              id="nomad-authsecret"
              value={authSecret}
              onChange={(e) => setAuthSecret(e.target.value.toUpperCase())}
              placeholder="NOMAD_TOKEN"
            />
          </div>
        </div>
      )}

      {kind === 'k8s' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="image">image</Label>
              <Input
                id="image"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="ghcr.io/acme/agent:1"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="context">context</Label>
              <Input
                id="context"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder="kind-assay"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="namespace">namespace</Label>
              <Input
                id="namespace"
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                placeholder="default"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rc">runtimeClass</Label>
              <Input
                id="rc"
                value={runtimeClass}
                onChange={(e) => setRuntimeClass(e.target.value)}
                placeholder="gvisor"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="k8s-server">server (외부 API 서버 URL, 선택)</Label>
            <Input
              id="k8s-server"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="https://k8s.acme.internal:6443"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="k8s-authsecret">authSecret (bearer 토큰 시크릿 이름, 선택)</Label>
              <Input
                id="k8s-authsecret"
                value={authSecret}
                onChange={(e) => setAuthSecret(e.target.value.toUpperCase())}
                placeholder="KUBE_TOKEN"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="k8s-kubeconfig">
                kubeconfigSecret (kubeconfig 시크릿 이름, 선택)
              </Label>
              <Input
                id="k8s-kubeconfig"
                value={kubeconfigSecret}
                onChange={(e) => setKubeconfigSecret(e.target.value.toUpperCase())}
                placeholder="KUBECONFIG_PROD"
              />
            </div>
          </div>
          <Callout tone="muted" className="text-[12px]">
            인증 우선순위: kubeconfigSecret &gt; (server + authSecret) &gt; context.
            exec-plugin/client-cert 클러스터(EKS/GKE)는 전체 kubeconfig 를 시크릿으로 저장해
            kubeconfigSecret 로 참조하세요. 토큰·kubeconfig '값'은 클러스터 자격증명 탭(워크스페이스
            설정)에서 저장하고, 여기엔 그 '이름'만 적습니다.
          </Callout>
        </div>
      )}

      {kind === 'local' && (
        <Callout tone="muted">
          local 런타임은 컨트롤플레인 호스트에서 in-process 로 실행합니다(dev/단일 머신). 추가
          설정이 없습니다.
        </Callout>
      )}

      <p className="text-[12px] text-muted-foreground">
        토큰·kubeconfig 같은 자격증명은 여기 넣지 않습니다 — 워크스페이스 시크릿(예:
        NOMAD_TOKEN)으로 관리되고 실행 시 주입됩니다.
      </p>

      {result && <ValidateBanner result={result} />}
      {probe && <ProbeBanner probe={probe} />}
      {createError && <Callout tone="danger">{createError}</Callout>}

      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={onValidate} disabled={busy}>
          {busy ? '…' : '검증 (dry-run)'}
        </Button>
        {kind !== 'local' && (
          <Button type="button" variant="outline" onClick={onProbe} disabled={busy}>
            {busy ? '…' : '연결 테스트'}
          </Button>
        )}
        <Button type="button" onClick={onCreate} disabled={busy}>
          {busy ? '처리 중…' : 'Runtime 등록'}
        </Button>
      </div>
    </div>
  )
}

// 연결 테스트 결과 — 잡 없이 실제 클러스터에 붙어본 결과(도달성/인증).
function ProbeBanner({ probe }: { probe: ProbeRuntimeResult }) {
  if (probe.error) return <Callout tone="danger">연결 테스트 호출 실패: {probe.error}</Callout>
  if (probe.reachable)
    return (
      <Callout tone="info">
        <span className="font-[560]">✓ 연결 성공{probe.kind ? ` · ${probe.kind}` : ''}</span>
        {probe.detail ? <span className="ml-1 text-muted-foreground">— {probe.detail}</span> : null}
      </Callout>
    )
  return (
    <Callout tone="danger">
      <div className="font-[560]">✗ 연결 실패{probe.kind ? ` · ${probe.kind}` : ''}</div>
      {probe.detail ? <div className="mt-1 font-mono text-[12px]">{probe.detail}</div> : null}
    </Callout>
  )
}

function ValidateBanner({ result }: { result: ValidateRuntimeResult }) {
  if (result.error) return <Callout tone="danger">검증 호출 실패: {result.error}</Callout>
  if (!result.ok)
    return (
      <Callout tone="danger">
        <div className="font-[560]">스키마 오류</div>
        <ul className="mt-1 list-disc pl-5">
          {result.errors?.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </Callout>
    )
  const missing = result.missingSecrets ?? []
  return (
    <div className="space-y-2">
      <Callout tone="info">
        <span className="font-[560]">
          ✓ 스키마 정상 · {result.kind} · {result.id}@{result.version}{' '}
          {result.versionExists ? '(이미 존재)' : '(새 버전)'}
        </span>
      </Callout>
      {missing.length > 0 && (
        <Callout
          tone="warning"
          hint="등록은 가능하지만, 실행 전에 이 시크릿들을 워크스페이스 설정 → 클러스터 자격증명에서 저장해야 합니다."
        >
          참조한 시크릿이 아직 없습니다: <span className="font-mono">{missing.join(', ')}</span>
        </Callout>
      )}
    </div>
  )
}
