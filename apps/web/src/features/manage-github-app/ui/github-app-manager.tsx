'use client'

import { useState, useTransition } from 'react'

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
const INSTALL_ERROR_TEXT: Record<string, string> = {
  missing_state: '설치 확인에 필요한 요청 정보가 없어요. 설치를 다시 시작해주세요.',
  invalid_state: '설치 요청이 만료됐거나 이미 사용됐어요. 설치를 다시 시작해주세요.',
  missing_installation: 'GitHub 이 설치 정보를 주지 않았어요. 설치를 다시 시작해주세요.',
  install_failed:
    '설치 확인에 실패했어요. App 자격증명(GHE 는 등록한 App ID·개인키)을 확인해주세요.',
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
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [showGhe, setShowGhe] = useState(view.registrations.length > 0)

  function onInstall(host?: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await startGithubAppInstallAction(host)
      // 설치는 새 탭에서 — 설정 화면을 떠나지 않고 GitHub 설치 플로우를 진행.
      if (r.ok && r.installUrl) window.open(r.installUrl, '_blank', 'noopener,noreferrer')
      else setError(r.error ?? '설치를 시작하지 못했어요.')
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
          GitHub App (조직)
          <InfoTip
            content={
              <>
                조직에 Assay GitHub App 을 설치하고 저장소를 선택하면, 그 저장소를 워크스페이스가 팀
                공용으로 clone 해요(멤버 개인 로그인과 무관). 접근은 GitHub 이 선택한 저장소로만
                제한돼요. github.com 과 GitHub Enterprise 둘 다 같은 방식이에요.
              </>
            }
          />
        </h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          비공개 저장소를 워크스페이스 단위로 연결해요. 설치할 때 고른 저장소만 접근할 수 있어요.
        </p>
      </div>

      {/* 설치 콜백 직후 피드백 — GitHub 에서 돌아온 순간 "됐다/안 됐다"를 명시적으로 알린다. */}
      {notice?.installed && (
        <Callout tone="info" className="py-1.5">
          GitHub App 설치가 연결됐어요. 아래 설치 목록에서 허용된 저장소를 확인하세요.
        </Callout>
      )}
      {notice?.error && (
        <Callout tone="danger" className="py-1.5">
          {INSTALL_ERROR_TEXT[notice.error] ?? `설치에 실패했어요 (${notice.error})`}
        </Callout>
      )}

      {view.installations.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-4 py-5">
          <p className="text-[13px] text-muted-foreground">아직 설치된 GitHub App 이 없어요.</p>
          <p className="mt-1 text-[12px] text-faint">
            {canWrite
              ? '‘GitHub App 설치’로 조직에 설치하고 저장소를 고르면, 여기에 설치 상태와 허용 저장소가 보여요.'
              : 'GitHub App 설치는 관리자가 해요.'}
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
            GitHub App 설치
          </Button>
          <button
            type="button"
            className="text-[12px] font-[510] text-primary hover:underline"
            onClick={() => setShowGhe((v) => !v)}
          >
            GitHub Enterprise…
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
          <span>설치 {new Date(install.connectedAt).toLocaleDateString('ko-KR')}</span>
          <span>·</span>
          {install.reposError ? (
            <span className="text-[var(--color-warning)]">{install.reposError}</span>
          ) : repos.length === 0 ? (
            <span>허용된 저장소가 없어요 — GitHub 의 설치 설정에서 저장소를 선택해주세요.</span>
          ) : (
            <>
              <span>허용 저장소 {repos.length}개</span>
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
                  {expanded ? '접기' : `+${repos.length - REPO_PREVIEW_COUNT}개 더`}
                </button>
              )}
            </>
          )}
        </span>
      }
    >
      <Badge tone="success">설치됨</Badge>
      {canWrite && (
        <button
          type="button"
          className="text-[12px] font-[510] text-destructive hover:underline"
          disabled={pending}
          onClick={() => onUnlink(install.installationId)}
        >
          연결 해제
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
  const [saving, startSaving] = useTransition()
  const [host, setHost] = useState('')
  const [slug, setSlug] = useState('')
  const [appId, setAppId] = useState('')
  const [keyName, setKeyName] = useState('')

  function onRegister() {
    onError(undefined)
    if (!host.trim() || !slug.trim() || !appId.trim() || !keyName.trim()) {
      onError('모든 필드를 입력해주세요.')
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
        GitHub Enterprise 서버
        <InfoTip
          content={
            <>
              GHE 는 서버마다 App 을 직접 만들어 등록해야 해요. App 개인키(PEM)는 워크스페이스
              시크릿에서 고르거나 “새로”로 바로 저장해요 — 등록엔 그 이름만 남아요. 설치가 끝나면 위
              설치 목록에 github.com 과 똑같이 보여요.
              {view.callbackUrl && (
                <>
                  <br />
                  App Setup URL: <code>{view.callbackUrl}</code>
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
            const installedOrgs = view.installations.filter((i) => i.host === r.host)
            return (
              <SettingsRow
                key={r.host}
                label={
                  <span className="flex flex-wrap items-center gap-2">
                    {hostLabel(r.host)}
                    {installedOrgs.length > 0 ? (
                      <Badge tone="success">
                        설치됨 · {installedOrgs.map((i) => i.account).join(', ')}
                      </Badge>
                    ) : (
                      <Badge tone="outline">미설치</Badge>
                    )}
                  </span>
                }
                hint={`App ${r.appId} · ${r.slug}`}
              >
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={() => onInstall(r.host)}
                >
                  설치
                </Button>
                <button
                  type="button"
                  className="text-[12px] font-[510] text-destructive hover:underline"
                  disabled={saving}
                  onClick={() => onRemove(r.host)}
                >
                  삭제
                </button>
              </SettingsRow>
            )
          })}
        </SettingsList>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="ghe-host">서버 URL</Label>
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
          <Label htmlFor="ghe-key">개인키 시크릿</Label>
          <SecretPicker
            id="ghe-key"
            value={keyName}
            onChange={setKeyName}
            names={secretNames}
            scope="workspace"
            defaultMultiline
            createValuePlaceholder="-----BEGIN RSA PRIVATE KEY----- (PEM 붙여넣기)"
            aria-label="개인키 시크릿 선택"
          />
        </div>
      </div>
      <Button size="sm" disabled={saving} onClick={onRegister}>
        {saving ? '저장 중…' : 'App 등록'}
      </Button>
    </div>
  )
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
