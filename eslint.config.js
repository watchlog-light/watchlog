// SPDX-License-Identifier: AGPL-3.0-only
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'agent/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    files: ['web/**/*.{ts,vue}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['backend/**/*.ts', '*.js', 'scripts/**/*.{js,mjs,ts}', 'deploy/**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    // The base skeleton block keeps the plain name its family is built on (SkeletonTable, …).
    files: ['web/**/*.vue'],
    rules: { 'vue/multi-word-component-names': ['error', { ignores: ['Skeleton'] }] },
  },
  prettier,
);
