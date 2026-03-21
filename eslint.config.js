import globals from 'globals';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import noCatchAll from 'eslint-plugin-no-catch-all';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'container/', 'groups/'],
  },
  { languageOptions: { globals: globals.node } },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['src/**/*.{js,ts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'no-catch-all': noCatchAll },
    rules: {
      // Allow unused vars prefixed with _ (common pattern)
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Allow explicit any where needed (pragmatic for this codebase)
      '@typescript-eslint/no-explicit-any': 'off',
      // Allow non-null assertions (useful with SQLite results etc.)
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Floating promises are bugs - must be awaited or void'd
      '@typescript-eslint/no-floating-promises': 'error',
      // Misused promises (e.g. passing async to void-returning callback)
      '@typescript-eslint/no-misused-promises': 'error',
      // Allow async functions without await (common in interface implementations)
      '@typescript-eslint/require-await': 'off',
      // Allow empty catch blocks with a comment
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Catch-all detection
      'no-catch-all/no-catch-all': 'warn',
    },
  }
);
