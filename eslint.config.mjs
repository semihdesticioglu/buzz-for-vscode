// ESLint: TypeScript sources with the recommended rules, the webview script as a browser script.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'coverage/**', 'node_modules/**', '*.vsix'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'error',
    },
  },
  {
    files: ['media/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, acquireVsCodeApi: 'readonly' } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
  { files: ['eslint.config.mjs', 'esbuild.mjs'], languageOptions: { sourceType: 'module', globals: globals.node } },
  {
    // the CLI recording tools (test/cli-contract): plain Node scripts
    files: ['test/cli-contract/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // the harnesses: Node scripts that also hold code the headless browser runs (page.evaluate)
    files: ['test/harness/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser, acquireVsCodeApi: 'readonly' } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-unused-vars': 'off', // the base rule above covers plain JS
      '@typescript-eslint/no-require-imports': 'off', // CommonJS scripts
      '@typescript-eslint/no-unused-expressions': 'off', // `cond && check()` is the harness idiom
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
