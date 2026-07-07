'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

import { BuildFromSourceWizard } from './build-from-source-wizard'
import {
  ImportBenchmarkForm,
  type BenchmarkCatalogItem,
  type RecipeItem,
} from './import-benchmark-form'

// "벤치마크 추가" 진입점 — 두 모드:
//  · 소스에서 만들기(기본): 가이드 위저드(소스→미리보기/필드감지→매핑→한 번에 생성). 신규 벤치마크의 주 경로.
//  · 카탈로그·레시피: 기존 first-party 카탈로그/등록된 레시피에서 가져오기.
export function AddBenchmark({
  benchmarks,
  recipes,
  existingDatasets = [],
  preselectRecipe,
  hfTokenScope,
}: {
  benchmarks: BenchmarkCatalogItem[]
  recipes: RecipeItem[]
  existingDatasets?: { id: string; versions: string[] }[]
  preselectRecipe?: string
  hfTokenScope?: 'user' | 'workspace' // 사용 가능한 HF_TOKEN 시크릿의 스코프(없으면 미보유 — gated 안내)
}) {
  const t = useTranslations('importBenchmark')
  // 레시피 상세에서 "데이터셋으로 만들기"로 진입하면(?recipe=) 가져오기 모드로 시작 + 해당 레시피 프리셀렉트.
  const [mode, setMode] = useState<'build' | 'import'>(preselectRecipe ? 'import' : 'build')
  return (
    <div className="space-y-5">
      <div className="inline-flex rounded-lg border bg-secondary/40 p-0.5">
        {(
          [
            ['build', t('modeBuild')],
            ['import', t('modeImport')],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              'rounded-md px-3 py-1 text-[13px] transition-colors',
              mode === m
                ? 'bg-card font-[510] text-foreground shadow-raise'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'build' ? (
        <BuildFromSourceWizard
          existingDatasets={existingDatasets}
          {...(hfTokenScope ? { hfTokenScope } : {})}
        />
      ) : (
        <ImportBenchmarkForm
          benchmarks={benchmarks}
          recipes={recipes}
          existingDatasets={existingDatasets}
          preselect={preselectRecipe ? `recipe:${preselectRecipe}` : undefined}
        />
      )}
    </div>
  )
}
