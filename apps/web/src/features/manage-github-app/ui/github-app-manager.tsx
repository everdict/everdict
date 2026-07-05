'use client'

import { useState, useTransition } from 'react'

import type { GithubAppView } from '@/entities/github-app'
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

// 워크스페이스 소유 GitHub App 통합 — 조직 설치→선택 repo→워크스페이스 소유 installation(개인 연결 대체).
// github.com 은 원클릭 설치(operator env App), GHE 는 관리자가 각 서버 App 을 등록 후 설치. authZ 는 컨트롤플레인이 강제.
export function GithubAppManager({ view, canWrite }: { view: GithubAppView; canWrite: boolean }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [showGhe, setShowGhe] = useState(view.registrations.length > 0)

  function onInstall(host?: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await startGithubAppInstallAction(host)
      if (r.ok && r.installUrl) window.location.href = r.installUrl
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
                제한돼요.
              </>
            }
          />
        </h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          비공개 저장소를 워크스페이스 단위로 연결해요. 설치할 때 고른 저장소만 접근할 수 있어요.
        </p>
      </div>

      {view.installations.length > 0 && (
        <SettingsList>
          {view.installations.map((i) => (
            <SettingsRow
              key={i.installationId}
              label={
                <span className="flex items-center gap-2">
                  <span className="text-[13px] font-[560] text-foreground">{i.account}</span>
                  {i.host && <span className="text-[12px] text-faint">{hostLabel(i.host)}</span>}
                </span>
              }
              hint={`설치 #${i.installationId} · ${new Date(i.connectedAt).toLocaleDateString('ko-KR')}`}
            >
              {canWrite && (
                <button
                  type="button"
                  className="text-[12px] font-[510] text-destructive hover:underline"
                  disabled={pending}
                  onClick={() => onUnlink(i.installationId)}
                >
                  연결 해제
                </button>
              )}
            </SettingsRow>
          ))}
        </SettingsList>
      )}

      {canWrite ? (
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
      ) : (
        view.installations.length === 0 && (
          <p className="text-[13px] text-muted-foreground">아직 설치된 GitHub App 이 없어요.</p>
        )
      )}

      {canWrite && showGhe && (
        <GheSection view={view} pending={pending} onInstall={onInstall} onError={setError} />
      )}

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}

// GitHub Enterprise — 각 GHE 서버에 App 을 만들어 등록(host+slug+appId+개인키 SecretStore 이름) 후 설치.
function GheSection({
  view,
  pending,
  onInstall,
  onError,
}: {
  view: GithubAppView
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
              시크릿에 먼저 저장하고 그 이름만 지정해요.
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
          {view.registrations.map((r) => (
            <SettingsRow key={r.host} label={hostLabel(r.host)} hint={`App ${r.appId} · ${r.slug}`}>
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
          ))}
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
        <div className="space-y-1">
          <Label htmlFor="ghe-key">개인키 시크릿 이름</Label>
          <Input
            id="ghe-key"
            placeholder="GHE_APP_PRIVATE_KEY"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
          />
        </div>
      </div>
      <Button size="sm" disabled={saving} onClick={onRegister}>
        {saving ? '저장 중…' : 'App 등록'}
      </Button>
    </div>
  )
}

// "https://ghe.example.com" → "ghe.example.com" (표시용). 파싱 실패 시 원본.
function hostLabel(host: string): string {
  try {
    return new URL(host).host
  } catch {
    return host
  }
}
