'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Copy, Loader2, Trash2, Upload } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { workspaceUrlBase } from '@/entities/workspace'
import { copyText } from '@/shared/lib/clipboard'
import { fileToImageDataUrl, MAX_IMAGE_UPLOAD_BYTES } from '@/shared/lib/image-resize'
import { cn } from '@/shared/lib/utils'
import { Button, buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'

import { updateWorkspaceAction } from '../api/workspace-meta'

// 워크스페이스 로고 미리보기 — 라운드 사각(유저 아바타의 원형과 구분). 없거나 로드 실패면 이름 첫 글자 모노그램.
function LogoPreview({ url, seed }: { url: string; seed: string }) {
  const t = useTranslations('workspaceSettings')
  const [broken, setBroken] = useState(false)
  const initial = (seed.trim()[0] ?? '?').toUpperCase()
  if (!url.trim() || broken) {
    return (
      <span className="grid size-14 shrink-0 place-items-center rounded-lg bg-primary/15 text-[20px] font-[560] text-primary ring-1 ring-inset ring-primary/25">
        {initial}
      </span>
    )
  }
  return (
    // 업로드 data URL/외부 URL 이라 next/image(원격 화이트리스트)가 아닌 일반 img.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={t('logoPreviewAlt')}
      className="size-14 shrink-0 rounded-lg object-cover ring-1 ring-inset ring-border"
      onError={() => setBroken(true)}
    />
  )
}

// 워크스페이스 일반 정보 — 로고(파일 업로드)·이름 수정 + URL(slug) 읽기 전용 표시/복사. URL 은 모든 데이터의
// 스코프 키(tenant)라 불변. 비-admin 은 읽기 전용(컨트롤플레인이 최종 강제).
export function WorkspaceInfoCard({
  id,
  name,
  logoUrl,
  canWrite,
}: {
  id: string
  name: string
  logoUrl?: string
  canWrite: boolean
}) {
  const t = useTranslations('workspaceSettings')
  const locale = useLocale()
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [n, setN] = useState(name)
  const [logo, setLogo] = useState(logoUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const url = `${workspaceUrlBase}/${id}`
  const dirty = n !== name || logo !== (logoUrl ?? '')

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // 같은 파일 재선택도 change 가 발생하도록 초기화.
    if (!file) return
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
      setLogo(await fileToImageDataUrl(file, undefined, locale))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('imageProcessFailed'))
    }
  }

  async function onSave() {
    setBusy(true)
    setError(undefined)
    setSaved(false)
    const r = await updateWorkspaceAction({ name: n, logoUrl: logo })
    setBusy(false)
    if (r.ok) {
      setSaved(true)
      router.refresh()
    } else {
      setError(r.error)
    }
  }

  async function onCopy() {
    // http(비-secure) 컨텍스트 폴백 포함 — navigator.clipboard 미존재 시 execCommand.
    if (await copyText(url, undefined, locale)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } else {
      setError(t('copyFailed'))
    }
  }

  return (
    <div className="space-y-5 rounded-lg border bg-card p-5 shadow-raise">
      <div className="flex items-center gap-4">
        <LogoPreview url={logo} seed={n || id} />
        {canWrite ? (
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onPickFile}
              aria-label={t('logoFileSelectLabel')}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'gap-1.5')}
            >
              <Upload className="size-4" />
              {logo.trim() ? t('changeLogo') : t('uploadLogo')}
            </button>
            {logo.trim() && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setLogo('')}
                className="gap-1.5"
              >
                <Trash2 className="size-4" />
                {t('remove')}
              </Button>
            )}
          </div>
        ) : (
          <p className="text-[13px] font-[560] text-foreground">{name}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ws-name">{t('workspaceName')}</Label>
        <Input
          id="ws-name"
          value={n}
          onChange={(e) => {
            setN(e.target.value)
            setSaved(false)
          }}
          placeholder={t('workspaceNamePlaceholder')}
          readOnly={!canWrite}
          disabled={!canWrite}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ws-url">URL</Label>
        <div className="flex items-center gap-2">
          <Input id="ws-url" value={url} readOnly className="font-mono text-muted-foreground" />
          <Button type="button" variant="secondary" size="sm" onClick={onCopy} className="gap-1.5">
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? t('copied') : t('copy')}
          </Button>
        </div>
        <p className="text-[12px] text-faint">{t('urlImmutable')}</p>
      </div>

      {error && <Callout tone="danger">{error}</Callout>}

      {canWrite && (
        <div className="flex items-center gap-3">
          <Button onClick={onSave} disabled={busy || !dirty || !n.trim()} className="gap-1.5">
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : saved ? (
              <Check className="size-4" />
            ) : null}
            {saved ? t('saved') : t('saveChanges')}
          </Button>
        </div>
      )}
    </div>
  )
}
