#!/usr/bin/env node
import { copyFile, cp, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = resolve(root, 'packages/cli')
for (const name of ['LICENSE', 'NOTICE', 'README.md', 'THIRD_PARTY_NOTICES.md']) {
  await copyFile(resolve(root, name), resolve(destination, name))
}
// Ship the remote-control PWA next to dist so the relay can serve it.
await mkdir(resolve(destination, 'relay-app'), { recursive: true })
await cp(resolve(destination, 'src/remote/app'), resolve(destination, 'relay-app'), { recursive: true })

process.stdout.write('staged thin-package documentation\n')
