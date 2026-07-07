'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2, Lock, Pencil, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { fileToImageDataUrl, MAX_IMAGE_UPLOAD_BYTES } from '@/shared/lib/image-resize'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'

import { updateProfileAction } from '../api/update-profile'

// 프로필 사진 편집기 — Linear st. 작은 아바타가 곧 업로드 트리거(hover 시 연필 오버레이).
// 이미지(http/https 또는 data URL)가 있으면 표시, 없거나 로드 실패면 이름 첫 글자 모노그램.
function AvatarEditor({
  url,
  seed,
  onPick,
}: {
  url: string
  seed: string
  onPick: (file: File) => void
}) {
  const t = useTranslations('updateProfile')
  const fileRef = useRef<HTMLInputElement>(null)
  const [broken, setBroken] = useState(false)
  const initial = (seed.trim()[0] ?? '?').toUpperCase()
  const hasImage = url.trim().length > 0 && !broken

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label={t('choosePhotoFile')}
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = '' // 같은 파일 재선택도 change 가 발생하도록 초기화.
          if (f) onPick(f)
        }}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        aria-label={t('changePhoto')}
        className="group relative size-9 shrink-0 overflow-hidden rounded-full outline-none ring-1 ring-inset ring-border transition focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        {hasImage ? (
          // 임의의 외부 아바타 URL/업로드 data URL 이라 next/image(원격 도메인 화이트리스트)가 아닌 일반 img.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={t('photoAlt')}
            className="size-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          <span className="grid size-full place-items-center bg-primary/15 text-[14px] font-[560] text-primary">
            {initial}
          </span>
        )}
        <span className="absolute inset-0 grid place-items-center bg-black/55 text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <Pencil className="size-3.5" />
        </span>
      </button>
    </>
  )
}

// 내 프로필 수정 폼 — Linear settings-list 패턴(label 좌 · 컨트롤 우).
// 사진(아바타 클릭 업로드)·이름은 수정 가능, email 은 SSO(읽기 전용·자물쇠).
export function ProfileForm({
  email,
  name,
  avatarUrl,
}: {
  email?: string
  name?: string
  avatarUrl?: string
}) {
  const t = useTranslations('updateProfile')
  const locale = useLocale()
  const router = useRouter()
  const [n, setN] = useState(name ?? '')
  const [a, setA] = useState(avatarUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)

  const dirty = n !== (name ?? '') || a !== (avatarUrl ?? '')

  // 저장 직후 확인 표시는 잠깐만 — 변경이 없을 땐 푸터가 자연스럽게 비워지도록 자동 소멸.
  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2500)
    return () => clearTimeout(t)
  }, [saved])

  async function onPick(file: File) {
    setError(undefined)
    setSaved(false)
    if (!file.type.startsWith('image/')) {
      setError(t('imageOnly'))
      return
    }
    if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
      setError(t('imageTooLarge'))
      return
    }
    try {
      setA(await fileToImageDataUrl(file, undefined, locale))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('imageProcessFailed'))
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
    <div className="space-y-4">
      <SettingsList>
        <SettingsRow label={t('profilePhoto')}>
          {a.trim() && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('removePhoto')}
              onClick={() => {
                setA('')
                setSaved(false)
              }}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </Button>
          )}
          <AvatarEditor url={a} seed={n || email || '?'} onPick={onPick} />
        </SettingsRow>

        <SettingsRow label={t('email')}>
          <span className="truncate text-[13px] text-muted-foreground">{email ?? '—'}</span>
          <Lock className="size-3.5 shrink-0 text-faint" aria-label={t('managedBySso')} />
        </SettingsRow>

        <SettingsRow label={t('name')} htmlFor="pf-name">
          <Input
            id="pf-name"
            value={n}
            onChange={(e) => {
              setN(e.target.value)
              setSaved(false)
            }}
            placeholder={t('namePlaceholder')}
            className="w-full sm:w-60"
          />
        </SettingsRow>
      </SettingsList>

      {error && <Callout tone="danger">{error}</Callout>}

      {/* 변경이 있을 때만 저장 버튼이 자연스럽게 나타난다(미수정 시 숨김). 저장 직후엔 잠깐 '저장됨' 확인. */}
      {busy || dirty || saved ? (
        <div className="flex items-center animate-in fade-in-0 slide-in-from-top-1 duration-150">
          {saved && !busy ? (
            <span className="inline-flex items-center gap-1.5 text-[13px] font-[510] text-muted-foreground">
              <Check className="size-4 text-primary" />
              {t('saved')}
            </span>
          ) : (
            <Button onClick={onSave} disabled={busy} className="gap-1.5">
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('saveProfile')}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  )
}
