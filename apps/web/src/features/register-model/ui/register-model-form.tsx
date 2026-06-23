'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label, Select } from '@/shared/ui/input'

import {
  createModelAction,
  validateModelAction,
  type CreateModelResult,
  type ValidateModelResult,
} from '../api/register-model'

// Model 등록 폼 — provider + 하부 모델 + 선택적 baseUrl/params. dry-run 검증 후 등록.
// 키는 등록하지 않는다(SecretStore 의 ANTHROPIC_API_KEY/OPENAI_API_KEY 를 provider 별로 사용).
export function RegisterModelForm() {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [id, setId] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [description, setDescription] = useState('')
  const [provider, setProvider] = useState('anthropic')
  const [model, setModel] = useState('claude-opus-4-8')
  const [baseUrl, setBaseUrl] = useState('')
  const [temperature, setTemperature] = useState('')
  const [maxTokens, setMaxTokens] = useState('')

  const [result, setResult] = useState<ValidateModelResult>()
  const [createError, setCreateError] = useState<string>()
  const [busy, setBusy] = useState(false)

  function buildSpec(): unknown {
    const params: Record<string, number> = {}
    if (temperature) params.temperature = Number(temperature)
    if (maxTokens) params.maxTokens = Number(maxTokens)
    return {
      id,
      version,
      ...(description ? { description } : {}),
      provider,
      model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(Object.keys(params).length ? { params } : {}),
      tags: [] as string[],
    }
  }

  async function onValidate() {
    setBusy(true)
    setCreateError(undefined)
    setResult(await validateModelAction(buildSpec()))
    setBusy(false)
  }

  async function onCreate() {
    setBusy(true)
    setCreateError(undefined)
    const res: CreateModelResult = await createModelAction(buildSpec())
    setBusy(false)
    if (res.ok) router.push(`/${workspace}/models`)
    else setCreateError(res.error ?? '등록 실패')
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="id">id</Label>
          <Input
            id="id"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="claude-opus-4-8"
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
          placeholder="Anthropic Claude Opus 4.8"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="provider">provider</Label>
          <Select id="provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="anthropic">anthropic</option>
            <option value="openai">openai</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="model">model (하부 식별자)</Label>
          <Input
            id="model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="claude-opus-4-8"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="baseUrl">baseUrl (선택 — OpenAI-호환 프록시/LiteLLM)</Label>
        <Input
          id="baseUrl"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://localhost:4000/v1"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="temperature">temperature (선택)</Label>
          <Input
            id="temperature"
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
            placeholder="0.2"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="maxTokens">maxTokens (선택)</Label>
          <Input
            id="maxTokens"
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
            placeholder="4096"
          />
        </div>
      </div>

      {result && <ValidateBanner result={result} />}
      {createError && <Callout tone="danger">{createError}</Callout>}

      <p className="text-[12px] text-muted-foreground">
        API 키는 등록하지 않습니다 — provider 별 시크릿(ANTHROPIC_API_KEY / OPENAI_API_KEY)을
        사용합니다. 버전은 불변입니다(같은 id@version 다른 내용 → 409).
      </p>

      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={onValidate} disabled={busy}>
          {busy ? '…' : '검증 (dry-run)'}
        </Button>
        <Button type="button" onClick={onCreate} disabled={busy}>
          {busy ? '처리 중…' : '모델 등록'}
        </Button>
      </div>
    </div>
  )
}

function ValidateBanner({ result }: { result: ValidateModelResult }) {
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
        ✓ 스키마 정상 · {result.provider} · {result.id}@{result.version}{' '}
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
