import type { Config } from 'tailwindcss'

// Tailwind v4 — 토큰은 globals.css 의 @theme inline 에 있음. content 만 선언.
const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: { extend: {} },
  plugins: [],
}

export default config
