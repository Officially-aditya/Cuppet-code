export type STMEntry = {
  id: string
  key: string
  observation: string
  confidence: number
  relevance: number
  pinned: boolean
  accessCount: number
  lastAccessTs: number
  createdTs: number
}

export type TSTNode = {
  ch: string
  lo?: number
  eq?: number
  hi?: number
  payloadIdx?: number
}

export type PayloadHeader = {
  type: 'pattern' | 'fact' | 'preference' | 'concept'
  version: number
  createdTs: number
  lastAccessTs: number
  accessCount: number
  statement: string
  confidence: number
  paths: string[]
  symbols: string[]
}

export type ASTSymbolNode = {
  path: string
  language: string
  contentHash: string
  updatedAt: number
  symbols: string[]
  imports: string[]
  exports: string[]
  summary?: string
}

export type ASTRelationship = {
  from: string
  to: string
  kind: 'dependency' | 'reference' | 'test'
}

export type ASTCodeGraph = {
  nodes: Map<string, ASTSymbolNode>
  relationships: ASTRelationship[]
}
