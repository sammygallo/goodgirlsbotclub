import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Nested Claude Code worktree checkouts under .claude/worktrees/ are full,
  // independent clones (often at other commits) that live physically inside
  // this tree. `eslint .` would otherwise recurse into them and lint stale
  // code that isn't part of this checkout.
  //
  // .claude/workflows/*.js are agent-orchestration scripts, not app code. The
  // workflow runtime executes them as a function body — top-level `return` and
  // injected globals (`agent`, `parallel`, `phase`, `log`, `args`) are part of
  // that contract — so parsing them as ES modules reports a spurious
  // "'return' outside of function" error.
  globalIgnores(['dist', '.claude/worktrees/**', '.claude/workflows/**']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // A leading underscore marks a binding as intentionally unused:
      // placeholder props (`_props`), rest-destructuring discards
      // (`const { [k]: _removed, ...rest }`), ignored tuple slots.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // Modals and panels here reset their local state in a "when opened"
      // effect (~46 sites, e.g. GenerateLorebookModal, AISettingsPage's key
      // cards). eslint-plugin-react-hooks 7.1 promoted this rule into
      // `recommended`; migrating every site to keyed remounts / derived state
      // is its own project, so the convention stays and the rule is off.
      'react-hooks/set-state-in-effect': 'off',
      // This build does not run the React Compiler, so there is no compiled
      // output whose memoization could diverge from the manual one.
      'react-hooks/preserve-manual-memoization': 'off',
      // Files mixing a component with its hook or helpers (Toast +
      // useToast + showToastGlobal, contexts, extension builtins) are an
      // established pattern here. The cost is coarser HMR invalidation,
      // not correctness — keep it advisory.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
])
