const MAX_ATTACHMENTS = 16
const MAX_FILENAME_BYTES = 256
const MAX_MIME_BYTES = 128
const MAX_ATTACHMENT_METADATA_BYTES = 8 * 1024
const MIME_TOKEN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/

export type NativeRoutingAttachment = {
  type: 'file'
  mime: string
  filename?: string
}

export function parseNativeRoutingAttachments(value: unknown): NativeRoutingAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('attachments must be an array')
  if (value.length > MAX_ATTACHMENTS) throw new Error(`attachments exceed limit ${MAX_ATTACHMENTS}`)

  const attachments = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`attachments[${index}] must be an object`)
    }
    const record = item as Record<string, unknown>
    const allowed = new Set(['type', 'mime', 'filename'])
    const unsupported = Object.keys(record).find((key) => !allowed.has(key))
    if (unsupported) throw new Error(`attachments[${index}] contains unsupported field ${unsupported}`)
    if (record.type !== 'file') throw new Error(`attachments[${index}].type must be file`)

    const mime = boundedRequiredString(record.mime, `attachments[${index}].mime`, MAX_MIME_BYTES)
    if (!MIME_TOKEN.test(mime)) throw new Error(`attachments[${index}].mime must be a media type`)
    const filename = boundedOptionalString(record.filename, `attachments[${index}].filename`, MAX_FILENAME_BYTES)
    return {
      type: 'file' as const,
      mime,
      ...(filename ? { filename } : {}),
    }
  })

  if (Buffer.byteLength(JSON.stringify(attachments)) > MAX_ATTACHMENT_METADATA_BYTES) {
    throw new Error('attachment metadata exceeds routing limit')
  }
  return attachments
}

/**
 * Deterministic PE3 affinity is based only on user-authored task text.
 * Attachment metadata stays structured in the native control envelope and is
 * deliberately excluded from lexical/path extraction. This prevents generic
 * MIME/category vocabulary from masking a real disjoint task switch.
 */
export function nativeRoutingPrompt(prompt: string, _attachments: readonly NativeRoutingAttachment[]): string {
  return prompt
}

/** Bounded, payload-free metadata for semantic-only consumers. */
export function nativeSemanticAttachmentText(attachments: readonly NativeRoutingAttachment[]): string {
  return attachments.map((attachment) => {
    const filename = attachment.filename ? ` ${routingLabel(attachment.filename)}` : ''
    return `[attachment${filename} ${attachment.mime}]`
  }).join('\n')
}

function routingLabel(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function boundedRequiredString(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return boundedString(value.trim(), name, maxBytes)
}

function boundedOptionalString(value: unknown, name: string, maxBytes: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return boundedString(value.trim(), name, maxBytes)
}

function boundedString(value: string, name: string, maxBytes: number): string {
  if (Buffer.byteLength(value) > maxBytes) throw new Error(`${name} exceeds ${maxBytes} bytes`)
  return value
}
