'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Loader2 } from 'lucide-react'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { FieldError, Input, Label } from '@/shared/ui/input'

// 표시 이름 → 미리보기 slug(서버 파생 규칙과 동일). id 를 비우면 이 값이 워크스페이스 id 가 된다.
function previewSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export function CreateWorkspaceForm() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const slug = id.trim() || previewSlug(name)
  const nameError = name.trim().length === 0 ? '이름을 입력하세요.' : undefined

  async function onSubmit() {
    if (nameError) return
    setBusy(true)
    setError(undefined)
    const { createWorkspaceAction } = await import('../api/create-workspace')
    const result = await createWorkspaceAction({
      name: name.trim(),
      ...(id.trim() ? { id: id.trim() } : {}),
    })
    if (result.ok && result.id) {
      // 새로 만든 워크스페이스(/{id})로 진입(Linear 식). 미들웨어가 활성 워크스페이스를 동기화한다.
      router.push(`/${result.id}`)
      router.refresh()
      return
    }
    setError(result.error)
    setBusy(false)
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="ws-name">워크스페이스 이름</Label>
        <Input
          id="ws-name"
          autoFocus
          placeholder="예: Acme 팀"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit()
          }}
        />
        <p className="text-[12px] text-faint">
          팀·조직 이름. 모든 평가 데이터가 이 워크스페이스로 격리됩니다.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ws-id">
          워크스페이스 ID <span className="text-muted-foreground">(선택)</span>
        </Label>
        <Input
          id="ws-id"
          placeholder={slug || 'acme-team'}
          value={id}
          onChange={(e) => setId(e.target.value)}
          className="font-mono"
        />
        <p className="text-[12px] text-faint">
          비우면 이름에서 자동 생성:{' '}
          <span className="font-mono text-foreground">{slug || '—'}</span>
        </p>
      </div>

      {error && <Callout tone="danger">{error}</Callout>}

      <Button onClick={onSubmit} disabled={busy || Boolean(nameError)} className="w-full gap-1.5">
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        워크스페이스 만들기
        {!busy ? <ArrowRight className="size-4" /> : null}
      </Button>
      <FieldError message={name.length > 0 ? nameError : undefined} />
    </div>
  )
}
