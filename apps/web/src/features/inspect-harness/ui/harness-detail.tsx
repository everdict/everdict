'use client'

import { LayoutPanelLeft, Workflow } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { HarnessSpec } from '@/entities/harness'
import type { ImageRegistryCoordinates } from '@/shared/lib/image-ref'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'

import { CommandView } from './command-view'
import { ProcessView } from './process-view'
import { ServiceView } from './service-view'
import { TopologyGraph } from './topology-graph'

// 하니스 상세 — 최종(resolved) 스펙의 깔끔한 뷰. service 는 다이어그램/구성 탭(토폴로지가 핵심),
// command·process 는 단일 값 뷰. 원본 구성·JSON 은 상위에서 접이식으로 따로 둔다.
// registry = 워크스페이스 이미지 레지스트리 좌표(있으면, 복수 가능) — 서비스/커맨드 이미지의 출처 분류 배지에 쓴다.
export function HarnessDetail({
  spec,
  registry,
}: {
  spec: HarnessSpec
  registry?: ImageRegistryCoordinates | ImageRegistryCoordinates[]
}) {
  const t = useTranslations('inspectHarness')
  if (spec.kind === 'service') {
    return (
      <Tabs defaultValue="diagram">
        <TabsList>
          <TabsTrigger value="diagram">
            <span className="inline-flex items-center gap-1.5">
              <Workflow className="size-3.5" /> {t('diagram')}
            </span>
          </TabsTrigger>
          <TabsTrigger value="structure">
            <span className="inline-flex items-center gap-1.5">
              <LayoutPanelLeft className="size-3.5" /> {t('structure')}
            </span>
          </TabsTrigger>
        </TabsList>
        <div className="pt-5">
          <TabsContent value="diagram">
            <TopologyGraph spec={spec} />
          </TabsContent>
          <TabsContent value="structure">
            <ServiceView spec={spec} {...(registry ? { registry } : {})} />
          </TabsContent>
        </div>
      </Tabs>
    )
  }

  if (spec.kind === 'command')
    return <CommandView spec={spec} {...(registry ? { registry } : {})} />
  return <ProcessView spec={spec} />
}
