import path from 'node:path'
import { defineConfig } from 'vitest/config'

// The web declares no vitest of its own (it comes from the ROOT devDependency); this config exists only so a
// test can import a UI module through the app's own `@/` alias — plain `vitest run` cannot resolve it.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: { include: ['src/**/*.test.{ts,tsx}'] },
})
