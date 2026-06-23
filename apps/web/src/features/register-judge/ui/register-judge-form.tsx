'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label, Select, Textarea } from '@/shared/ui/input'

import {
  createJudgeAction,
  validateJudgeAction,
  type CreateJudgeResult,
  type ValidateJudgeResult,
} from '../api/register-judge'

const INPUTS = ['trace', 'dom', 'screenshot'] as const

// Agent Judge 등록 폼 — kind(model | harness) 토글 + 조건부 필드. dry-run 검증 후 등록.
export function RegisterJudgeForm() {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [kind, setKind] = useState<'model' | 'harness'>('model')
  const [id, setId] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [description, setDescription] = useState('')
  // model 필드
  const [provider, setProvider] = useState('anthropic')
  const [model, setModel] = useState('claude-opus-4-8')
  const [rubric, setRubric] = useState('')
  const [inputs, setInputs] = useState<string[]>(['trace'])
  const [passThreshold, setPassThreshold] = useState('')
  // harness 필드
  const [harnessId, setHarnessId] = useState('')
  const [harnessVersion, setHarnessVersion] = useState('latest')

  const [result, setResult] = useState<ValidateJudgeResult>()
  const [createError, setCreateError] = useState<string>()
  const [busy, setBusy] = useState(false)

  function buildSpec(): unknown {
    const common = { id, version, ...(description ? { description } : {}), tags: [] as string[] }
    if (kind === 'model') {
      return {
        ...common,
        kind: 'model',
        provider,
        model,
        rubric,
        inputs,
        ...(passThreshold ? { passThreshold: Number(passThreshold) } : {}),
      }
    }
    return {
      ...common,
      kind: 'harness',
      harness: { id: harnessId, version: harnessVersion || 'latest' },
      ...(rubric ? { rubric } : {}),
    }
  }

  async function onValidate() {
    setBusy(true)
    setCreateError(undefined)
    setResult(await validateJudgeAction(buildSpec()))
    setBusy(false)
  }

  async function onCreate() {
    setBusy(true)
    setCreateError(undefined)
    const res: CreateJudgeResult = await createJudgeAction(buildSpec())
    setBusy(false)
    if (res.ok) router.push(`/${workspace}/judges`)
    else setCreateError(res.error ?? '등록 실패')
  }

  return (
    <div className="max-w-2xl space-y-5">
      {/* kind 토글 */}
      <div className="inline-flex rounded-lg border border-border bg-secondary/40 p-1 text-[13px]">
        {(['model', 'harness'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={cn(
              'flex-1 whitespace-nowrap rounded-md px-3 py-1.5 transition-colors',
              kind === k
                ? 'bg-card font-[510] text-foreground shadow-raise'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {k === 'model' ? 'model (LLM/VLM 호출)' : 'harness (에이전트 위임)'}
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
            placeholder="correctness"
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
          placeholder="트레이스로 정답 여부를 판정"
        />
      </div>

      {kind === 'model' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="provider">provider</Label>
              <Select id="provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="anthropic">anthropic</option>
                <option value="openai">openai</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="model">model</Label>
              <Input
                id="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="claude-opus-4-8"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rubric">rubric (판정 기준)</Label>
            <Textarea
              id="rubric"
              className="min-h-32"
              value={rubric}
              onChange={(e) => setRubric(e.target.value)}
              placeholder="Did the agent correctly complete the task? Judge from the trace."
            />
          </div>
          <div className="space-y-1.5">
            <Label>입력 모달리티</Label>
            <div className="flex gap-4 text-[13px]">
              {INPUTS.map((o) => (
                <label key={o} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={inputs.includes(o)}
                    onChange={(e) =>
                      setInputs(e.target.checked ? [...inputs, o] : inputs.filter((x) => x !== o))
                    }
                    className="accent-primary"
                  />
                  {o}
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="passThreshold">pass 임계값 (선택, 0–1)</Label>
            <Input
              id="passThreshold"
              value={passThreshold}
              onChange={(e) => setPassThreshold(e.target.value)}
              placeholder="0.7"
            />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="harnessId">harness id</Label>
              <Input
                id="harnessId"
                value={harnessId}
                onChange={(e) => setHarnessId(e.target.value)}
                placeholder="claude-code"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="harnessVersion">harness version</Label>
              <Input
                id="harnessVersion"
                value={harnessVersion}
                onChange={(e) => setHarnessVersion(e.target.value)}
                placeholder="latest"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hrubric">rubric (선택)</Label>
            <Textarea
              id="hrubric"
              className="min-h-24"
              value={rubric}
              onChange={(e) => setRubric(e.target.value)}
              placeholder="Review the trace for correctness and safety."
            />
          </div>
        </div>
      )}

      {result && <ValidateBanner result={result} />}
      {createError && <Callout tone="danger">{createError}</Callout>}

      <p className="text-[12px] text-muted-foreground">
        버전은 불변입니다 — 같은 (id, version)을 다른 내용으로 다시 등록하면 409 로 거부됩니다.
      </p>

      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={onValidate} disabled={busy}>
          {busy ? '…' : '검증 (dry-run)'}
        </Button>
        <Button type="button" onClick={onCreate} disabled={busy}>
          {busy ? '처리 중…' : 'Judge 등록'}
        </Button>
      </div>
    </div>
  )
}

function ValidateBanner({ result }: { result: ValidateJudgeResult }) {
  if (result.error) return <Callout tone="danger">검증 호출 실패: {result.error}</Callout>
  if (!result.ok)
    return (
      <Callout tone="danger">
        <div className="font-[510]">스키마 오류</div>
        <ul className="mt-1 list-disc pl-5">
          {result.errors?.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </Callout>
    )
  return (
    <Callout tone="info">
      <div className="font-[510]">
        ✓ 스키마 정상 · {result.kind} · {result.id}@{result.version}{' '}
        {result.versionExists ? '(이미 존재)' : '(새 버전)'}
      </div>
      <div className="mt-1 text-muted-foreground">
        기존 버전:{' '}
        {result.existingVersions && result.existingVersions.length > 0
          ? result.existingVersions.join(', ')
          : '없음'}
        {result.versionExists && ' — 동일 내용이면 no-op, 다르면 409 로 거부됩니다.'}
      </div>
    </Callout>
  )
}
