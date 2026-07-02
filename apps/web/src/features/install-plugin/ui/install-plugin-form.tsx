'use client'

import { useState } from 'react'

import { type InstallItemResult, type PluginInstallResult } from '@/entities/plugin'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Label, Textarea } from '@/shared/ui/input'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

import { installPluginAction } from '../api/install-plugin'

// 붙여넣기용 최소 예시(codex + pinch 샘플). 실제 pinch 는 recipe/소스를 교체.
const SAMPLE = `{
  "id": "codex-pinch",
  "version": "1.0.0",
  "harnessTemplates": [
    { "kind": "command", "category": "cli-agent", "id": "codex", "version": "1",
      "setup": ["npm install -g @openai/codex"],
      "command": "codex exec --full-auto --model {{model}} {{task}}",
      "model": "gpt-5.4-mini", "env": {}, "trace": { "kind": "none" } }
  ],
  "harnesses": [
    { "template": { "id": "codex", "version": "1" }, "id": "codex", "version": "1.0.0", "pins": {} }
  ],
  "datasets": [
    { "id": "pinch-sample", "version": "1.0.0",
      "cases": [ { "id": "sample-1", "env": { "kind": "repo", "source": { "files": {} } },
        "task": "out.txt 파일을 생성하라.",
        "graders": [ { "id": "tests-pass", "config": { "cmd": "test -f out.txt" } } ],
        "timeoutSec": 120, "tags": ["pinch"] } ], "tags": ["pinch"] }
  ]
}`

const STATUS_TONE: Record<
  InstallItemResult['status'],
  'success' | 'warning' | 'danger' | 'neutral'
> = {
  ok: 'success',
  conflict: 'warning',
  error: 'danger',
  skipped: 'neutral',
}

// 플러그인 번들(JSON) 붙여넣기 → 설치 → 항목별 결과 테이블. 멱등(같은 내용 재설치=ok, 충돌 내용=conflict).
export function InstallPluginForm() {
  const [bundleJson, setBundleJson] = useState(SAMPLE)
  const [result, setResult] = useState<PluginInstallResult>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function onSubmit() {
    setBusy(true)
    setError(undefined)
    setResult(undefined)
    const res = await installPluginAction(bundleJson)
    setBusy(false)
    if (res.ok && res.result) setResult(res.result)
    else setError(res.error ?? '설치 실패')
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="bundle">번들 (PluginBundle JSON)</Label>
        <Textarea
          id="bundle"
          className="min-h-80 font-mono text-[12px]"
          value={bundleJson}
          onChange={(e) => setBundleJson(e.target.value)}
          spellCheck={false}
        />
        <p className="text-[12px] text-muted-foreground">
          하니스 + 벤치마크 + 데이터셋 + 런타임 등을 한 번에 등록합니다. 번들 내용에 따라 권한이
          필요합니다(데이터셋 포함 시 member+). 같은 (id, version) 에 같은 내용은 멱등(ok), 다른
          내용은 conflict.
        </p>
      </div>

      {error && <Callout tone="danger">{error}</Callout>}

      <Button type="button" onClick={onSubmit} disabled={busy}>
        {busy ? '설치 중…' : '플러그인 설치'}
      </Button>

      {result && (
        <div className="space-y-2.5">
          <p className="text-[13px] text-muted-foreground">
            <span className="font-mono font-[510] text-foreground">
              {result.id}@{result.version}
            </span>{' '}
            — {result.results.length}개 항목
          </p>
          <Table>
            <THead>
              <tr>
                <TH>종류</TH>
                <TH>id</TH>
                <TH className="text-right">상태</TH>
              </tr>
            </THead>
            <TBody>
              {result.results.map((r) => (
                <TR key={`${r.kind}-${r.id}-${r.version}`}>
                  <TD className="font-mono text-[12px] text-muted-foreground">{r.kind}</TD>
                  <TD className="font-mono text-[12px]">
                    {r.id}
                    <span className="text-faint">@{r.version}</span>
                    {r.message ? (
                      <span className="ml-2 text-[11px] text-faint">{r.message}</span>
                    ) : null}
                  </TD>
                  <TD className="text-right">
                    <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  )
}
