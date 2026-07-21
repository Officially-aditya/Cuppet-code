import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  noExternal: ['zod'],
  clean: true,
  sourcemap: true,
})
