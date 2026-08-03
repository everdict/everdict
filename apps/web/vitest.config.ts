import path from 'node:path'
import { defineConfig } from 'vitest/config'

// The web declares no vitest of its own (it comes from the ROOT devDependency); this config exists only so a
// test can import a UI module through the app's own `@/` alias — plain `vitest run` cannot resolve it.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // `server-only` is a build-time marker Next resolves, not a package this app depends on — see the stub.
      'server-only': path.resolve(__dirname, 'vitest.server-only-stub.ts'),
    },
  },
  test: { include: ['src/**/*.test.{ts,tsx}'] },
})
