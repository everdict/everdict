'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

import { versionsForId } from '@/shared/lib/semver'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { VersionField } from '@/shared/ui/version-field'

import {
  createDatasetAction,
  validateDatasetAction,
  type CreateDatasetResult,
  type ValidateDatasetResult,
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

// 상세의 "새 버전 만들기"가 기존 버전 내용을 흘려넣는 프리필 — 버전 불변이라 수정 = 새 버전.
export interface DatasetPrefill {
  id: string
  description?: string
  tags?: string[]
  casesText: string
}

export function RegisterDatasetForm({
  existingDatasets = [],
  prefill,
  lockId = false,
}: {
  existingDatasets?: { id: string; versions: string[] }[]
  prefill?: DatasetPrefill
  lockId?: boolean
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [id, setId] = useState(prefill?.id ?? '')
  const [version, setVersion] = useState('1.0.0')
  const existing = versionsForId(existingDatasets, id)
  const [description, setDescription] = useState(prefill?.description ?? '')
  const [tagsText, setTagsText] = useState((prefill?.tags ?? []).join(', '))
  const [casesText, setCasesText] = useState(prefill?.casesText ?? SAMPLE_CASES)
  const [result, setResult] = useState<ValidateDatasetResult>()
  const [createError, setCreateError] = useState<string>()
  const [busy, setBusy] = useState(false)

  // 폼 → 컨트롤플레인 Dataset 본문. cases 는 JSON 텍스트를 파싱(실패 시 호출부가 처리).
  function buildDataset(): unknown {
    return {
      id,
      version,
      ...(description ? { description } : {}),
      cases: JSON.parse(casesText),
      tags: tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    }
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
    // 액션 전송 자체가 실패(본문 크기 초과 등)해도 busy 가 풀리도록 방어.
    try {
      setResult(await validateDatasetAction(body))
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
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
    let res: CreateDatasetResult
    try {
      res = await createDatasetAction(body)
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    setBusy(false)
    if (res.ok) {
      // 새 버전 배포(프리필 진입)면 그 데이터셋 상세로 복귀 — 방금 배포한 버전이 곧 latest.
      if (lockId) router.push(`/${workspace}/datasets/${encodeURIComponent(id)}`)
      else router.push(`/${workspace}/datasets`)
    } else setCreateError(res.error ?? '등록 실패')
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="id">id</Label>
        <Input
          id="id"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="repo-smoke"
          readOnly={lockId}
          className={cn(lockId && 'opacity-60')}
        />
      </div>
      <VersionField existing={existing} value={version} onChange={setVersion} />

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
        <Label htmlFor="tags">태그 (선택 — 콤마 구분)</Label>
        <Input
          id="tags"
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="coding, smoke"
        />
        <p className="text-[12px] text-muted-foreground">
          목록에서 카테고리 필터로 써요 (예: coding, browser, qa).
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cases">케이스 (EvalCase[] JSON)</Label>
        <Textarea
          id="cases"
          className="min-h-72 text-[12px]"
          value={casesText}
          onChange={(e) => setCasesText(e.target.value)}
          spellCheck={false}
        />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          각 케이스는 id · env · task · graders 로 이뤄져요. 어떤 하니스든 같은 케이스로 평가해요.
        </p>
      </div>

      {result && <ValidateBanner result={result} />}
      {createError && <Callout tone="danger">{createError}</Callout>}

      <p className="text-[12px] leading-relaxed text-muted-foreground">
        버전은 바꿀 수 없어요. 같은 버전을 다른 내용으로 다시 올리면 등록되지 않아요.
      </p>

      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={onValidate} disabled={busy}>
          {busy ? '…' : '검증하기'}
        </Button>
        <Button type="button" onClick={onCreate} disabled={busy}>
          {busy ? '처리 중…' : lockId ? '새 버전 올리기' : '데이터셋 등록'}
        </Button>
      </div>
    </div>
  )
}

function ValidateBanner({ result }: { result: ValidateDatasetResult }) {
  if (result.error) return <Callout tone="danger">검증하지 못했어요: {result.error}</Callout>
  if (!result.ok)
    return (
      <Callout tone="danger">
        <div className="font-[510]">형식 오류</div>
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
        ✓ 형식 정상 · {result.id}@{result.version} · 케이스 {result.cases ?? 0}건{' '}
        {result.versionExists ? '(이미 존재)' : '(새 버전)'}
      </div>
      <div className="mt-1 text-muted-foreground">
        기존 버전:{' '}
        {result.existingVersions && result.existingVersions.length > 0
          ? result.existingVersions.join(', ')
          : '없음'}
        {result.versionExists && ' — 내용이 같으면 그대로 두고, 다르면 등록되지 않아요.'}
      </div>
    </Callout>
  )
}
