'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2, Trash2, Upload } from 'lucide-react'

import { fileToImageDataUrl, MAX_IMAGE_UPLOAD_BYTES } from '@/shared/lib/image-resize'
import { cn } from '@/shared/lib/utils'
import { Button, buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'

import { updateProfileAction } from '../api/update-profile'

// 프로필 사진 미리보기 — 이미지(http/https 또는 data URL)가 있으면 표시, 없거나 로드 실패면 이름 첫 글자 모노그램.
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
    // 임의의 외부 아바타 URL/업로드 data URL 이라 next/image(원격 도메인 화이트리스트)가 아닌 일반 img 를 쓴다.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt="프로필 사진 미리보기"
      className="size-14 shrink-0 rounded-full object-cover ring-1 ring-inset ring-border"
      onError={() => setBroken(true)}
    />
  )
}

// 내 프로필 수정 폼 — 사진(파일 업로드)·이름은 수정 가능, email 은 SSO(읽기전용).
export function ProfileForm({
  email,
  name,
  avatarUrl,
}: {
  email?: string
  name?: string
  avatarUrl?: string
}) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [n, setN] = useState(name ?? '')
  const [a, setA] = useState(avatarUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // 같은 파일 재선택도 change 이벤트가 발생하도록 초기화.
    if (!file) return
    setError(undefined)
    setSaved(false)
    if (!file.type.startsWith('image/')) {
      setError('이미지 파일만 업로드할 수 있습니다.')
      return
    }
    if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
      setError('이미지가 너무 큽니다(최대 8MB).')
      return
    }
    try {
      setA(await fileToImageDataUrl(file))
    } catch (err) {
      setError(err instanceof Error ? err.message : '이미지 처리에 실패했습니다.')
    }
  }

  async function onSave() {
    setBusy(true)
    setError(undefined)
    setSaved(false)
    const r = await updateProfileAction({ name: n, avatarUrl: a })
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
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onPickFile}
            aria-label="프로필 사진 파일 선택"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'gap-1.5')}
          >
            <Upload className="size-4" />
            {a.trim() ? '사진 변경' : '사진 업로드'}
          </button>
          {a.trim() && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setA('')}
              className="gap-1.5"
            >
              <Trash2 className="size-4" />
              제거
            </Button>
          )}
        </div>
      </div>
      <p className="text-[12px] text-faint">
        PNG·JPG 등 이미지 파일을 올리면 256px로 줄여 저장합니다. 비우면 이름 이니셜이 표시됩니다.
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="pf-email">이메일</Label>
        <Input
          id="pf-email"
          value={email ?? ''}
          readOnly
          disabled
          className="text-muted-foreground"
        />
        <p className="text-[12px] text-faint">
          이메일은 로그인(SSO) 계정에서 옵니다 — 여기서는 수정할 수 없습니다.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pf-name">이름</Label>
        <Input
          id="pf-name"
          value={n}
          onChange={(e) => setN(e.target.value)}
          placeholder="예: 김앨리스"
        />
      </div>

      {error && <Callout tone="danger">{error}</Callout>}

      <div className="flex items-center gap-3">
        <Button onClick={onSave} disabled={busy} className="gap-1.5">
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : saved ? (
            <Check className="size-4" />
          ) : null}
          {saved ? '저장됨' : '프로필 저장'}
        </Button>
      </div>
    </div>
  )
}
