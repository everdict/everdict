'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/shared/ui/button'
import { Input, Label, Textarea } from '@/shared/ui/input'

import { importBenchmarkAction, type ImportBenchmarkResult } from '../api/import-benchmark'

// GET /benchmarks 항목(컨트롤플레인 카탈로그). source=huggingface 는 ID 인출, jsonl 은 파일 업로드 필요.
export interface BenchmarkCatalogItem {
  id: string
  category: string
  source: 'huggingface' | 'jsonl'
  gated: boolean
  defaultVersion: string
  description: string
}

export function ImportBenchmarkForm({ benchmarks }: { benchmarks: BenchmarkCatalogItem[] }) {
  const router = useRouter()
  const [benchmark, setBenchmark] = useState(benchmarks[0]?.id ?? '')
  const [datasetId, setDatasetId] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [limit, setLimit] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportBenchmarkResult>()

  const selected = useMemo(
    () => benchmarks.find((b) => b.id === benchmark),
    [benchmarks, benchmark]
  )
  const needsText = selected?.source === 'jsonl'

  async function onImport() {
    setBusy(true)
    setResult(undefined)
    const body: Record<string, unknown> = { benchmark, version }
    if (datasetId) body.id = datasetId
    if (limit && Number.isFinite(Number(limit))) body.limit = Number(limit)
    if (needsText) {
      if (!text.trim()) {
        setBusy(false)
        setResult({ ok: false, error: '이 벤치마크는 jsonl 파일 내용이 필요합니다.' })
        return
      }
      body.text = text
    }
    const res = await importBenchmarkAction(body)
    setBusy(false)
    setResult(res)
    if (res.ok) router.push('/dashboard/datasets')
  }

  if (benchmarks.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        사용 가능한 벤치마크가 없습니다(카탈로그 미설정).
      </p>
    )
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-1.5">
        <Label htmlFor="benchmark">벤치마크</Label>
        <select
          id="benchmark"
          value={benchmark}
          onChange={(e) => setBenchmark(e.target.value)}
          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
        >
          {benchmarks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.id} · {b.category}
              {b.gated ? ' · gated' : ''}
              {b.source === 'jsonl' ? ' · 파일 업로드' : ''}
            </option>
          ))}
        </select>
        {selected && <p className="text-xs text-muted-foreground">{selected.description}</p>}
      </div>

      {selected?.gated && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700">
          gated 벤치마크입니다 — 워크스페이스 시크릿 <code>HF_TOKEN</code> 이 있어야 인출됩니다.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="datasetId">데이터셋 id (선택)</Label>
          <Input
            id="datasetId"
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
            placeholder={benchmark || 'benchmark id'}
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

      {!needsText && (
        <div className="space-y-1.5">
          <Label htmlFor="limit">최대 케이스 수 (선택)</Label>
          <Input
            id="limit"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            placeholder="예: 50 (비우면 기본 100)"
            inputMode="numeric"
          />
          <p className="text-xs text-muted-foreground">
            HuggingFace 에서 ID 만으로 인출합니다(대형 벤치마크는 수천 건 — limit 로 일부만).
          </p>
        </div>
      )}

      {needsText && (
        <div className="space-y-1.5">
          <Label htmlFor="text">jsonl 내용</Label>
          <Textarea
            id="text"
            className="min-h-48 font-mono text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder='{"id":"ex--0","web":"https://example.com","ques":"...","answer":"...","web_name":"..."}'
          />
          <p className="text-xs text-muted-foreground">
            이 벤치마크는 jsonl 파일 내용을 붙여넣어야 합니다(한 줄 1케이스).
          </p>
        </div>
      )}

      {result && !result.ok && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          인입 실패: {result.error}
        </div>
      )}
      {result?.ok && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700">
          ✓ {result.id}@{result.version} · 케이스 {result.cases}건 등록됨
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        버전은 불변입니다 — 같은 (id, version)을 다른 내용으로 다시 인입하면 409 로 거부됩니다.
      </p>

      <Button type="button" onClick={onImport} disabled={busy || !benchmark}>
        {busy ? '인입 중…' : '워크스페이스에 추가'}
      </Button>
    </div>
  )
}
