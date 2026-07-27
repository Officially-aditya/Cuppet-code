import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts', 'src/tui.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  splitting: false,
  noExternal: ['zod'],
  clean: true,
  sourcemap: true,
})
