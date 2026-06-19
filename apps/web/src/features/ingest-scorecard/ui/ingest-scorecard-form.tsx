'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/shared/ui/button'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { type IngestScorecardResult, ingestScorecardAction } from '../api/ingest-scorecard'

const SAMPLE = `[
  {
    "caseId": "case-1",
    "trace": [
      { "t": 0, "kind": "message", "role": "user", "text": "create ok.txt" },
      { "t": 1, "kind": "tool_call", "id": "1", "name": "bash", "args": { "cmd": "echo done > ok.txt" } },
      { "t": 2, "kind": "tool_result", "id": "1", "ok": true, "output": "" },
      { "t": 3, "kind": "llm_call", "model": "gpt-5.4-mini", "cost": { "inputTokens": 120, "outputTokens": 30, "usd": 0.001 } }
    ]
  }
]`

// 외부에서 이미 수행한 트레이스를 업로드해 scorecard 로. dataset/judge 는 선택, traces 는 TraceEvent[] JSON.
export function IngestScorecardForm({ datasets, judges }: { datasets: { id: string }[]; judges: { id: string }[] }) {
  const router = useRouter()
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? '')
  const [datasetVersion, setDatasetVersion] = useState('latest')
  const [harnessId, setHarnessId] = useState('')
  const [harnessVersion, setHarnessVersion] = useState('external')
  const [judgeIds, setJudgeIds] = useState<string[]>([])
  const [tracesJson, setTracesJson] = useState(SAMPLE)
  const [serverError, setServerError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function onSubmit() {
    setBusy(true)
    setServerError(undefined)
    const res: IngestScorecardResult = await ingestScorecardAction({
      datasetId,
      datasetVersion,
      harnessId,
      harnessVersion,
      judgeIds,
      tracesJson,
    })
    setBusy(false)
    if (res.ok && res.id) router.push(`/dashboard/scorecards/${res.id}`)
    else setServerError(res.error ?? '인제스트 실패')
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="datasetId">데이터셋 (caseId 정렬용)</Label>
          <Input id="datasetId" list="ds-ids" value={datasetId} onChange={(e) => setDatasetId(e.target.value)} placeholder="repo-smoke" />
          <datalist id="ds-ids">
            {datasets.map((d) => (
              <option key={d.id} value={d.id} />
            ))}
          </datalist>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="datasetVersion">버전</Label>
          <Input id="datasetVersion" value={datasetVersion} onChange={(e) => setDatasetVersion(e.target.value)} placeholder="latest" />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="harnessId">하니스 (트레이스를 만든 주체, 라벨)</Label>
          <Input id="harnessId" value={harnessId} onChange={(e) => setHarnessId(e.target.value)} placeholder="my-external-agent" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="harnessVersion">버전</Label>
          <Input id="harnessVersion" value={harnessVersion} onChange={(e) => setHarnessVersion(e.target.value)} placeholder="external" />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="traces">트레이스 (`[{'{'} caseId, trace: TraceEvent[] {'}'}]` JSON)</Label>
        <Textarea
          id="traces"
          className="min-h-72 font-mono text-xs"
          value={tracesJson}
          onChange={(e) => setTracesJson(e.target.value)}
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">
          caseId 는 데이터셋의 케이스와 맞춰주세요(없는 caseId 는 스킵). 트레이스에서 tool_calls/usd/span 이 자동 재도출됩니다.
        </p>
      </div>

      {judges.length > 0 && (
        <div className="space-y-1.5">
          <Label>Agent Judge (선택 — 업로드된 트레이스에 적용)</Label>
          <div className="flex flex-wrap gap-3 rounded-xl border p-3 text-sm">
            {judges.map((j) => (
              <label key={j.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={judgeIds.includes(j.id)}
                  onChange={(e) => setJudgeIds(e.target.checked ? [...judgeIds, j.id] : judgeIds.filter((x) => x !== j.id))}
                />
                {j.id}
              </label>
            ))}
          </div>
        </div>
      )}

      {serverError && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {serverError}
        </div>
      )}

      <Button type="button" onClick={onSubmit} disabled={busy}>
        {busy ? '인제스트 중…' : '트레이스 인제스트'}
      </Button>
    </div>
  )
}
