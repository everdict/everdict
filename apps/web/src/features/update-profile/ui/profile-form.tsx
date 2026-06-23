'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2 } from 'lucide-react'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'

import { updateProfileAction } from '../api/update-profile'

// 프로필 사진 미리보기 — URL 이 있으면 이미지, 없거나 로드 실패면 이름/이메일 첫 글자 모노그램으로 폴백.
function AvatarPreview({ url, seed }: { url: string; seed: string }) {
  const [broken, setBroken] = useState(false)
  const initial = (seed.trim()[0] ?? '?').toUpperCase()
  if (!url.trim() || broken) {
    return (
      <span className="grid size-14 shrink-0 place-items-center rounded-full bg-primary/15 text-[20px] font-[560] text-primary ring-1 ring-inset ring-primary/25">
        {initial}
      </span>
    )
  }
  return (
    // 임의의 외부 아바타 URL이라 next/image(원격 도메인 화이트리스트)가 아닌 일반 img 를 쓴다.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt="프로필 사진 미리보기"
      className="size-14 shrink-0 rounded-full object-cover ring-1 ring-inset ring-border"
      onError={() => setBroken(true)}
    />
  )
}

// 내 프로필 수정 폼 — 사진(URL)·이름·유저네임은 수정 가능, email 은 SSO(읽기전용).
export function ProfileForm({
  email,
  name,
  username,
  avatarUrl,
}: {
  email?: string
  name?: string
  username?: string
  avatarUrl?: string
}) {
  const router = useRouter()
  const [n, setN] = useState(name ?? '')
  const [u, setU] = useState(username ?? '')
  const [a, setA] = useState(avatarUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)

  async function onSave() {
    setBusy(true)
    setError(undefined)
    setSaved(false)
    const r = await updateProfileAction({ name: n, username: u, avatarUrl: a })
    setBusy(false)
    if (r.ok) {
      setSaved(true)
      router.refresh()
    } else {
      setError(r.error)
    }
  }

  return (
    <div className="space-y-5 rounded-lg border bg-card p-5 shadow-raise">
      <div className="flex items-center gap-4">
        <AvatarPreview url={a} seed={n || email || '?'} />
        <div className="min-w-0 space-y-1">
          <p className="text-[13px] font-[560] text-foreground">{n || '이름 없음'}</p>
          <p className="truncate text-[12px] text-muted-foreground">{email ?? '—'}</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pf-email">이메일</Label>
        <Input id="pf-email" value={email ?? ''} readOnly disabled className="text-muted-foreground" />
        <p className="text-[12px] text-faint">이메일은 로그인(SSO) 계정에서 옵니다 — 여기서는 수정할 수 없습니다.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pf-name">이름</Label>
          <Input id="pf-name" value={n} onChange={(e) => setN(e.target.value)} placeholder="예: 김앨리스" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pf-username">유저네임</Label>
          <Input
            id="pf-username"
            value={u}
            onChange={(e) => setU(e.target.value)}
            placeholder="alice"
            className="font-mono"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pf-avatar">프로필 사진 URL</Label>
        <Input
          id="pf-avatar"
          value={a}
          onChange={(e) => setA(e.target.value)}
          placeholder="https://…/avatar.png"
          className="font-mono"
        />
        <p className="text-[12px] text-faint">이미지 주소를 붙여넣으세요. 비우면 이름 이니셜이 표시됩니다.</p>
      </div>

      {error && <Callout tone="danger">{error}</Callout>}

      <div className="flex items-center gap-3">
        <Button onClick={onSave} disabled={busy} className="gap-1.5">
          {busy ? <Loader2 className="size-4 animate-spin" /> : saved ? <Check className="size-4" /> : null}
          {saved ? '저장됨' : '프로필 저장'}
        </Button>
      </div>
    </div>
  )
}
