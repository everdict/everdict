'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label, Select } from '@/shared/ui/input'

import {
  createMetricAction,
  validateMetricAction,
  type CreateMetricResult,
  type ValidateMetricResult,
} from '../api/register-metric'

// 자주 쓰는 source 힌트(trace 파생 + judge). 임의 입력도 가능(datalist).
const SOURCES = [
  { v: 'usd', d: '케이스당 LLM 비용($)' },
  { v: 'tool_calls', d: '툴 호출 수(steps)' },
  { v: 'span', d: '지연(ms)' },
  { v: 'judge', d: 'judge 점수' },
]
const OPS: { v: string; d: string }[] = [
  { v: 'lte', d: '≤ 이하' },
  { v: 'gte', d: '≥ 이상' },
  { v: 'lt', d: '< 미만' },
  { v: 'gt', d: '> 초과' },
  { v: 'eq', d: '= 같음' },
]

// Metric(threshold) 등록 폼 — 이미 산출된 메트릭(source) 위에 op·threshold 합격규칙. dry-run 검증 후 등록.
export function RegisterMetricForm() {
  const router = useRouter()
  const [id, setId] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [description, setDescription] = useState('')
  const [source, setSource] = useState('usd')
  const [op, setOp] = useState('lte')
  const [threshold, setThreshold] = useState('')
  const [metric, setMetric] = useState('')

  const [result, setResult] = useState<ValidateMetricResult>()
  const [createError, setCreateError] = useState<string>()
  const [busy, setBusy] = useState(false)

  function buildSpec(): unknown {
    return {
      kind: 'threshold',
      id,
      version,
      ...(description ? { description } : {}),
      source,
      op,
      threshold: Number(threshold),
      ...(metric ? { metric } : {}),
      tags: [] as string[],
    }
  }

  async function onValidate() {
    setBusy(true)
    setCreateError(undefined)
    setResult(await validateMetricAction(buildSpec()))
    setBusy(false)
  }

  async function onCreate() {
    setBusy(true)
    setCreateError(undefined)
    const res: CreateMetricResult = await createMetricAction(buildSpec())
    setBusy(false)
    if (res.ok) router.push('/dashboard/metrics')
    else setCreateError(res.error ?? '등록 실패')
  }

  const opLabel = OPS.find((o) => o.v === op)?.d.split(' ')[0] ?? op

  return (
    <div className="max-w-2xl space-y-6">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="id">id</Label>
          <Input
            id="id"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="cost-budget"
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
          placeholder="케이스당 LLM 비용이 $0.50 이하면 pass"
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="source">source (대상 메트릭)</Label>
          <Input
            id="source"
            list="metric-sources"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <datalist id="metric-sources">
            {SOURCES.map((s) => (
              <option key={s.v} value={s.v}>
                {s.d}
              </option>
            ))}
          </datalist>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="op">op</Label>
          <Select id="op" value={op} onChange={(e) => setOp(e.target.value)}>
            {OPS.map((o) => (
              <option key={o.v} value={o.v}>
                {o.d}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="threshold">threshold</Label>
          <Input
            id="threshold"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            placeholder="0.5"
          />
        </div>
      </div>

      <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-muted-foreground">
        규칙: {source || '<source>'} {opLabel} {threshold || '<threshold>'} → pass
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="metric">산출 메트릭 이름 (선택, 기본 = id)</Label>
        <Input
          id="metric"
          value={metric}
          onChange={(e) => setMetric(e.target.value)}
          placeholder="quality"
        />
      </div>

      {result && <ValidateBanner result={result} />}
      {createError && <Callout tone="danger">{createError}</Callout>}

      <p className="text-xs text-muted-foreground">
        스코어카드 실행/인제스트 시 이 메트릭을 선택하면 run 후 결과 점수 위에 적용됩니다. 버전은
        불변(같은 id@version 다른 내용 → 409).
      </p>

      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={onValidate} disabled={busy}>
          {busy ? '…' : '검증 (dry-run)'}
        </Button>
        <Button type="button" onClick={onCreate} disabled={busy}>
          {busy ? '처리 중…' : '메트릭 등록'}
        </Button>
      </div>
    </div>
  )
}

function ValidateBanner({ result }: { result: ValidateMetricResult }) {
  if (result.error) return <Callout tone="danger">검증 호출 실패: {result.error}</Callout>
  if (!result.ok)
    return (
      <Callout tone="danger">
        <div className="font-medium">스키마 오류</div>
        <ul className="mt-1 list-disc pl-5">
          {result.errors?.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </Callout>
    )
  return (
    <Callout tone="info">
      <div className="font-medium">
        ✓ 스키마 정상 · {result.kind} · {result.id}@{result.version}{' '}
        {result.versionExists ? '(이미 존재)' : '(새 버전)'}
      </div>
      <div className="mt-1 text-muted-foreground">
        기존 버전:{' '}
        {result.existingVersions && result.existingVersions.length > 0
          ? result.existingVersions.join(', ')
          : '없음'}
      </div>
    </Callout>
  )
}
