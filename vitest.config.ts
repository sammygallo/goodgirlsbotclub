import { defineConfig } from 'vitest/config'

// Standalone vitest config so tests don't load vite.config.ts (tailwind
// plugin, backend proxy). Almost every suite here is a pure-function unit
// that runs in plain node, and the default environment stays `node` so
// they keep paying nothing for a DOM they don't use.
//
// A suite that DOES need a DOM opts in per file with a docblock:
//
//   /** @vitest-environment jsdom */
//
// `src/components/works/StoryTab.test.tsx` is currently the only one.
// Component tests need the react plugin for JSX, which is why it is
// loaded below — esbuild alone would not transform .tsx the way React 19
// expects.
//
// jsdom rather than happy-dom, deliberately. Both are optional peers of
// vitest and either runs these tests unchanged, but this repo
// force-commits node_modules and jsdom costs ~1.5k fewer tracked files
// (11M on disk vs 17M). happy-dom starts faster (~158ms vs ~424ms of
// environment setup); with exactly one DOM suite that is not worth the
// committed weight. Revisit if component tests spread.
//
// `tools/` is included too: the source-hygiene guard lives there because
// it needs node's fs, which tsconfig.app.json deliberately does not carry.
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'tools/**/*.test.ts'],
    // No result cache: it writes into node_modules/.vite/vitest, which risks
    // being swept up by the blanket `git add -f node_modules` this repo uses.
    cache: false,
  },
})
