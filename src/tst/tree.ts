import { readdir, readFile } from 'fs/promises'
import { extname, join, relative, resolve } from 'path'
import { createHash } from 'crypto'
import chokidar from 'chokidar'
import type { ASTCodeGraph, ASTRelationship, ASTSymbolNode } from './types.js'

const SUPPORTED_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.py', '.go', '.rs'])
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.claude', '.cuppet'])

export class TreeCodeGraph {
  private root: string
  private graph: ASTCodeGraph = { nodes: new Map(), relationships: [] }
  private watcher?: chokidar.FSWatcher

  constructor(root: string) {
    this.root = resolve(root)
  }

  async build(): Promise<void> {
    const files = await this.scanFiles(this.root)
    for (const file of files) {
      await this.indexFile(file)
    }
    this.rebuildRelationships()
  }

  startWatcher(onChange?: (path: string) => void): void {
    this.watcher = chokidar.watch(this.root, {
      ignored: Array.from(EXCLUDED_DIRS).map(d => `**/${d}/**`),
      ignoreInitial: true,
      persistent: true,
    })

    this.watcher.on('all', async (event, path) => {
      const ext = extname(path).toLowerCase()
      if (!SUPPORTED_EXTS.has(ext)) return

      const relPath = relative(this.root, path).replace(/\\/g, '/')
      if (event === 'unlink') {
        this.graph.nodes.delete(relPath)
      } else {
        await this.indexFile(relPath)
      }
      this.rebuildRelationships()
      onChange?.(relPath)
    })
  }

  stopWatcher(): void {
    void this.watcher?.close()
  }

  private async scanFiles(dir: string): Promise<string[]> {
    const results: string[] = []
    let entries: import('fs').Dirent[] = []
    try {
      entries = await readdir(dir, { withFileTypes: true }) as unknown as import('fs').Dirent[]
    } catch {
      return results
    }

    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...await this.scanFiles(full))
      } else if (entry.isFile() && SUPPORTED_EXTS.has(extname(entry.name).toLowerCase())) {
        results.push(relative(this.root, full).replace(/\\/g, '/'))
      }
    }
    return results
  }

  private async indexFile(relPath: string): Promise<void> {
    const fullPath = join(this.root, relPath)
    try {
      const content = await readFile(fullPath, 'utf8')
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
      const existing = this.graph.nodes.get(relPath)
      if (existing && existing.contentHash === hash) return

      const symbols = this.extractSymbols(content)
      const imports = this.extractImports(content)
      const exports = this.extractExports(content)
      const summary = `${relPath} defines ${symbols.slice(0, 3).join(', ')}`

      const node: ASTSymbolNode = {
        path: relPath,
        language: extname(relPath).slice(1).toLowerCase(),
        contentHash: hash,
        updatedAt: Date.now(),
        symbols,
        imports,
        exports,
        summary: summary.slice(0, 100),
      }
      this.graph.nodes.set(relPath, node)
    } catch {
      this.graph.nodes.delete(relPath)
    }
  }

  private extractSymbols(content: string): string[] {
    const matches = [...content.matchAll(/\b(?:class|interface|type|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)]
    return [...new Set(matches.map(m => m[1]!).filter(Boolean))].slice(0, 128)
  }

  private extractImports(content: string): string[] {
    const matches = [...content.matchAll(/\bimport\s+(?:[^'";]+\s+from\s+)?['"]([^'"]+)['"]/g)]
    return [...new Set(matches.map(m => m[1]!).filter(Boolean))].slice(0, 64)
  }

  private extractExports(content: string): string[] {
    const matches = [...content.matchAll(/\bexport\s+(?:default\s+)?(?:class|interface|type|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)]
    return [...new Set(matches.map(m => m[1]!).filter(Boolean))].slice(0, 64)
  }

  private rebuildRelationships(): void {
    const rels: ASTRelationship[] = []
    const nodes = Array.from(this.graph.nodes.values())

    for (const node of nodes) {
      for (const imp of node.imports) {
        if (imp.startsWith('.')) {
          const target = nodes.find(n => n.path.includes(imp.replace(/^\.\//, '')))
          if (target) {
            rels.push({ from: node.path, to: target.path, kind: 'dependency' })
          }
        }
      }
    }
    this.graph.relationships = rels
  }

  search(query: string, limit = 8): ASTSymbolNode[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const scored: { node: ASTSymbolNode; score: number }[] = []

    for (const node of this.graph.nodes.values()) {
      let score = 0
      for (const term of terms) {
        if (node.path.toLowerCase().includes(term)) score += 10
        if (node.symbols.some(s => s.toLowerCase().includes(term))) score += 5
        if (node.summary?.toLowerCase().includes(term)) score += 2
      }
      if (score > 0) {
        scored.push({ node, score })
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.node)
  }

  getStats(): { totalFiles: number; totalRelationships: number } {
    return {
      totalFiles: this.graph.nodes.size,
      totalRelationships: this.graph.relationships.length,
    }
  }
}
