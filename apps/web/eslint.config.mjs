import nextPlugin from '@next/eslint-plugin-next'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'

export default [
  { ignores: ['.next/**', 'node_modules/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    plugins: { '@typescript-eslint': tsPlugin, '@next/next': nextPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'prefer-const': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // Links go through the app's own wrapper, which turns prefetch OFF by default. On a force-dynamic
      // route a prefetch only warms the shell the screen already renders, while every mounted link
      // re-prefetches on each router-cache invalidation and holds the in-flight mutation's transition
      // behind that queue. See src/shared/ui/link.tsx.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'next/link',
              message: "Import { Link } from '@/shared/ui/link' — it defaults prefetch to false.",
            },
          ],
        },
      ],
    },
  },
  // The one module allowed to reach for next/link: the wrapper that sets the default.
  { files: ['src/shared/ui/link.tsx'], rules: { 'no-restricted-imports': 'off' } },
]
