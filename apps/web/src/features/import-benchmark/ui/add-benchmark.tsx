'use client'

import { useState } from 'react'

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
}: {
  benchmarks: BenchmarkCatalogItem[]
  recipes: RecipeItem[]
}) {
  const [mode, setMode] = useState<'build' | 'import'>('build')
  return (
    <div className="space-y-5">
      <div className="inline-flex rounded-lg border border-border p-1">
        {(
          [
            ['build', '소스에서 만들기'],
            ['import', '카탈로그 · 레시피'],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              'rounded-md px-3 py-1 text-sm transition-colors',
              mode === m
                ? 'bg-secondary font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'build' ? (
        <BuildFromSourceWizard />
      ) : (
        <ImportBenchmarkForm benchmarks={benchmarks} recipes={recipes} />
      )}
    </div>
  )
}
