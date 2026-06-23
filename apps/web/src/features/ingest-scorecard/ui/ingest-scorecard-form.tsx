'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label, Select, Textarea } from '@/shared/ui/input'

import {
  ingestScorecardAction,
  pullScorecardAction,
  type IngestScorecardResult,
} from '../api/ingest-scorecard'

const SAMPLE_TRACES = `[
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

const SAMPLE_RUNS = `[
  { "caseId": "case-1", "runId": "trace-abc-123" }
]`

type Mode = 'push' | 'pull'

// 트레이스 인제스트 — push(업로드한 TraceEvent[]) | pull(테넌트 OTel/MLflow 에서 runId 로 당겨오기) 두 모드.
// dataset/judge/harness 라벨은 공통. push 는 traces JSON, pull 은 source + runs JSON.
export function IngestScorecardForm({
  datasets,
  judges,
}: {
  datasets: { id: string }[]
  judges: { id: string }[]
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [mode, setMode] = useState<Mode>('push')
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? '')
  const [datasetVersion, setDatasetVersion] = useState('latest')
  const [harnessId, setHarnessId] = useState('')
  const [harnessVersion, setHarnessVersion] = useState('external')
  const [judgeIds, setJudgeIds] = useState<string[]>([])
  const [tracesJson, setTracesJson] = useState(SAMPLE_TRACES)
  // pull 모드 전용
  const [sourceKind, setSourceKind] = useState<'otel' | 'mlflow'>('otel')
  const [endpoint, setEndpoint] = useState('')
  const [authSecret, setAuthSecret] = useState('')
  const [runsJson, setRunsJson] = useState(SAMPLE_RUNS)
  const [serverError, setServerError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function onSubmit() {
    setBusy(true)
    setServerError(undefined)
    const res: IngestScorecardResult =
      mode === 'push'
        ? await ingestScorecardAction({
            datasetId,
            datasetVersion,
            harnessId,
            harnessVersion,
            judgeIds,
            tracesJson,
          })
        : await pullScorecardAction({
            datasetId,
            datasetVersion,
            harnessId,
            harnessVersion,
            judgeIds,
            sourceKind,
            endpoint,
            authSecret,
            runsJson,
          })
    setBusy(false)
    if (res.ok && res.id) router.push(`/${workspace}/scorecards/${res.id}`)
    else setServerError(res.error ?? '인제스트 실패')
  }

  return (
    <div className="max-w-2xl space-y-4">
      {/* 모드 토글 */}
      <div className="inline-flex rounded-lg border border-border bg-secondary/40 p-1 text-[13px]">
        {(['push', 'pull'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              'rounded-md px-3.5 py-1.5 font-[510] transition-colors',
              mode === m
                ? 'bg-card text-foreground shadow-raise'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {m === 'push' ? '업로드 (push)' : '소스에서 당겨오기 (pull)'}
          </button>
        ))}
      </div>
      <p className="text-[12px] text-muted-foreground">
        {mode === 'push'
          ? '이미 가진 TraceEvent[] 를 직접 올립니다.'
          : '테넌트 OTel/MLflow 에서 runId 별로 트레이스를 당겨옵니다. 자격증명은 워크스페이스 시크릿 이름으로 지정합니다(평문 금지).'}
      </p>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="datasetId">데이터셋 (caseId 정렬용)</Label>
          <Input
            id="datasetId"
            list="ds-ids"
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
            placeholder="repo-smoke"
          />
          <datalist id="ds-ids">
            {datasets.map((d) => (
              <option key={d.id} value={d.id} />
            ))}
          </datalist>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="datasetVersion">버전</Label>
          <Input
            id="datasetVersion"
            value={datasetVersion}
            onChange={(e) => setDatasetVersion(e.target.value)}
            placeholder="latest"
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="harnessId">하니스 (트레이스를 만든 주체, 라벨)</Label>
          <Input
            id="harnessId"
            value={harnessId}
            onChange={(e) => setHarnessId(e.target.value)}
            placeholder="my-external-agent"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="harnessVersion">버전</Label>
          <Input
            id="harnessVersion"
            value={harnessVersion}
            onChange={(e) => setHarnessVersion(e.target.value)}
            placeholder="external"
          />
        </div>
      </div>

      {mode === 'push' ? (
        <div className="space-y-1.5">
          <Label htmlFor="traces">
            트레이스 (`[{'{'} caseId, trace: TraceEvent[] {'}'}]` JSON)
          </Label>
          <Textarea
            id="traces"
            className="min-h-72 font-mono text-[12px]"
            value={tracesJson}
            onChange={(e) => setTracesJson(e.target.value)}
            spellCheck={false}
          />
          <p className="text-[12px] text-muted-foreground">
            caseId 는 데이터셋의 케이스와 맞춰주세요(없는 caseId 는 스킵). 트레이스에서
            tool_calls/usd/span 이 자동 재도출됩니다.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sourceKind">소스 종류</Label>
              <Select
                id="sourceKind"
                value={sourceKind}
                onChange={(e) => setSourceKind(e.target.value === 'mlflow' ? 'mlflow' : 'otel')}
              >
                <option value="otel">OTel</option>
                <option value="mlflow">MLflow</option>
              </Select>
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="endpoint">엔드포인트</Label>
              <Input
                id="endpoint"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder={sourceKind === 'mlflow' ? 'http://mlflow:5000' : 'http://jaeger:16686'}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="authSecret">자격증명 시크릿 이름 (선택 — 워크스페이스 시크릿)</Label>
            <Input
              id="authSecret"
              value={authSecret}
              onChange={(e) => setAuthSecret(e.target.value)}
              placeholder="OTEL_TOKEN"
            />
            <p className="text-[12px] text-muted-foreground">
              시크릿 값이 `Authorization` 헤더로 그대로 주입됩니다(스킴 포함 — OTel: `Bearer
              &lt;token&gt;`, MLflow: `Basic &lt;base64&gt;`). 여기엔 토큰 평문이 아니라
              워크스페이스 시크릿 이름만 입력하세요.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="runs">
              실행 매핑 (`[{'{'} caseId, runId {'}'}]` JSON)
            </Label>
            <Textarea
              id="runs"
              className="min-h-48 font-mono text-[12px]"
              value={runsJson}
              onChange={(e) => setRunsJson(e.target.value)}
              spellCheck={false}
            />
            <p className="text-[12px] text-muted-foreground">
              각 runId 의 트레이스를 소스에서 당겨와 caseId 에 맞춥니다. tool_calls/usd/span 이 자동
              재도출됩니다.
            </p>
          </div>
        </>
      )}

      {judges.length > 0 && (
        <div className="space-y-1.5">
          <Label>Agent Judge (선택 — 인제스트된 트레이스에 적용)</Label>
          <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg border border-border bg-card p-3 text-[13px]">
            {judges.map((j) => (
              <label key={j.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={judgeIds.includes(j.id)}
                  onChange={(e) =>
                    setJudgeIds(
                      e.target.checked ? [...judgeIds, j.id] : judgeIds.filter((x) => x !== j.id)
                    )
                  }
                />
                {j.id}
              </label>
            ))}
          </div>
        </div>
      )}

      {serverError && <Callout tone="danger">{serverError}</Callout>}

      <Button type="button" onClick={onSubmit} disabled={busy}>
        {busy ? '인제스트 중…' : mode === 'push' ? '트레이스 인제스트' : '소스에서 인제스트'}
      </Button>
    </div>
  )
}
