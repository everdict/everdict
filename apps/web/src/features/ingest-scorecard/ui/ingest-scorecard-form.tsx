'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label, Textarea } from '@/shared/ui/input'

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
export function IngestScorecardForm({ datasets }: { datasets: { id: string }[] }) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [mode, setMode] = useState<Mode>('push')
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? '')
  const [datasetVersion, setDatasetVersion] = useState('latest')
  const [harnessId, setHarnessId] = useState('')
  const [harnessVersion, setHarnessVersion] = useState('external')
  const [tracesJson, setTracesJson] = useState(SAMPLE_TRACES)
  // pull 모드 전용
  const [sourceKind, setSourceKind] = useState<
    'otel' | 'mlflow' | 'langfuse' | 'langsmith' | 'phoenix'
  >('otel')
  const [endpoint, setEndpoint] = useState('')
  const [authSecret, setAuthSecret] = useState('')
  const [sourceProject, setSourceProject] = useState('') // phoenix 전용(스팬 조회 경로의 프로젝트)
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
            tracesJson,
          })
        : await pullScorecardAction({
            datasetId,
            datasetVersion,
            harnessId,
            harnessVersion,
            sourceKind,
            endpoint,
            authSecret,
            ...(sourceProject.trim() ? { sourceProject: sourceProject.trim() } : {}),
            runsJson,
          })
    setBusy(false)
    if (res.ok && res.id) router.push(`/${workspace}/scorecards/${res.id}`)
    else setServerError(res.error ?? '가져오지 못했어요')
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
            {m === 'push' ? '업로드' : '소스에서 가져오기'}
          </button>
        ))}
      </div>
      <p className="text-[12px] text-muted-foreground">
        {mode === 'push'
          ? '이미 가진 트레이스를 직접 올려요.'
          : 'OTel·MLflow·Langfuse·LangSmith·Phoenix에서 트레이스를 가져와요. 인증 정보는 값을 직접 적지 말고 워크스페이스 시크릿 이름으로 넣어주세요.'}
      </p>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="datasetId">데이터셋</Label>
          <Combobox
            id="datasetId"
            value={datasetId}
            onChange={setDatasetId}
            options={datasets.map((d) => ({ value: d.id }))}
            placeholder="데이터셋 선택"
            emptyText="데이터셋이 없어요"
            className="w-full"
          />
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
          <Label htmlFor="harnessId">하니스 (트레이스를 만든 곳)</Label>
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
            caseId는 데이터셋의 케이스와 맞춰주세요. 없는 caseId는 건너뛰어요. 도구 호출·비용 같은
            정보는 트레이스에서 자동으로 계산돼요.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sourceKind">소스 종류</Label>
              <Combobox
                id="sourceKind"
                value={sourceKind}
                onChange={(v) =>
                  setSourceKind(
                    v === 'mlflow' || v === 'langfuse' || v === 'langsmith' || v === 'phoenix'
                      ? v
                      : 'otel'
                  )
                }
                options={[
                  { value: 'otel', label: 'OTel' },
                  { value: 'mlflow', label: 'MLflow' },
                  { value: 'langfuse', label: 'Langfuse' },
                  { value: 'langsmith', label: 'LangSmith' },
                  { value: 'phoenix', label: 'Phoenix' },
                ]}
                className="w-full"
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="endpoint">주소</Label>
              <Input
                id="endpoint"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder={
                  sourceKind === 'mlflow'
                    ? 'http://mlflow:5000'
                    : sourceKind === 'langfuse'
                      ? 'https://cloud.langfuse.com'
                      : sourceKind === 'langsmith'
                        ? 'https://api.smith.langchain.com'
                        : sourceKind === 'phoenix'
                          ? 'http://phoenix:6006'
                          : 'http://jaeger:16686'
                }
              />
            </div>
          </div>

          {/* phoenix 는 스팬 조회 경로에 프로젝트가 필수 — 그 외 kind 에선 숨김. */}
          {sourceKind === 'phoenix' && (
            <div className="space-y-1.5">
              <Label htmlFor="sourceProject">프로젝트</Label>
              <Input
                id="sourceProject"
                value={sourceProject}
                onChange={(e) => setSourceProject(e.target.value)}
                placeholder="프로젝트 이름 또는 ID"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="authSecret">인증 시크릿 이름 (선택)</Label>
            <Input
              id="authSecret"
              value={authSecret}
              onChange={(e) => setAuthSecret(e.target.value)}
              placeholder="OTEL_TOKEN"
            />
            <p className="text-[12px] text-muted-foreground">
              시크릿 값이 인증 헤더에 그대로 쓰여요. 토큰을 직접 적지 말고, 워크스페이스 시크릿
              이름만 입력해주세요.
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
              각 runId의 트레이스를 가져와 caseId에 맞춰요. 도구 호출·비용 같은 정보는 자동으로
              계산돼요.
            </p>
          </div>
        </>
      )}

      {serverError && <Callout tone="danger">{serverError}</Callout>}

      <Button type="button" onClick={onSubmit} disabled={busy}>
        {busy ? '가져오는 중…' : mode === 'push' ? '트레이스 가져오기' : '소스에서 가져오기'}
      </Button>
    </div>
  )
}
