import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'

import { OPENCODE_REVISION, OPENCODE_VERSION } from '../constants.js'

export const DERIVATIVE_MARKER_SCHEMA = 1 as const
export const DERIVATIVE_PRODUCT = 'cuppet-opencode-derivative' as const

export type DerivativeMarker = {
  schema: typeof DERIVATIVE_MARKER_SCHEMA
  product: typeof DERIVATIVE_PRODUCT
  upstreamRevision: string
  upstreamVersion: string
  patchSetDigest: string
}

export function derivativeMarkerPath(binary: string): string {
  return join(dirname(binary), '.cuppet-derivative.json')
}

export function createDerivativeMarker(patchSetDigest: string): DerivativeMarker {
  if (!/^[a-f0-9]{64}$/.test(patchSetDigest)) {
    throw new Error('invalid OpenCode derivative patch-set digest')
  }
  return {
    schema: DERIVATIVE_MARKER_SCHEMA,
    product: DERIVATIVE_PRODUCT,
    upstreamRevision: OPENCODE_REVISION,
    upstreamVersion: OPENCODE_VERSION,
    patchSetDigest,
  }
}

export async function readDerivativeMarker(binary: string): Promise<DerivativeMarker> {
  const path = derivativeMarkerPath(binary)
  try {
    await access(path, constants.R_OK)
  } catch {
    throw new Error(`OpenCode binary is not a Cuppet derivative (missing ${path})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error(`OpenCode derivative marker is unreadable at ${path}`)
  }
  if (!isDerivativeMarker(parsed)) throw new Error(`OpenCode derivative marker is invalid at ${path}`)
  if (parsed.upstreamRevision !== OPENCODE_REVISION || parsed.upstreamVersion !== OPENCODE_VERSION) {
    throw new Error('OpenCode derivative marker targets a different upstream revision')
  }
  return parsed
}

export function isDerivativeMarker(value: unknown): value is DerivativeMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const marker = value as Record<string, unknown>
  return marker.schema === DERIVATIVE_MARKER_SCHEMA &&
    marker.product === DERIVATIVE_PRODUCT &&
    typeof marker.upstreamRevision === 'string' &&
    typeof marker.upstreamVersion === 'string' &&
    typeof marker.patchSetDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(marker.patchSetDigest)
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}
