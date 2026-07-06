'use client'

import { useState, useTransition } from 'react'

import { SecretPicker } from '@/features/pick-secret'
import type { TraceSinkConfig, TraceSinkKind } from '@/entities/trace-sink'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import { removeTraceSinkAction, upsertTraceSinkAction } from '../api/manage-trace-sink'

// kind별 project 필드의 의미 — 라벨/플레이스홀더를 플랫폼 용어로 맞춘다(한 필드, kind별 좌표).
const KIND_META: Record<TraceSinkKind, { label: string; project: string; placeholder: string }> = {
  mlflow: { label: 'MLflow', project: 'experiment id', placeholder: '예: 7' },
  langfuse: { label: 'Langfuse', project: 'project id (딥링크용, 선택)', placeholder: '예: cm3…' },
  langsmith: {
    label: 'LangSmith',
    project: '프로젝트 이름 (선택)',
    placeholder: '예: assay-evals',
  },
  phoenix: { label: 'Phoenix', project: '프로젝트 이름', placeholder: '예: assay' },
}

// 워크스페이스 트레이스 싱크(복수) — 관측 플랫폼(MLflow/Langfuse/LangSmith/Phoenix)을 여러 개 등록해두면,
// 스코어카드 채점이 끝날 때 케이스별 trace+점수를 하니스별로 선택된 싱크에 적재하고 스코어카드에는
// 요약과 외부 딥링크만 남긴다. 어느 싱크에 적재할지는 하니스 상세에서 하니스별로 고른다.
// 인증 값은 워크스페이스 시크릿 참조(이름)로만 저장.
export function TraceSinkManager({
  sinks,
  canWrite,
  secretNames,
}: {
  sinks: TraceSinkConfig[]
  canWrite: boolean
  secretNames: string[]
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  // 편집 대상 name — 행 클릭으로 폼에 프리필(저장은 name 기준 upsert). undefined = 새 싱크 추가.
  const [editing, setEditing] = useState<string>()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<TraceSinkKind>('mlflow')
  const [endpoint, setEndpoint] = useState('')
  const [authName, setAuthName] = useState('')
  const [project, setProject] = useState('')
  const [webUrl, setWebUrl] = useState('')
  const [created, setCreated] = useState<string[]>([])
  const names = [...new Set([...secretNames, ...created])]
  const meta = KIND_META[kind]

  function resetForm() {
    setEditing(undefined)
    setName('')
    setKind('mlflow')
    setEndpoint('')
    setAuthName('')
    setProject('')
    setWebUrl('')
  }

  function startEdit(s: TraceSinkConfig) {
    setError(undefined)
    setEditing(s.name)
    setName(s.name)
    setKind(s.kind)
    setEndpoint(s.endpoint)
    setAuthName(s.authSecretName ?? '')
    setProject(s.project ?? '')
    setWebUrl(s.webUrl ?? '')
  }

  function onSave() {
    setError(undefined)
    if (!name.trim()) {
      setError('싱크 이름을 입력해주세요.')
      return
    }
    if (!endpoint.trim()) {
      setError('플랫폼 API 베이스 URL 을 입력해주세요.')
      return
    }
    startTransition(async () => {
      const r = await upsertTraceSinkAction({
        name: name.trim(),
        kind,
        endpoint: endpoint.trim(),
        ...(authName.trim() ? { authSecretName: authName.trim() } : {}),
        ...(project.trim() ? { project: project.trim() } : {}),
        ...(webUrl.trim() ? { webUrl: webUrl.trim() } : {}),
      })
      if (!r.ok) setError(r.error)
      else resetForm()
    })
  }

  function onRemove(target: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await removeTraceSinkAction(target)
      if (!r.ok) setError(r.error)
      else if (editing === target) resetForm()
    })
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="flex items-center gap-1.5 text-[13px] font-[560] text-foreground">
          트레이스 싱크
          <InfoTip
            content={
              <>
                팀이 쓰는 관측 플랫폼을 등록해두면 스코어카드 채점이 끝날 때 케이스별 trace 와
                점수를 그쪽에 적재하고, 스코어카드에는 요약과 바로가기 링크만 남아요. 싱크는 여러 개
                등록할 수 있고, 어느 싱크에 적재할지는 하니스별로 골라요(하니스 상세에서 선택). 이미
                그 플랫폼에 있는 trace 를 pull 로 가져와 채점한 경우엔 복제하지 않고 원본 trace 에
                점수만 붙여요. 인증 값은 워크스페이스 시크릿에서 고르거나 “새로”로 바로 저장해요 —
                여기엔 그 이름만 남아요.
              </>
            }
          />
        </h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          상세 결과의 진실원천을 팀 데이터레이크(MLflow·Langfuse·LangSmith·Phoenix)로 둬요. 적재할
          싱크는 하니스 상세에서 하니스별로 골라요.
        </p>
      </div>

      {sinks.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">아직 등록된 트레이스 싱크가 없어요.</p>
      ) : (
        <SettingsList>
          {sinks.map((s) => (
            <SettingsRow
              key={s.name}
              label={
                <span className="inline-flex items-center gap-1.5">
                  {s.name}
                  <Badge tone="info">{KIND_META[s.kind].label}</Badge>
                </span>
              }
              hint={<span className="break-all font-mono text-[11.5px]">{s.endpoint}</span>}
            >
              {canWrite && (
                <>
                  <button
                    type="button"
                    className="text-[12px] font-[510] text-link hover:text-foreground"
                    disabled={pending}
                    onClick={() => startEdit(s)}
                  >
                    편집
                  </button>
                  <button
                    type="button"
                    className="text-[12px] font-[510] text-destructive hover:underline"
                    disabled={pending}
                    onClick={() => onRemove(s.name)}
                  >
                    삭제
                  </button>
                </>
              )}
            </SettingsRow>
          ))}
        </SettingsList>
      )}

      {canWrite && (
        <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
          <p className="text-[12px] font-[560] text-foreground">
            {editing ? `${editing} 수정` : '새 싱크 추가'}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="ts-name">이름</Label>
              {/* 이름 = upsert 키 — 편집 중엔 잠가서 의도치 않은 별도 싱크 생성(rename≠upsert)을 막는다. */}
              <Input
                id="ts-name"
                placeholder="예: team-mlflow"
                value={name}
                disabled={editing !== undefined}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ts-kind">플랫폼</Label>
              <Combobox
                id="ts-kind"
                options={(Object.keys(KIND_META) as TraceSinkKind[]).map((k) => ({
                  value: k,
                  label: KIND_META[k].label,
                }))}
                value={kind}
                onChange={(v) => setKind(v as TraceSinkKind)}
                aria-label="관측 플랫폼 선택"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ts-endpoint">API 베이스 URL</Label>
              <Input
                id="ts-endpoint"
                placeholder={
                  kind === 'langsmith'
                    ? 'https://api.smith.langchain.com'
                    : 'http://mlflow.corp.io:5000'
                }
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </div>
            {/* 인증 값은 자유 텍스트가 아니라 워크스페이스 시크릿 참조 — 고르거나 인라인 생성. */}
            <div className="space-y-1">
              <Label htmlFor="ts-auth" className="flex items-center gap-1.5">
                인증 시크릿 (선택)
                <InfoTip
                  content={
                    <>
                      플랫폼이 기대하는 인증 헤더의 값 그대로예요 — MLflow/Langfuse 는{' '}
                      <span className="font-mono">Basic …</span>, Phoenix 는{' '}
                      <span className="font-mono">Bearer …</span>, LangSmith 는 API 키 원문. 무인증
                      dev 서버면 비워둬요.
                    </>
                  }
                />
              </Label>
              <SecretPicker
                id="ts-auth"
                value={authName}
                onChange={setAuthName}
                names={names}
                scope="workspace"
                onCreated={(n) => setCreated((c) => [...c, n])}
                createValuePlaceholder="인증 헤더 값 붙여넣기"
                aria-label="인증 시크릿 선택"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ts-project">{meta.project}</Label>
              <Input
                id="ts-project"
                placeholder={meta.placeholder}
                value={project}
                onChange={(e) => setProject(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ts-web" className="flex items-center gap-1.5">
                UI 링크 베이스 (선택)
                <InfoTip
                  content={
                    <>
                      바로가기 링크를 만들 때 쓸 웹 UI 주소예요. API 주소와 다를 때만 입력해요 — 예:
                      LangSmith 는 API 가 api.smith.langchain.com, UI 는 smith.langchain.com.
                    </>
                  }
                />
              </Label>
              <Input
                id="ts-web"
                placeholder="https://…"
                value={webUrl}
                onChange={(e) => setWebUrl(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button size="sm" disabled={pending} onClick={onSave}>
              {pending ? '저장 중…' : editing ? '갱신' : '등록'}
            </Button>
            {editing && (
              <button
                type="button"
                className="text-[12px] text-muted-foreground hover:text-foreground"
                disabled={pending}
                onClick={resetForm}
              >
                취소
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}
