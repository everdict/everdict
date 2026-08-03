'use client'

import { useState } from 'react'
import { Check, Link2 } from 'lucide-react'
import { useLocale } from 'next-intl'

import { copyText } from '@/shared/lib/clipboard'
import { cn } from '@/shared/lib/utils'

// 지금 보고 있는 페이지의 주소를 복사한다. 값을 prop 으로 받지 않는 이유는 서버 컴포넌트가 origin 을 모르기
// 때문 — 경로만 넘기면 붙여넣을 수 없는 반쪽 링크가 된다. 정규 주소로의 리다이렉트가 이미 끝난 뒤이므로
// location.href 가 곧 공유해도 되는 주소다(이슈라면 `/{workspace}/issues/ENG-12`).
export function CopyLinkButton({
  label,
  message,
  className,
}: {
  label: string
  message?: string | null
  className?: string
}) {
  const locale = useLocale()
  const [copied, setCopied] = useState(false)

  async function copy() {
    // http(비보안) 컨텍스트 폴백까지 clipboard 헬퍼가 처리한다.
    if (await copyText(window.location.href, message, locale)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      title={label}
      className={cn(
        'rounded p-1 text-faint transition-colors hover:bg-accent hover:text-foreground',
        className
      )}
    >
      {copied ? (
        <Check className="size-3.5 text-[var(--color-success)]" />
      ) : (
        <Link2 className="size-3.5" />
      )}
    </button>
  )
}
