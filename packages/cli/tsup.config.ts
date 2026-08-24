import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.tsx'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  clean: true,
  dts: false,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  external: [
    '@cuppet-code/runtime-darwin-arm64',
    '@cuppet-code/runtime-darwin-x64',
    '@cuppet-code/runtime-linux-arm64-gnu',
    '@cuppet-code/runtime-linux-x64-gnu',
  ],
})
