#!/usr/bin/env node
import { copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = resolve(root, 'packages/cli')
for (const name of ['LICENSE', 'NOTICE', 'README.md', 'THIRD_PARTY_NOTICES.md']) {
  await copyFile(resolve(root, name), resolve(destination, name))
}

process.stdout.write('staged thin-package documentation\n')
