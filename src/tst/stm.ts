import type { STMEntry } from './types.js'

export class ShortTermMemory {
  private ring: (STMEntry | null)[]
  private index: Map<string, number> = new Map()
  private capacity: number
  private writePointer: number = 0

  constructor(capacity = 256) {
    this.capacity = capacity
    this.ring = new Array(capacity).fill(null)
  }

  add(entry: Omit<STMEntry, 'id' | 'accessCount' | 'lastAccessTs' | 'createdTs'>): string {
    const id = `stm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const now = Date.now()
    const fullEntry: STMEntry = {
      ...entry,
      id,
      accessCount: 1,
      lastAccessTs: now,
      createdTs: now,
    }

    if (this.index.has(entry.key)) {
      const existingIdx = this.index.get(entry.key)!
      const existing = this.ring[existingIdx]
      if (existing) {
        existing.observation = entry.observation
        existing.relevance = Math.min(1.0, existing.relevance + 0.2)
        existing.accessCount += 1
        existing.lastAccessTs = now
        return existing.id
      }
    }

    // Insert at write pointer
    const old = this.ring[this.writePointer]
    if (old) {
      this.index.delete(old.key)
    }

    this.ring[this.writePointer] = fullEntry
    this.index.set(entry.key, this.writePointer)
    this.writePointer = (this.writePointer + 1) % this.capacity
    return id
  }

  recall(query: string): { text: string; entries: STMEntry[]; tokens: number } {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const active: STMEntry[] = []

    for (const entry of this.ring) {
      if (!entry) continue
      const text = `${entry.key} ${entry.observation}`.toLowerCase()
      const matches = terms.filter(term => text.includes(term)).length
      if (entry.pinned || matches > 0) {
        entry.accessCount += 1
        entry.lastAccessTs = Date.now()
        active.push(entry)
      }
    }

    active.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.relevance - a.relevance)
    const selected = active.slice(0, 10)
    const text = selected.map(e => `- [${e.key}] ${e.observation}`).join('\n')
    const tokens = Math.ceil(text.length / 4)

    return { text, entries: selected, tokens }
  }

  decay(beta = 0.98): void {
    for (const entry of this.ring) {
      if (entry && !entry.pinned) {
        entry.relevance *= beta
      }
    }
  }

  getEntries(): STMEntry[] {
    return this.ring.filter((e): e is STMEntry => e !== null)
  }
}
