'use client'

import { Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { startProductTour } from '@/shared/lib/tour'
import { Button } from '@/shared/ui/button'

// 가이드 페이지의 "제품 둘러보기" — 사이드바에 마운트된 ProductTour(AppShell)에게 재실행을 알린다(모듈 커스텀 이벤트).
export function StartTourButton() {
  const t = useTranslations('guidePage')
  return (
    <Button
      variant="secondary"
      size="sm"
      // 투어는 데스크탑 사이드바를 짚으므로 모바일에선 숨긴다(가이드 본문은 모바일에서도 그대로 읽힘).
      className="hidden md:inline-flex"
      onClick={() => startProductTour()}
    >
      <Sparkles />
      {t('takeTour')}
    </Button>
  )
}
