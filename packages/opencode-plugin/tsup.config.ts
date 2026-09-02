import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server.ts',
    tui: 'src/tui-entry.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  splitting: false,
  noExternal: ['zod'],
  clean: true,
  sourcemap: true,
})
