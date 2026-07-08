'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label, Textarea } from '@/shared/ui/input'

import { importTerminalBenchAction } from '../api/import-terminal-bench'

const SAMPLE_TASKS = `[
  {
    "id": "hello-world",
    "instruction": "Create a file /app/hello.txt containing the word hello.",
    "difficulty": "easy",
    "testCommand": "bash /tests/run-tests.sh"
  }
]`

// Register a Terminal-Bench task set as a workspace dataset. The client owns YAML→JSON (parse task.yaml locally and
// paste the task array here); the control plane maps each task to an EvalCase and requires a resolvable image.
export function ImportTerminalBenchForm() {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const t = useTranslations('datasetsPage')
  const [datasetId, setDatasetId] = useState('')
  const [datasetVersion, setDatasetVersion] = useState('1.0.0')
  const [imageTemplate, setImageTemplate] = useState('')
  const [tasksJson, setTasksJson] = useState(SAMPLE_TASKS)
  const [serverError, setServerError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function onSubmit() {
    setBusy(true)
    setServerError(undefined)
    const res = await importTerminalBenchAction({
      datasetId,
      datasetVersion,
      imageTemplate,
      tasksJson,
    })
    setBusy(false)
    if (res.ok && res.id) router.push(`/${workspace}/datasets/${res.id}`)
    else setServerError(res.error ?? t('tbSubmitError'))
  }

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-[12px] text-muted-foreground">{t('tbDescription')}</p>

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="tbId">{t('tbDatasetIdLabel')}</Label>
          <Input
            id="tbId"
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
            placeholder="terminal-bench"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tbVersion">{t('tbVersionLabel')}</Label>
          <Input
            id="tbVersion"
            value={datasetVersion}
            onChange={(e) => setDatasetVersion(e.target.value)}
            placeholder="1.0.0"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="tbImageTemplate">{t('tbImageTemplateLabel')}</Label>
        <Input
          id="tbImageTemplate"
          value={imageTemplate}
          onChange={(e) => setImageTemplate(e.target.value)}
          placeholder="ghcr.io/acme/tb/{id}:v1"
        />
        <p className="text-[12px] text-muted-foreground">{t('tbImageTemplateHelp')}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="tbTasks">{t('tbTasksLabel')}</Label>
        <Textarea
          id="tbTasks"
          className="min-h-72 font-mono text-[12px]"
          value={tasksJson}
          onChange={(e) => setTasksJson(e.target.value)}
          spellCheck={false}
        />
        <p className="text-[12px] text-muted-foreground">{t('tbTasksHelp')}</p>
      </div>

      {serverError && <Callout tone="danger">{serverError}</Callout>}

      <Button type="button" onClick={onSubmit} disabled={busy}>
        {busy ? t('tbSubmitting') : t('tbSubmit')}
      </Button>
    </div>
  )
}
