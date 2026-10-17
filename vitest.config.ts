import { defineConfig } from 'vitest/config'
import path from 'node:path'

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
    include: ['tests/**/*.test.ts'],
    globals: true,
    // A hang detector, not a speed claim. Nothing in the suite asserts elapsed
    // time any more, but the first import of a module graph is charged to the test
    // that triggers it, and this suite compiles the whole platform API and spawns
    // real child processes. At the 5s default, a busy machine failed tests that
    // pass — which is exactly the signal a local run cannot afford to lose.
    testTimeout: 15_000
  }
})
