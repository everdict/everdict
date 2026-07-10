'use client'

import { LayoutPanelLeft, Workflow } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { HarnessSpec } from '@/entities/harness'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'

import { CommandView } from './command-view'
import { ProcessView } from './process-view'
import { ServiceView } from './service-view'
import { TopologyGraph } from './topology-graph'

// Harness detail — a clean view of the final (resolved) spec. service uses diagram/config tabs (topology is central),
// command·process are single-value views. The raw config·JSON are kept separately, collapsible, upstream.
// The image-provenance badges read the served spec.imageClasses (P1g) — no registry threading.
export function HarnessDetail({ spec }: { spec: HarnessSpec }) {
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
            <ServiceView spec={spec} />
          </TabsContent>
        </div>
      </Tabs>
    )
  }

  if (spec.kind === 'command') return <CommandView spec={spec} />
  return <ProcessView spec={spec} />
}
