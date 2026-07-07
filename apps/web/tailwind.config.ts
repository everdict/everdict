import type { Config } from 'tailwindcss'

// Tailwind v4 — tokens live in globals.css @theme inline. Only content is declared.
const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: { extend: {} },
  plugins: [],
}

export default config
