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
    '@cuppet/runtime-darwin-arm64',
    '@cuppet/runtime-darwin-x64',
    '@cuppet/runtime-linux-arm64-gnu',
    '@cuppet/runtime-linux-x64-gnu',
  ],
})
