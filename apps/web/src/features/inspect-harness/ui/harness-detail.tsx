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

// Harness detail — a clean view of the final (resolved) spec. service uses diagram/config tabs (topology is central),
// command·process are single-value views. The raw config·JSON are kept separately, collapsible, upstream.
// registry = workspace image registry coordinates (if any, possibly multiple) — used for the provenance-classification badge on service/command images.
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
