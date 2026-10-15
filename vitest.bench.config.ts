import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Config for the live benchmark only (`npm run bench:chat`).
 *
 * `tests/bench/chat.live.bench.ts` deliberately does not match the default
 * test-file include pattern, so `npm test` stays fast; this config widens
 * the include just for the bench run and gives the real-model tests the long
 * timeouts they need.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@main': path.resolve(__dirname, 'src/main'),
      '@renderer': path.resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/bench/**/*.bench.ts'],
    globals: true,
    testTimeout: 600_000,
    hookTimeout: 120_000
  }
})
