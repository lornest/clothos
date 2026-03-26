import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    esbuildOptions(options) {
      options.jsxImportSource = '@opentui/react';
    },
  },
  {
    entry: ['src/cli.tsx'],
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: true,
    banner: {
      js: '#!/usr/bin/env bun',
    },
    esbuildOptions(options) {
      options.jsxImportSource = '@opentui/react';
    },
  },
]);
