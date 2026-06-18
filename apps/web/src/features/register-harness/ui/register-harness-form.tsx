'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/shared/ui/button'
import { Label, Textarea } from '@/shared/ui/input'
import { registerHarnessAction } from '../api/register-harness'

const EXAMPLE = `{
  "kind": "service",
  "id": "bu",
  "version": "1.0.0",
  "services": [
    { "name": "agent-server", "image": "mendhak/http-https-echo:latest", "port": 8080, "needs": [], "perRun": [], "replicas": 1 }
  ],
  "dependencies": [],
  "target": { "kind": "browser", "engine": "chromium", "lifecycle": "per-case-instance", "observe": ["url"] },
  "frontDoor": { "service": "agent-server", "submit": "POST /runs" },
  "traceSource": { "kind": "mlflow", "endpoint": "http://127.0.0.1:5501" }
}`

export function RegisterHarnessForm() {
  const router = useRouter()
  const [json, setJson] = useState(EXAMPLE)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    const res = await registerHarnessAction(json)
    setBusy(false)
    if (res.ok) router.push('/dashboard/harnesses')
    else setError(res.error ?? '등록 실패')
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="spec">HarnessSpec (JSON)</Label>
        <Textarea
          id="spec"
          className="min-h-72"
          value={json}
          onChange={(e) => setJson(e.target.value)}
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">
          버전은 불변입니다 — 같은 (id, version)을 다른 스펙으로 다시 등록하면 409 로 거부됩니다.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Button type="submit" disabled={busy}>
        {busy ? '등록 중…' : '하니스 등록'}
      </Button>
    </form>
  )
}
