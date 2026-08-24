#!/usr/bin/env node
import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = resolve(root, 'packages', 'cli')

// These files are copied by prepack and must never become working-tree changes.
for (const name of ['LICENSE', 'NOTICE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'relay-app']) {
  await rm(resolve(packageRoot, name), { recursive: true, force: true })
}
