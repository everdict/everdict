'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

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

// Trace ingest — two modes: push (uploaded TraceEvent[]) | pull (pull by runId from the tenant's OTel/MLflow).
// The dataset/judge/harness labels are common. push takes traces JSON; pull takes source + runs JSON.
export function IngestScorecardForm({ datasets }: { datasets: { id: string }[] }) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const t = useTranslations('ingestScorecard')
  const [mode, setMode] = useState<Mode>('push')
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? '')
  const [datasetVersion, setDatasetVersion] = useState('latest')
  const [harnessId, setHarnessId] = useState('')
  const [harnessVersion, setHarnessVersion] = useState('external')
  const [tracesJson, setTracesJson] = useState(SAMPLE_TRACES)
  // pull-mode only
  const [sourceKind, setSourceKind] = useState<
    'otel' | 'mlflow' | 'langfuse' | 'langsmith' | 'phoenix'
  >('otel')
  const [endpoint, setEndpoint] = useState('')
  const [authSecret, setAuthSecret] = useState('')
  const [sourceProject, setSourceProject] = useState('') // phoenix-only (the project in the span lookup path)
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
    else setServerError(res.error ?? t('submitError'))
  }

  return (
    <div className="max-w-2xl space-y-4">
      {/* mode toggle */}
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
            {m === 'push' ? t('modePush') : t('modePull')}
          </button>
        ))}
      </div>
      <p className="text-[12px] text-muted-foreground">
        {mode === 'push' ? t('pushDescription') : t('pullDescription')}
      </p>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="datasetId">{t('datasetLabel')}</Label>
          <Combobox
            id="datasetId"
            value={datasetId}
            onChange={setDatasetId}
            options={datasets.map((d) => ({ value: d.id }))}
            placeholder={t('datasetPlaceholder')}
            emptyText={t('datasetEmpty')}
            className="w-full"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="datasetVersion">{t('versionLabel')}</Label>
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
          <Label htmlFor="harnessId">{t('harnessLabel')}</Label>
          <Input
            id="harnessId"
            value={harnessId}
            onChange={(e) => setHarnessId(e.target.value)}
            placeholder="my-external-agent"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="harnessVersion">{t('versionLabel')}</Label>
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
            {t('tracesLabel', { sample: '[{ caseId, trace: TraceEvent[] }]' })}
          </Label>
          <Textarea
            id="traces"
            className="min-h-72 font-mono text-[12px]"
            value={tracesJson}
            onChange={(e) => setTracesJson(e.target.value)}
            spellCheck={false}
          />
          <p className="text-[12px] text-muted-foreground">{t('pushTracesHelp')}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sourceKind">{t('sourceKindLabel')}</Label>
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
              <Label htmlFor="endpoint">{t('endpointLabel')}</Label>
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

          {/* phoenix requires a project in the span lookup path — hidden for other kinds. */}
          {sourceKind === 'phoenix' && (
            <div className="space-y-1.5">
              <Label htmlFor="sourceProject">{t('projectLabel')}</Label>
              <Input
                id="sourceProject"
                value={sourceProject}
                onChange={(e) => setSourceProject(e.target.value)}
                placeholder={t('projectPlaceholder')}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="authSecret">{t('authSecretLabel')}</Label>
            <Input
              id="authSecret"
              value={authSecret}
              onChange={(e) => setAuthSecret(e.target.value)}
              placeholder="OTEL_TOKEN"
            />
            <p className="text-[12px] text-muted-foreground">{t('authSecretHelp')}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="runs">{t('runsLabel', { sample: '[{ caseId, runId }]' })}</Label>
            <Textarea
              id="runs"
              className="min-h-48 font-mono text-[12px]"
              value={runsJson}
              onChange={(e) => setRunsJson(e.target.value)}
              spellCheck={false}
            />
            <p className="text-[12px] text-muted-foreground">{t('pullRunsHelp')}</p>
          </div>
        </>
      )}

      {serverError && <Callout tone="danger">{serverError}</Callout>}

      <Button type="button" onClick={onSubmit} disabled={busy}>
        {busy ? t('submitting') : mode === 'push' ? t('submitPush') : t('submitPull')}
      </Button>
    </div>
  )
}
