'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Label, Textarea } from '@/shared/ui/input'

import {
  registerRecipeAction,
  validateRecipeAction,
  type RegisterRecipeResult,
  type ValidateRecipeResult,
} from '../api/register-recipe'

// 레시피 = BenchmarkAdapterSpec(데이터): source(HF/jsonl) + mapping(필드→EvalCase) + graderTemplates({field} 보간).
const SAMPLE = `{
  "id": "my-bench",
  "version": "1.0.0",
  "category": "qa",
  "description": "내 워크스페이스 벤치마크",
  "source": { "kind": "huggingface", "dataset": "openai/gsm8k", "config": "main", "split": "test" },
  "mapping": { "idField": "id", "taskField": "question", "answerField": "answer" }
}`

export function RegisterRecipeForm() {
  const router = useRouter()
  const [text, setText] = useState(SAMPLE)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RegisterRecipeResult>()
  const [validation, setValidation] = useState<ValidateRecipeResult>()

  function parse(): unknown | undefined {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }

  async function onValidate() {
    setBusy(true)
    setResult(undefined)
    const spec = parse()
    if (spec === undefined) {
      setBusy(false)
      setValidation({ ok: false, error: 'JSON 파싱 실패' })
      return
    }
    setValidation(await validateRecipeAction(spec))
    setBusy(false)
  }

  async function onRegister() {
    setBusy(true)
    setResult(undefined)
    const spec = parse()
    if (spec === undefined) {
      setBusy(false)
      setResult({ ok: false, error: 'JSON 파싱 실패' })
      return
    }
    const res = await registerRecipeAction(spec)
    setBusy(false)
    setResult(res)
    if (res.ok) router.refresh()
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="spec">레시피 (BenchmarkAdapterSpec JSON)</Label>
        <Textarea
          id="spec"
          className="min-h-72 text-[12px]"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          source(huggingface/jsonl) + mapping(필드→EvalCase) + 선택적 graderTemplates(
          <code>{'{field}'}</code> 보간). 버전은 불변입니다 — 같은 (id, version)을 다른 내용으로
          다시 등록하면 409.
        </p>
      </div>

      {validation && <ValidateBanner v={validation} />}
      {result && !result.ok && <Callout tone="danger">등록 실패: {result.error}</Callout>}
      {result?.ok && (
        <Callout tone="info">
          ✓ 레시피 등록됨 · {result.id}@{result.version}
        </Callout>
      )}

      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={onValidate} disabled={busy}>
          {busy ? '…' : '검증 (dry-run)'}
        </Button>
        <Button type="button" onClick={onRegister} disabled={busy}>
          {busy ? '등록 중…' : '레시피 등록'}
        </Button>
      </div>
    </div>
  )
}

function ValidateBanner({ v }: { v: ValidateRecipeResult }) {
  if (v.error) return <Callout tone="danger">검증 호출 실패: {v.error}</Callout>
  if (!v.ok)
    return (
      <Callout tone="danger">
        <div className="font-[510]">스키마 오류</div>
        <ul className="mt-1 list-disc pl-5">
          {v.errors?.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </Callout>
    )
  return (
    <Callout tone="info">
      <div className="font-medium">
        ✓ 스키마 정상 · {v.id}@{v.version} · source={v.source} · graderTemplates{' '}
        {v.graderTemplates ?? 0} {v.versionExists ? '(이미 존재)' : '(새 버전)'}
      </div>
      <div className="mt-1 text-muted-foreground">
        기존 버전:{' '}
        {v.existingVersions && v.existingVersions.length > 0
          ? v.existingVersions.join(', ')
          : '없음'}
        {v.versionExists && ' — 동일 내용이면 no-op, 다르면 409 로 거부됩니다.'}
      </div>
    </Callout>
  )
}
