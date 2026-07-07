'use client'

import { useState, useTransition } from 'react'
import { useLocale, useTranslations } from 'next-intl'

import { SecretPicker } from '@/features/pick-secret'
import type { GithubAppInstallation, GithubAppView } from '@/entities/github-app'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import {
  registerGithubAppAction,
  removeGithubAppRegistrationAction,
  startGithubAppInstallAction,
  unlinkGithubAppInstallationAction,
} from '../api/manage-github-app'

// 설치 콜백 리다이렉트(?githubApp=installed / ?error=…)의 사람이 읽을 안내 — 설치 직후 명시적 피드백.
export interface GithubAppNotice {
  installed?: boolean
  error?: string
}
// 설치 콜백 오류 코드 → 메시지 키(카탈로그에서 사람이 읽을 안내를 해석).
const INSTALL_ERROR_KEYS: Record<string, string> = {
  missing_state: 'installErrorMissingState',
  invalid_state: 'installErrorInvalidState',
  missing_installation: 'installErrorMissingInstallation',
  install_failed: 'installErrorInstallFailed',
}

// 워크스페이스 소유 GitHub App 통합 — 조직 설치→선택 repo→워크스페이스 소유 installation(개인 연결 대체).
// github.com 은 원클릭 설치(operator env App), GHE 는 관리자가 각 서버 App 을 등록 후 설치. authZ 는 컨트롤플레인이 강제.
// 설치 목록은 github.com·GHE 를 같은 모양(계정 + host 칩 + 설치됨 배지 + 허용 저장소 칩)으로 보여준다 — 일관성.
// secretNames = 워크스페이스 시크릿 이름(GHE 개인키 피커용 — 값은 안 옴).
export function GithubAppManager({
  view,
  canWrite,
  secretNames,
  notice,
}: {
  view: GithubAppView
  canWrite: boolean
  secretNames: string[]
  notice?: GithubAppNotice
}) {
  const t = useTranslations('manageGithubApp')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [showGhe, setShowGhe] = useState(view.registrations.length > 0)
  const noticeErrorKey = notice?.error ? INSTALL_ERROR_KEYS[notice.error] : undefined

  function onInstall(host?: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await startGithubAppInstallAction(host)
      // 설치는 새 탭에서 — 설정 화면을 떠나지 않고 GitHub 설치 플로우를 진행.
      if (r.ok && r.installUrl) window.open(r.installUrl, '_blank', 'noopener,noreferrer')
      else setError(r.error ?? t('installStartFailed'))
    })
  }
  function onUnlink(installationId: number) {
    setError(undefined)
    startTransition(async () => {
      const r = await unlinkGithubAppInstallationAction(installationId)
      if (!r.ok) setError(r.error)
    })
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="flex items-center gap-1.5 text-[13px] font-[560] text-foreground">
          {t('title')}
          <InfoTip content={t('titleTip')} />
        </h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t('description')}</p>
      </div>

      {/* 설치 콜백 직후 피드백 — GitHub 에서 돌아온 순간 "됐다/안 됐다"를 명시적으로 알린다. */}
      {notice?.installed && (
        <Callout tone="info" className="py-1.5">
          {t('installedNotice')}
        </Callout>
      )}
      {notice?.error && (
        <Callout tone="danger" className="py-1.5">
          {noticeErrorKey ? t(noticeErrorKey) : t('installFailedGeneric', { code: notice.error })}
        </Callout>
      )}

      {view.installations.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-4 py-5">
          <p className="text-[13px] text-muted-foreground">{t('emptyTitle')}</p>
          <p className="mt-1 text-[12px] text-faint">
            {canWrite ? t('emptyHintCanWrite') : t('emptyHintReadOnly')}
          </p>
        </div>
      ) : (
        <SettingsList>
          {view.installations.map((i) => (
            <InstallationRow
              key={i.installationId}
              install={i}
              canWrite={canWrite}
              pending={pending}
              onUnlink={onUnlink}
            />
          ))}
        </SettingsList>
      )}

      {canWrite && (
        <div className="flex items-center gap-3">
          <Button variant="secondary" size="sm" disabled={pending} onClick={() => onInstall()}>
            {t('installButton')}
          </Button>
          <button
            type="button"
            className="text-[12px] font-[510] text-primary hover:underline"
            onClick={() => setShowGhe((v) => !v)}
          >
            {t('gheToggle')}
          </button>
        </div>
      )}

      {canWrite && showGhe && (
        <GheSection
          view={view}
          secretNames={secretNames}
          pending={pending}
          onInstall={onInstall}
          onError={setError}
        />
      )}

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}

// 접기 전 보여줄 허용 저장소 칩 수 — 넘치면 "+n개 더"로 펼친다.
const REPO_PREVIEW_COUNT = 6

// 설치 한 건 — github.com 과 GHE 를 같은 모양으로: 계정 + host 칩(상시) + 설치됨 배지 + 허용 저장소 칩 목록.
function InstallationRow({
  install,
  canWrite,
  pending,
  onUnlink,
}: {
  install: GithubAppInstallation
  canWrite: boolean
  pending: boolean
  onUnlink: (installationId: number) => void
}) {
  const t = useTranslations('manageGithubApp')
  const locale = useLocale()
  const [expanded, setExpanded] = useState(false)
  const repos = install.repos ?? []
  const shown = expanded ? repos : repos.slice(0, REPO_PREVIEW_COUNT)
  return (
    <SettingsRow
      label={
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-[560] text-foreground">{install.account}</span>
          <span className="rounded border border-border bg-muted/40 px-1.5 py-px font-mono text-[10.5px] font-normal text-muted-foreground">
            {hostLabel(install.host)}
          </span>
        </span>
      }
      hint={
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span>
            {t('installedOn', {
              date: new Date(install.connectedAt).toLocaleDateString(locale),
            })}
          </span>
          <span>·</span>
          {install.reposError ? (
            <span className="text-[var(--color-warning)]">{install.reposError}</span>
          ) : repos.length === 0 ? (
            <span>{t('noReposHint')}</span>
          ) : (
            <>
              <span>{t('allowedRepos', { count: repos.length })}</span>
              {shown.map((r) => (
                <code
                  key={r.fullName}
                  className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-foreground/85"
                >
                  {r.fullName}
                </code>
              ))}
              {repos.length > REPO_PREVIEW_COUNT && (
                <button
                  type="button"
                  className="text-[12px] font-[510] text-link hover:text-foreground"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded
                    ? t('collapse')
                    : t('moreRepos', { count: repos.length - REPO_PREVIEW_COUNT })}
                </button>
              )}
            </>
          )}
        </span>
      }
    >
      <Badge tone="success">{t('installedBadge')}</Badge>
      {canWrite && (
        <button
          type="button"
          className="text-[12px] font-[510] text-destructive hover:underline"
          disabled={pending}
          onClick={() => onUnlink(install.installationId)}
        >
          {t('unlink')}
        </button>
      )}
    </SettingsRow>
  )
}

// GitHub Enterprise — 각 GHE 서버에 App 을 만들어 등록(host+slug+appId+개인키 SecretStore 이름) 후 설치.
// 등록 행에 설치 여부(설치됨/미설치)를 보여 github.com 과 같은 "상태가 보이는" 흐름으로 잇는다.
function GheSection({
  view,
  secretNames,
  pending,
  onInstall,
  onError,
}: {
  view: GithubAppView
  secretNames: string[]
  pending: boolean
  onInstall: (host: string) => void
  onError: (msg?: string) => void
}) {
  const t = useTranslations('manageGithubApp')
  const [saving, startSaving] = useTransition()
  const [host, setHost] = useState('')
  const [slug, setSlug] = useState('')
  const [appId, setAppId] = useState('')
  const [keyName, setKeyName] = useState('')

  function onRegister() {
    onError(undefined)
    if (!host.trim() || !slug.trim() || !appId.trim() || !keyName.trim()) {
      onError(t('allFieldsRequired'))
      return
    }
    startSaving(async () => {
      const r = await registerGithubAppAction({
        host: host.trim(),
        slug: slug.trim(),
        appId: appId.trim(),
        privateKeySecretName: keyName.trim(),
      })
      if (r.ok) {
        setHost('')
        setSlug('')
        setAppId('')
        setKeyName('')
      } else onError(r.error)
    })
  }
  function onRemove(h: string) {
    onError(undefined)
    startSaving(async () => {
      const r = await removeGithubAppRegistrationAction(h)
      if (!r.ok) onError(r.error)
    })
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
      <h4 className="flex items-center gap-1.5 text-[13px] font-[560] text-foreground">
        {t('gheServerTitle')}
        <InfoTip
          content={
            <>
              {t('gheTip')}
              {view.callbackUrl && (
                <>
                  <br />
                  {t('gheSetupUrl')} <code>{view.callbackUrl}</code>
                </>
              )}
            </>
          }
        />
      </h4>

      {view.registrations.length > 0 && (
        <SettingsList>
          {view.registrations.map((r) => {
            // 이 GHE 서버로 설치된 조직 — 등록 행에서도 설치 상태가 바로 보인다(미설치면 outline 배지).
            // host 비교는 정규화 동등성(sameHost) — 트레일링 슬래시/대소문자만 달라도 '미설치'로 오인하지 않게.
            const installedOrgs = view.installations.filter((i) => sameHost(i.host, r.host))
            return (
              <SettingsRow
                key={r.host}
                label={
                  <span className="flex flex-wrap items-center gap-2">
                    {hostLabel(r.host)}
                    {installedOrgs.length > 0 ? (
                      <Badge tone="success">
                        {t('installedOrgsBadge', {
                          orgs: installedOrgs.map((i) => i.account).join(', '),
                        })}
                      </Badge>
                    ) : (
                      <Badge tone="outline">{t('notInstalledBadge')}</Badge>
                    )}
                  </span>
                }
                hint={t('gheRegHint', { appId: r.appId, slug: r.slug })}
              >
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={() => onInstall(r.host)}
                >
                  {t('installShort')}
                </Button>
                <button
                  type="button"
                  className="text-[12px] font-[510] text-destructive hover:underline"
                  disabled={saving}
                  onClick={() => onRemove(r.host)}
                >
                  {t('delete')}
                </button>
              </SettingsRow>
            )
          })}
        </SettingsList>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="ghe-host">{t('serverUrl')}</Label>
          <Input
            id="ghe-host"
            placeholder="https://ghe.example.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ghe-slug">App slug</Label>
          <Input
            id="ghe-slug"
            placeholder="assay-eval"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ghe-appid">App ID</Label>
          <Input
            id="ghe-appid"
            placeholder="123456"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
          />
        </div>
        {/* 개인키(PEM)는 자유 텍스트 입력이 아니라 워크스페이스 시크릿 참조 — 고르거나 인라인 생성(여러 줄 기본). */}
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="ghe-key">{t('privateKeySecret')}</Label>
          <SecretPicker
            id="ghe-key"
            value={keyName}
            onChange={setKeyName}
            names={secretNames}
            scope="workspace"
            defaultMultiline
            createValuePlaceholder={t('privateKeyPlaceholder')}
            aria-label={t('privateKeyAria')}
          />
        </div>
      </div>
      <Button size="sm" disabled={saving} onClick={onRegister}>
        {saving ? t('saving') : t('registerApp')}
      </Button>
    </div>
  )
}

// GHE 베이스 URL 동등성 — 대소문자/트레일링 슬래시 차이를 무시(서버 github-app-service 의 sameHost 미러).
function sameHost(a?: string, b?: string): boolean {
  if (a === undefined || b === undefined) return a === b
  const norm = (u: string) => (u.endsWith('/') ? u.slice(0, -1) : u).toLowerCase()
  return norm(a) === norm(b)
}

// "https://ghe.example.com" → "ghe.example.com"; github.com 설치(host 없음)는 "github.com" — 칩 상시 표기로 일관.
function hostLabel(host?: string): string {
  if (!host) return 'github.com'
  try {
    return new URL(host).host
  } catch {
    return host
  }
}
