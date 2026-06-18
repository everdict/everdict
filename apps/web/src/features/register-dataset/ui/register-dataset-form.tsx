'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/shared/ui/button'
import { Input, Label, Textarea } from '@/shared/ui/input'
import {
  type CreateDatasetResult,
  createDatasetAction,
  type ValidateDatasetResult,
  validateDatasetAction,
} from '../api/register-dataset'

// cases 입력 도움용 샘플(repo 빈 시드 케이스 1건).
const SAMPLE_CASES = `[
  {
    "id": "case-1",
    "env": { "kind": "repo", "source": { "files": {} } },
    "task": "create ok.txt with the text done",
    "graders": [{ "id": "steps" }, { "id": "cost" }]
  }
]`

export function RegisterDatasetForm() {
  const router = useRouter()
  const [id, setId] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [description, setDescription] = useState('')
  const [casesText, setCasesText] = useState(SAMPLE_CASES)
  const [result, setResult] = useState<ValidateDatasetResult>()
  const [createError, setCreateError] = useState<string>()
  const [busy, setBusy] = useState(false)

  // 폼 → 컨트롤플레인 Dataset 본문. cases 는 JSON 텍스트를 파싱(실패 시 호출부가 처리).
  function buildDataset(): unknown {
    return { id, version, ...(description ? { description } : {}), cases: JSON.parse(casesText), tags: [] }
  }

  async function onValidate() {
    setBusy(true)
    setCreateError(undefined)
    let body: unknown
    try {
      body = buildDataset()
    } catch {
      setBusy(false)
      setResult({ ok: false, error: 'cases JSON 파싱 실패' })
      return
    }
    setResult(await validateDatasetAction(body))
    setBusy(false)
  }

  async function onCreate() {
    setBusy(true)
    setCreateError(undefined)
    let body: unknown
    try {
      body = buildDataset()
    } catch {
      setBusy(false)
      setCreateError('cases JSON 파싱 실패')
      return
    }
    const res: CreateDatasetResult = await createDatasetAction(body)
    setBusy(false)
    if (res.ok) router.push('/dashboard/datasets')
    else setCreateError(res.error ?? '등록 실패')
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="id">id</Label>
          <Input id="id" value={id} onChange={(e) => setId(e.target.value)} placeholder="repo-smoke" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="version">version</Label>
          <Input id="version" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">설명 (선택)</Label>
        <Input
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="repo 평가용 스모크 케이스"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cases">케이스 (EvalCase[] JSON)</Label>
        <Textarea
          id="cases"
          className="min-h-72 font-mono text-xs"
          value={casesText}
          onChange={(e) => setCasesText(e.target.value)}
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">
          각 케이스는 id · env · task · graders 를 가집니다. 데이터셋은 하니스 무관 — 어느 하니스든 같은 케이스로 평가합니다.
        </p>
      </div>

      {result && <ValidateBanner result={result} />}
      {createError && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {createError}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        버전은 불변입니다 — 같은 (id, version)을 다른 내용으로 다시 등록하면 409 로 거부됩니다.
      </p>

      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={onValidate} disabled={busy}>
          {busy ? '…' : '검증 (dry-run)'}
        </Button>
        <Button type="button" onClick={onCreate} disabled={busy}>
          {busy ? '처리 중…' : '데이터셋 등록'}
        </Button>
      </div>
    </div>
  )
}

function ValidateBanner({ result }: { result: ValidateDatasetResult }) {
  if (result.error)
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        검증 호출 실패: {result.error}
      </div>
    )
  if (!result.ok)
    return (
      <div className="space-y-1 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        <div className="font-medium">스키마 오류</div>
        <ul className="list-disc pl-5">
          {result.errors?.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>
    )
  return (
    <div className="space-y-1 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm">
      <div className="font-medium text-emerald-700">
        ✓ 스키마 정상 · {result.id}@{result.version} · 케이스 {result.cases ?? 0}건{' '}
        {result.versionExists ? '(이미 존재)' : '(새 버전)'}
      </div>
      <div className="text-muted-foreground">
        기존 버전: {result.existingVersions && result.existingVersions.length > 0 ? result.existingVersions.join(', ') : '없음'}
        {result.versionExists && ' — 동일 내용이면 no-op, 다르면 409 로 거부됩니다.'}
      </div>
    </div>
  )
}
