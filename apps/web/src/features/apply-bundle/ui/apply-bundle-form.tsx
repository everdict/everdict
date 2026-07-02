'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'

import { type BundleApplyResult, type BundleItemResult } from '@/entities/bundle'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Label, Textarea } from '@/shared/ui/input'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

import { applyBundleAction } from '../api/apply-bundle'

// 붙여넣기용 예시 = 검증된 codex + pinch 번들(examples/bundles/codex-pinch). self-hosted 러너에서 머신 codex 로그인으로 실행.
const SAMPLE = `{
  "id": "codex-pinch",
  "version": "1.1.0",
  "harnessTemplates": [
    { "kind": "command", "category": "cli-agent", "id": "codex", "version": "1",
      "setup": [],
      "command": "codex exec --sandbox workspace-write --skip-git-repo-check {{task}} < /dev/null",
      "model": "gpt-5-codex", "env": {}, "trace": { "kind": "none" } }
  ],
  "harnesses": [
    { "template": { "id": "codex", "version": "1" }, "id": "codex", "version": "1.0.0", "pins": {} }
  ],
  "datasets": [
    { "id": "pinch-dashboards", "version": "1.0.0",
      "cases": [ { "id": "api-health-dashboard", "env": { "kind": "repo", "source": { "files": {} } },
        "task": "Create a file named dashboard.json: a valid JSON Axiom dashboard for API health with panels for p95/p99 latency, error rate, and request volume.",
        "graders": [ { "id": "tests-pass", "config": { "cmd": "test -f dashboard.json && python3 -m json.tool dashboard.json >/dev/null && grep -qi p95 dashboard.json && grep -qi p99 dashboard.json && grep -qi error dashboard.json && grep -qi volume dashboard.json" } } ],
        "timeoutSec": 600, "tags": ["pinchbench"] } ], "tags": ["pinchbench"] }
  ]
}`

const STATUS_TONE: Record<
  BundleItemResult['status'],
  'success' | 'warning' | 'danger' | 'neutral'
> = {
  ok: 'success',
  conflict: 'warning',
  error: 'danger',
  skipped: 'neutral',
}

// 적용된 항목 → 그 리소스 페이지(발견성). 상세 페이지가 있는 종류는 상세로, 없으면 목록으로.
function hrefFor(ws: string, kind: string, id: string): string | undefined {
  const enc = encodeURIComponent(id)
  switch (kind) {
    case 'harness':
      return `/${ws}/harnesses/${enc}`
    case 'harness-template':
      return `/${ws}/harnesses`
    case 'dataset':
      return `/${ws}/datasets/${enc}`
    case 'benchmark-recipe':
      return `/${ws}/recipes/${enc}`
    case 'judge':
      return `/${ws}/judges`
    case 'model':
      return `/${ws}/models`
    case 'metric':
      return `/${ws}/metrics`
    case 'runtime':
      return `/${ws}/runtimes`
    default:
      return undefined
  }
}

// 번들(JSON) 붙여넣기 → 적용 → 항목별 결과 테이블. 멱등(같은 내용 재적용=ok, 충돌 내용=conflict).
// 결과 각 행은 등록된 리소스 페이지로 링크(적용 후 어디서 보는지 바로 이동).
export function ApplyBundleForm() {
  const { workspace } = useParams<{ workspace: string }>()
  const [bundleJson, setBundleJson] = useState(SAMPLE)
  const [result, setResult] = useState<BundleApplyResult>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function onSubmit() {
    setBusy(true)
    setError(undefined)
    setResult(undefined)
    const res = await applyBundleAction(bundleJson)
    setBusy(false)
    if (res.ok && res.result) setResult(res.result)
    else setError(res.error ?? '적용 실패')
  }

  // 워크스페이스에 실제로 존재하게 된 항목(ok=신규 등록 / conflict=이미 동일 id·version 존재).
  const present =
    result?.results.filter((r) => r.status === 'ok' || r.status === 'conflict').length ?? 0

  return (
    <div className="max-w-2xl space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="bundle">번들 (Bundle JSON)</Label>
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
        {busy ? '적용 중…' : '번들 적용'}
      </Button>

      {result && (
        <div className="space-y-2.5">
          <Callout tone="info">
            <span className="font-mono font-[510]">
              {result.id}@{result.version}
            </span>{' '}
            — {present}개 항목이 워크스페이스에 등록되었습니다. 아래 행을 눌러 해당
            리소스(하니스/데이터셋 등) 페이지에서 확인하세요.
          </Callout>
          <Table>
            <THead>
              <tr>
                <TH>종류</TH>
                <TH>id</TH>
                <TH className="text-right">상태</TH>
              </tr>
            </THead>
            <TBody>
              {result.results.map((r) => {
                const href = r.status === 'error' ? undefined : hrefFor(workspace, r.kind, r.id)
                return (
                  <TR key={`${r.kind}-${r.id}-${r.version}`}>
                    <TD className="font-mono text-[12px] text-muted-foreground">{r.kind}</TD>
                    <TD className="font-mono text-[12px]">
                      {href ? (
                        <Link
                          href={href}
                          className="font-[510] text-link transition-colors hover:text-foreground"
                        >
                          {r.id}
                          <span className="text-faint">@{r.version}</span>
                        </Link>
                      ) : (
                        <>
                          {r.id}
                          <span className="text-faint">@{r.version}</span>
                        </>
                      )}
                      {r.message ? (
                        <span className="ml-2 text-[11px] text-faint">{r.message}</span>
                      ) : null}
                    </TD>
                    <TD className="text-right">
                      <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                    </TD>
                  </TR>
                )
              })}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  )
}
