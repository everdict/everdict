'use client'

import { Braces, LayoutPanelLeft, Workflow } from 'lucide-react'

import type { HarnessSpec } from '@/entities/harness'
import { JsonView } from '@/shared/ui/json-view'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'

import { CommandView } from './command-view'
import { ProcessView } from './process-view'
import { ServiceView } from './service-view'
import { TopologyGraph } from './topology-graph'

// 하니스 상세 — kind 별로 메인 시각화를 다르게. service 는 다이어그램 우선, 모든 kind 는 raw JSON 탭 제공.
export function HarnessDetail({ spec }: { spec: HarnessSpec }) {
  if (spec.kind === 'service') {
    return (
      <Tabs defaultValue="diagram">
        <TabsList>
          <TabsTrigger value="diagram">
            <span className="inline-flex items-center gap-1.5">
              <Workflow className="size-3.5" /> 다이어그램
            </span>
          </TabsTrigger>
          <TabsTrigger value="structure">
            <span className="inline-flex items-center gap-1.5">
              <LayoutPanelLeft className="size-3.5" /> 구성
            </span>
          </TabsTrigger>
          <TabsTrigger value="json">
            <span className="inline-flex items-center gap-1.5">
              <Braces className="size-3.5" /> JSON
            </span>
          </TabsTrigger>
        </TabsList>
        <div className="pt-5">
          <TabsContent value="diagram">
            <TopologyGraph spec={spec} />
          </TabsContent>
          <TabsContent value="structure">
            <ServiceView spec={spec} />
          </TabsContent>
          <TabsContent value="json">
            <JsonView value={spec} />
          </TabsContent>
        </div>
      </Tabs>
    )
  }

  const Structure = spec.kind === 'command' ? CommandView : ProcessView

  return (
    <Tabs defaultValue="structure">
      <TabsList>
        <TabsTrigger value="structure">
          <span className="inline-flex items-center gap-1.5">
            <LayoutPanelLeft className="size-3.5" /> 구성
          </span>
        </TabsTrigger>
        <TabsTrigger value="json">
          <span className="inline-flex items-center gap-1.5">
            <Braces className="size-3.5" /> JSON
          </span>
        </TabsTrigger>
      </TabsList>
      <div className="pt-5">
        <TabsContent value="structure">
          <Structure spec={spec} />
        </TabsContent>
        <TabsContent value="json">
          <JsonView value={spec} />
        </TabsContent>
      </div>
    </Tabs>
  )
}
