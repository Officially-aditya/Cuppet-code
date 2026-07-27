type MermaidEdge = {
  from: string
  to: string
  label?: string
}

export type MermaidRender =
  | { kind: 'flowchart'; text: string; edges: MermaidEdge[] }
  | { kind: 'code'; text: string }

/**
 * Render only the small, lossless subset that the native TUI can display as
 * compact edges. Everything else remains source code so Mermaid is never
 * silently discarded.
 */
export function renderMermaid(value: string): MermaidRender {
  const lines = value.replace(/\r\n?/g, '\n').split('\n')
  const header = lines.find((line) => /^\s*(flowchart|graph)\s+(TB|TD|BT|RL|LR)\s*$/.test(line))
  if (!header) return { kind: 'code', text: value }
  const edges: MermaidEdge[] = []
  for (const line of lines.slice(lines.indexOf(header) + 1)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('%%') || trimmed.startsWith('subgraph') || trimmed === 'end') continue
    const match = /^([A-Za-z][\w-]*)\s*--(?:>|\|([^|]+)\|>?)\s*([A-Za-z][\w-]*)\s*$/.exec(trimmed)
    if (!match) return { kind: 'code', text: value }
    edges.push({ from: match[1]!, to: match[3]!, ...(match[2] ? { label: match[2].trim() } : {}) })
  }
  if (edges.length === 0) return { kind: 'code', text: value }
  return { kind: 'flowchart', text: edges.map((edge) => `${edge.from} ${edge.label ? `—${edge.label}→` : '→'} ${edge.to}`).join('\n'), edges }
}

export function isMermaidFence(language: string | undefined): boolean {
  return language?.trim().toLowerCase() === 'mermaid'
}
