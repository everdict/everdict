'use client'

import { useState, useTransition } from 'react'

import { SecretPicker } from '@/features/pick-secret'
import type { TraceSinkConfig, TraceSinkKind } from '@/entities/trace-sink'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

import { removeTraceSinkAction, setTraceSinkAction } from '../api/manage-trace-sink'

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

// 워크스페이스 트레이스 싱크 — 스코어카드 채점이 끝나면 케이스별 trace+점수를 팀 관측 플랫폼
// (MLflow/Langfuse/LangSmith/Phoenix)에 적재하고, 스코어카드에는 요약과 외부 딥링크만 남긴다.
// 인증 값은 워크스페이스 시크릿 참조(이름)로만 저장.
export function TraceSinkManager({
  config,
  canWrite,
  secretNames,
}: {
  config?: TraceSinkConfig
  canWrite: boolean
  secretNames: string[]
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [kind, setKind] = useState<TraceSinkKind>(config?.kind ?? 'mlflow')
  const [endpoint, setEndpoint] = useState(config?.endpoint ?? '')
  const [authName, setAuthName] = useState(config?.authSecretName ?? '')
  const [project, setProject] = useState(config?.project ?? '')
  const [webUrl, setWebUrl] = useState(config?.webUrl ?? '')
  const [created, setCreated] = useState<string[]>([])
  const names = [...new Set([...secretNames, ...created])]
  const meta = KIND_META[kind]

  function onSave() {
    setError(undefined)
    if (!endpoint.trim()) {
      setError('플랫폼 API 베이스 URL 을 입력해주세요.')
      return
    }
    startTransition(async () => {
      const r = await setTraceSinkAction({
        kind,
        endpoint: endpoint.trim(),
        ...(authName.trim() ? { authSecretName: authName.trim() } : {}),
        ...(project.trim() ? { project: project.trim() } : {}),
        ...(webUrl.trim() ? { webUrl: webUrl.trim() } : {}),
      })
      if (!r.ok) setError(r.error)
    })
  }
  function onRemove() {
    setError(undefined)
    startTransition(async () => {
      const r = await removeTraceSinkAction()
      if (r.ok) {
        setEndpoint('')
        setAuthName('')
        setProject('')
        setWebUrl('')
      } else setError(r.error)
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
                팀이 쓰는 관측 플랫폼을 등록하면 스코어카드 채점이 끝날 때 케이스별 trace 와 점수를
                그쪽에 적재하고, 스코어카드에는 요약과 바로가기 링크만 남아요. 이미 그 플랫폼에 있는
                trace 를 pull 로 가져와 채점한 경우엔 복제하지 않고 원본 trace 에 점수만 붙여요.
                인증 값은 워크스페이스 시크릿에서 고르거나 “새로”로 바로 저장해요 — 여기엔 그 이름만
                남아요.
              </>
            }
          />
        </h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          상세 결과의 진실원천을 팀 데이터레이크(MLflow·Langfuse·LangSmith·Phoenix)로 둬요.
        </p>
      </div>

      {canWrite ? (
        <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
          <div className="grid gap-3 sm:grid-cols-2">
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
            <div className="space-y-1 sm:col-span-2">
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
              {pending ? '저장 중…' : config ? '갱신' : '등록'}
            </Button>
            {config && (
              <button
                type="button"
                className="text-[12px] font-[510] text-destructive hover:underline"
                disabled={pending}
                onClick={onRemove}
              >
                해제
              </button>
            )}
          </div>
        </div>
      ) : config ? (
        <p className="text-[13px] text-muted-foreground">
          {KIND_META[config.kind].label}({config.endpoint})에 적재가 연결돼 있어요.
        </p>
      ) : (
        <p className="text-[13px] text-muted-foreground">아직 트레이스 싱크가 설정되지 않았어요.</p>
      )}

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}
