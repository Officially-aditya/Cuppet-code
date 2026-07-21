import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { PayloadHeader, TSTNode } from './types.js'

export class LongTermMemory {
  private nodes: TSTNode[] = []
  private payloads: PayloadHeader[] = []
  private rootIdx: number | undefined = undefined
  private filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async init(): Promise<void> {
    try {
      const data = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(data)
      this.nodes = parsed.nodes ?? []
      this.payloads = parsed.payloads ?? []
      this.rootIdx = parsed.rootIdx
    } catch {
      this.nodes = []
      this.payloads = []
      this.rootIdx = undefined
    }
  }

  async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const data = JSON.stringify({
      nodes: this.nodes,
      payloads: this.payloads,
      rootIdx: this.rootIdx,
    }, null, 2)
    await writeFile(this.filePath, data, 'utf8')
  }

  put(key: string, payload: Omit<PayloadHeader, 'createdTs' | 'lastAccessTs' | 'accessCount'>): void {
    const pIdx = this.payloads.length
    const now = Date.now()
    this.payloads.push({
      ...payload,
      createdTs: now,
      lastAccessTs: now,
      accessCount: 1,
    })

    this.rootIdx = this.insertNode(this.rootIdx, key, 0, pIdx)
    void this.persist()
  }

  private insertNode(nodeIdx: number | undefined, key: string, charIdx: number, payloadIdx: number): number {
    const ch = key[charIdx]
    if (!ch) return nodeIdx ?? 0

    if (nodeIdx === undefined) {
      nodeIdx = this.nodes.length
      this.nodes.push({ ch })
    }

    const node = this.nodes[nodeIdx]!
    if (ch < node.ch) {
      node.lo = this.insertNode(node.lo, key, charIdx, payloadIdx)
    } else if (ch > node.ch) {
      node.hi = this.insertNode(node.hi, key, charIdx, payloadIdx)
    } else {
      if (charIdx + 1 < key.length) {
        node.eq = this.insertNode(node.eq, key, charIdx + 1, payloadIdx)
      } else {
        node.payloadIdx = payloadIdx
      }
    }

    return nodeIdx
  }

  get(key: string): PayloadHeader | null {
    const nodeIdx = this.searchNode(this.rootIdx, key, 0)
    if (nodeIdx === undefined) return null
    const node = this.nodes[nodeIdx]
    if (!node || node.payloadIdx === undefined) return null
    const payload = this.payloads[node.payloadIdx]
    if (payload) {
      payload.accessCount += 1
      payload.lastAccessTs = Date.now()
    }
    return payload ?? null
  }

  private searchNode(nodeIdx: number | undefined, key: string, charIdx: number): number | undefined {
    if (nodeIdx === undefined) return undefined
    const ch = key[charIdx]
    if (!ch) return undefined
    const node = this.nodes[nodeIdx]!

    if (ch < node.ch) return this.searchNode(node.lo, key, charIdx)
    if (ch > node.ch) return this.searchNode(node.hi, key, charIdx)
    if (charIdx + 1 < key.length) return this.searchNode(node.eq, key, charIdx + 1)
    return nodeIdx
  }

  query(keyword: string, limit = 8): PayloadHeader[] {
    const results: PayloadHeader[] = []
    const term = keyword.toLowerCase()
    for (const payload of this.payloads) {
      if (payload.statement.toLowerCase().includes(term) || payload.paths.some(p => p.toLowerCase().includes(term))) {
        results.push(payload)
        if (results.length >= limit) break
      }
    }
    return results
  }

  getStats(): { nodeCount: number; payloadCount: number } {
    return {
      nodeCount: this.nodes.length,
      payloadCount: this.payloads.length,
    }
  }
}
