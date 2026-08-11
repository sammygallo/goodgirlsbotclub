import { defineConfig } from 'vitest/config'

// Standalone vitest config so tests don't load vite.config.ts (react +
// tailwind plugins, backend proxy) — current tests are pure-function units
// that run in plain node. Add environment overrides per-file if a test ever
// needs a DOM (https://vitest.dev/config/#environment).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'tools/**/*.test.ts'],
    // No result cache: it writes into node_modules/.vite/vitest, which risks
    // being swept up by the blanket `git add -f node_modules` this repo uses.
    cache: false,
  },
})
