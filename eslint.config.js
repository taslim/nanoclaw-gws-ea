import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'container/', '**/*.js', '**/*.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow unused vars prefixed with _ (common pattern)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
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
    },
  }
);
