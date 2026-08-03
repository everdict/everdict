'use client'

import { useState } from 'react'
import { Container } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { CapabilityImageClass } from '@/entities/capability'
import { displayImageRef } from '@/shared/lib/image-ref'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'

import { listStoreEnvironmentsAction, type StoreEnvironment } from '../api/list-environments'

// 이미지 값 옆의 "스토어에서" 피커 — 스토어의 environment(평가환경 이미지) 자산을 골라 이미지 ref 를 그대로 삽입한다.
// 하네스 핀/서비스/커맨드 이미지와 데이터셋 케이스 이미지가 같은 피커를 쓴다(pick-secret 과 같은 공용 슬라이스).
// 목록은 처음 열 때 1회 로드(서버 액션); 분류 배지는 컨트롤플레인이 뷰어 워크스페이스 기준으로 계산해 준 값.
const IMG_CLASS_TONE: Record<CapabilityImageClass, 'success' | 'info' | 'warning'> = {
  managed: 'success',
  workspace: 'success',
  external: 'info',
  local: 'warning',
  unqualified: 'warning',
}

export function EnvironmentPicker({ onPick }: { onPick: (env: StoreEnvironment) => void }) {
  const t = useTranslations('pickEnvironment')
  const [environments, setEnvironments] = useState<StoreEnvironment[]>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)

  const load = async () => {
    if (environments !== undefined || loading) return
    setLoading(true)
    const r = await listStoreEnvironmentsAction()
    setLoading(false)
    if (r.ok) setEnvironments(r.environments ?? [])
    else setError(r.error)
  }

  return (
    <DropdownMenu
      align="end"
      contentClassName="w-80"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={() => {
            void load()
            toggle()
          }}
          aria-expanded={open}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-[12px] font-medium ring-1 ring-inset transition-colors',
            open
              ? 'bg-primary/10 text-primary ring-primary/30'
              : 'text-muted-foreground ring-border hover:bg-accent hover:text-foreground'
          )}
        >
          <Container className="size-3.5" />
          {t('envPickerButton')}
        </button>
      )}
    >
      {error !== undefined ? (
        <p className="px-3 py-2 text-[12px] text-destructive">{error}</p>
      ) : environments === undefined ? (
        <p className="px-3 py-2 text-[12px] text-muted-foreground">{t('envPickerLoading')}</p>
      ) : environments.length === 0 ? (
        <p className="px-3 py-2 text-[12px] text-muted-foreground">{t('envPickerEmpty')}</p>
      ) : (
        environments.map((env) => (
          <DropdownItem key={env.key} onSelect={() => onPick(env)} className="py-2">
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="min-w-0 truncate font-mono text-[12.5px] font-medium">
                  {env.name}
                </span>
                {env.benchmark && (
                  <Badge tone="outline" className="shrink-0">
                    {env.benchmark}
                  </Badge>
                )}
                {env.imageClass && (
                  <Badge tone={IMG_CLASS_TONE[env.imageClass]} className="shrink-0">
                    {env.imageClass}
                  </Badge>
                )}
                {env.adopted &&
                  (env.pullable === false ? (
                    <Badge tone="warning" className="shrink-0">
                      {t('envNotPullable')}
                    </Badge>
                  ) : (
                    <Badge tone="success" className="shrink-0">
                      {t('envAdopted')}
                    </Badge>
                  ))}
              </span>
              <span
                className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground"
                title={env.image}
              >
                {displayImageRef(env.image)}
              </span>
            </span>
          </DropdownItem>
        ))
      )}
    </DropdownMenu>
  )
}
