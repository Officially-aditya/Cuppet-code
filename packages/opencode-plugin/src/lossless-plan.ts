import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SCHEMA_VERSION = 1
const MAX_SOURCE_BYTES = 1_000_000
const MIN_LONG_SPEC_LINES = 60
const MIN_STRUCTURED_PHASES = 5
const MAX_CONTEXT_CHARS = 9_000
const MAX_PHASE_TOOL_CHARS = 12_000
const MAX_CACHED_PLANS = 128

export type TodoEntry = {
  content: string
  status: string
  priority: string
}

export type LosslessPlanPhase = {
  id: string
  sourceMessageID: string
  title: string
  summary: string
  text: string
  startLine: number
  endLine: number
  status: string
}

export type LosslessPlanSource = {
  messageID: string
  prompt: string
  lineCount: number
  capturedAt: number
}

export type LosslessPlan = {
  schema: typeof SCHEMA_VERSION
  sessionID: string
  sources: LosslessPlanSource[]
  phases: LosslessPlanPhase[]
  createdAt: number
  updatedAt: number
  lastAgent: string
}

export type PlanCaptureInput = {
  sessionID: string
  messageID: string
  prompt: string
  agent: string
}

export type PlanToolRequest =
  | { action?: 'overview' }
  | { action: 'phase'; phaseID: string; offset?: number; limit?: number }
  | { action: 'search'; query: string }

export type PlanToolResult = {
  title: string
  output: string
  metadata: {
    readOnly: true
    source: 'lossless_plan'
    phaseCount: number
    resultCount: number
    truncated: boolean
  }
}

export class LosslessPlanStore {
  readonly #directory: string | undefined
  readonly #plans = new Map<string, LosslessPlan>()
  readonly #writes = new Map<string, Promise<void>>()

  constructor(directory?: string) {
    this.#directory = directory
  }

  async capture(input: PlanCaptureInput): Promise<LosslessPlan | undefined> {
    const sourcePrompt = input.prompt
    if (Buffer.byteLength(sourcePrompt) > MAX_SOURCE_BYTES) return this.get(input.sessionID)
    const prompt = normalizePrompt(sourcePrompt)
    if (!shouldCapture(prompt, input.agent)) return this.get(input.sessionID)
    const existing = await this.get(input.sessionID)
    if (existing?.sources.some((source) => source.messageID === input.messageID)) {
      if (existing.lastAgent !== input.agent) {
        existing.lastAgent = input.agent
        existing.updatedAt = Date.now()
        await this.#save(existing)
      }
      return existing
    }

    const source = {
      messageID: input.messageID,
      // The source is deliberately untouched. Normalization is only used for
      // parsing, so a reload can always recover exactly what the user wrote.
      prompt: sourcePrompt,
      lineCount: lineCount(prompt),
      capturedAt: Date.now(),
    }
    const startingIndex = existing?.phases.length ?? 0
    const phases = splitPhases(prompt, input.messageID, startingIndex)
    if (phases.length === 0) return existing

    const plan: LosslessPlan = existing
      ? {
          ...existing,
          sources: [...existing.sources, source],
          phases: [...existing.phases, ...phases],
          updatedAt: Date.now(),
          lastAgent: input.agent,
        }
      : {
          schema: SCHEMA_VERSION,
          sessionID: input.sessionID,
          sources: [source],
          phases,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastAgent: input.agent,
    }
    await this.#save(plan)
    return clonePlan(plan)
  }

  async get(sessionID: string): Promise<LosslessPlan | undefined> {
    const cached = this.#plans.get(sessionID)
    if (cached) {
      this.#plans.delete(sessionID)
      this.#plans.set(sessionID, cached)
      return clonePlan(cached)
    }
    if (!this.#directory) return undefined
    try {
      const decoded = decodePlan(JSON.parse(await readFile(this.#path(sessionID), 'utf8')), sessionID)
      if (!decoded) return undefined
      this.#remember(decoded)
      return clonePlan(decoded)
    } catch {
      return undefined
    }
  }

  async reconcileTodos(sessionID: string, value: unknown): Promise<TodoEntry[] | undefined> {
    const plan = await this.get(sessionID)
    if (!plan || !Array.isArray(value)) return undefined
    const incoming = value.flatMap(todoEntry)
    if (incoming.length === 0) {
      // TodoWrite is a full replacement. An empty update is an explicit clear,
      // not a request to restore the previous canonical plan. Keep the source
      // plan available through cuppet_plan, but stop reintroducing its phases
      // into the visible execution checklist.
      let changed = false
      for (const phase of plan.phases) {
        if (isTerminalTodoStatus(phase.status)) continue
        phase.status = 'cancelled'
        changed = true
      }
      if (changed) {
        plan.updatedAt = Date.now()
        await this.#save(plan)
      }
      return []
    }

    const used = new Set<number>()
    const matches = plan.phases.map((phase) => {
      const match = incoming.findIndex((todo, index) => !used.has(index) && matchesPhase(todo, phase))
      if (match !== -1) used.add(match)
      return match
    })
    // Without a stable/fuzzy match there is no evidence that this replacement
    // belongs to the stored plan. Preserve the caller's current list instead
    // of resurrecting an unrelated previous checklist.
    if (used.size === 0) return incoming

    for (const [phaseIndex, match] of matches.entries()) {
      if (match !== -1) plan.phases[phaseIndex]!.status = incoming[match]!.status
    }

    // Once a phase reaches a terminal state it is no longer part of the
    // active execution view. Re-emitting it as a fallback item is what made a
    // completed sidebar checklist look like an older plan was stuck forever.
    const canonical = plan.phases.flatMap((phase, phaseIndex) => {
      if (isTerminalTodoStatus(phase.status)) return []
      const match = matches[phaseIndex]!
      const todo = match === -1
        ? {
            content: `[${phase.id}] ${phase.summary}`,
            status: phase.status || 'pending',
            priority: 'medium',
          }
        : incoming[match]!
      return [{
        content: ensurePhaseID(todo.content, phase.id),
        status: todo.status,
        priority: todo.priority,
      }]
    })
    const extras = incoming.filter((_, index) => !used.has(index))
    plan.updatedAt = Date.now()
    await this.#save(plan)
    return [...canonical, ...extras]
  }

  async toolResult(sessionID: string, request: PlanToolRequest): Promise<PlanToolResult | undefined> {
    const plan = await this.get(sessionID)
    if (!plan) return undefined
    if (request.action === 'phase') {
      const phase = plan.phases.find((item) => item.id.toLowerCase() === request.phaseID.toLowerCase())
      if (!phase) {
        return result(plan, `No phase named ${request.phaseID} exists. Use action=overview to list phase IDs.`, 0, false)
      }
      const offset = Math.min(Math.max(0, request.offset ?? 0), phase.text.length)
      const limit = Math.min(Math.max(1, request.limit ?? MAX_PHASE_TOOL_CHARS), MAX_PHASE_TOOL_CHARS)
      const end = Math.min(phase.text.length, offset + limit)
      const remaining = end < phase.text.length
      return result(
        plan,
        [
          `${phase.id} · ${phase.title} (lines ${phase.startLine}-${phase.endLine}; ${phase.status}; characters ${offset + 1}-${end} of ${phase.text.length})`,
          '',
          phase.text.slice(offset, end),
          ...(remaining ? ['', `Continue with action=phase, phaseID=${phase.id}, offset=${end}.`] : []),
        ].join('\n'),
        1,
        remaining,
      )
    }
    if (request.action === 'search') {
      const query = request.query.trim().toLowerCase()
      const matches = plan.phases.filter((phase) => `${phase.title}\n${phase.text}`.toLowerCase().includes(query)).slice(0, 12)
      const body = matches.length
        ? matches.map((phase) => `- ${phase.id} [${phase.status}] ${phase.summary}`).join('\n')
        : `No phases match "${request.query}".`
      return result(plan, body, matches.length, plan.phases.filter((phase) => `${phase.title}\n${phase.text}`.toLowerCase().includes(query)).length > matches.length)
    }
    const rendered = renderOverview(plan, Number.POSITIVE_INFINITY)
    return result(plan, rendered.text, plan.phases.length, rendered.truncated)
  }

  async setAgent(sessionID: string, agent: string): Promise<LosslessPlan | undefined> {
    const plan = await this.get(sessionID)
    if (!plan || plan.lastAgent === agent) return plan
    plan.lastAgent = agent
    plan.updatedAt = Date.now()
    await this.#save(plan)
    return clonePlan(plan)
  }

  async #save(plan: LosslessPlan): Promise<void> {
    const snapshot = clonePlan(plan)
    this.#remember(snapshot)
    if (!this.#directory) return
    const previous = this.#writes.get(snapshot.sessionID) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      await mkdir(this.#directory!, { recursive: true, mode: 0o700 })
      await chmod(this.#directory!, 0o700)
      const target = this.#path(snapshot.sessionID)
      const temporary = join(this.#directory!, `.${createHash('sha256').update(snapshot.sessionID).digest('hex')}.${randomBytes(6).toString('hex')}.tmp`)
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 })
      await rename(temporary, target)
    })
    this.#writes.set(snapshot.sessionID, next)
    try {
      await next
    } finally {
      if (this.#writes.get(snapshot.sessionID) === next) this.#writes.delete(snapshot.sessionID)
    }
  }

  #path(sessionID: string): string {
    return join(this.#directory!, `${createHash('sha256').update(sessionID).digest('hex')}.json`)
  }

  #remember(plan: LosslessPlan): void {
    const snapshot = clonePlan(plan)
    this.#plans.delete(snapshot.sessionID)
    this.#plans.set(snapshot.sessionID, snapshot)
    // The runtime store is durable. Bound only that cache so a long-running
    // server does not retain every completed session's raw plan in memory.
    if (!this.#directory) return
    while (this.#plans.size > MAX_CACHED_PLANS) {
      const oldest = this.#plans.keys().next().value as string | undefined
      if (!oldest) break
      this.#plans.delete(oldest)
    }
  }
}

export function createLosslessPlanStore(directory = process.env.CUPPET_LOSSLESS_PLAN_DIR): LosslessPlanStore {
  return new LosslessPlanStore(directory)
}

export function renderLosslessPlanContext(plan: LosslessPlan, agent: string): string {
  const overview = renderOverview(plan, MAX_CONTEXT_CHARS)
  return [
    `<CUPPET_LOSSLESS_PLAN canonical="true" agent="${escapeAttribute(agent)}" phases="${plan.phases.length}">`,
    'The user\'s full implementation specification is preserved in Cuppet\'s private lossless plan store. The visible todo list is an execution view, not the source of truth.',
    'Every phase ID below must remain represented in todowrite until it is completed or cancelled. Cuppet restores omitted phases automatically.',
    'Use cuppet_plan with action=phase for exact requirements before implementing or completing a phase; use action=overview or action=search when the overview is insufficient.',
    '',
    overview.text,
    ...(overview.truncated ? ['', `Overview is abbreviated; ${plan.phases.length} total phases remain available through cuppet_plan.`] : []),
    '</CUPPET_LOSSLESS_PLAN>',
  ].join('\n')
}

function result(plan: LosslessPlan, output: string, resultCount: number, truncated: boolean): PlanToolResult {
  return {
    title: 'Cuppet lossless plan',
    output: `CUPPET LOSSLESS PLAN\n${output}`,
    metadata: {
      readOnly: true,
      source: 'lossless_plan',
      phaseCount: plan.phases.length,
      resultCount,
      truncated,
    },
  }
}

function renderOverview(plan: LosslessPlan, limit: number): { text: string; truncated: boolean } {
  const header = `CANONICAL IMPLEMENTATION PLAN (${plan.phases.length} phases)`
  const lines = [header]
  for (const phase of plan.phases) {
    const line = `- ${phase.id} [${phase.status}] ${phase.summary} (source lines ${phase.startLine}-${phase.endLine})`
    if (Buffer.byteLength([...lines, line].join('\n')) > limit) return { text: lines.join('\n'), truncated: true }
    lines.push(line)
  }
  return { text: lines.join('\n'), truncated: false }
}

function shouldCapture(prompt: string, agent: string): boolean {
  if (Buffer.byteLength(prompt) > MAX_SOURCE_BYTES) return false
  const lines = lineCount(prompt)
  const structure = countStructuredLines(prompt)
  const action = /\b(implement|implementation|build|add|change|replace|migrate|refactor|fix|create|update|phase|milestone|requirement|acceptance)\b/i.test(prompt)
  if (agent.toLowerCase() === 'plan') return lines >= 24 || structure >= 3
  return (lines >= MIN_LONG_SPEC_LINES && (action || structure >= MIN_STRUCTURED_PHASES)) ||
    (structure >= MIN_STRUCTURED_PHASES && lines >= 32 && action)
}

function splitPhases(prompt: string, sourceMessageID: string, offset: number): LosslessPlanPhase[] {
  const lines = prompt.split('\n')
  const starts = phaseStarts(lines)
  // Preserve a prose preamble by giving it a stable phase as well. Without
  // this, text before the first Markdown heading would be stored on disk but
  // unavailable through the phase checklist and retrieval tool.
  const boundaries = starts.length >= 2 && starts[0]! > 0 ? [0, ...starts] : starts
  const sections = boundaries.length >= 2
    ? boundaries.map((start, index) => ({ start, end: (boundaries[index + 1] ?? lines.length) - 1 }))
    : paragraphSections(lines)
  return sections.flatMap((section, index) => {
    const text = lines.slice(section.start, section.end + 1).join('\n').trim()
    if (!text) return []
    const title = firstContentLine(text) || `Plan segment ${index + 1}`
    return [{
      id: `P${String(offset + index + 1).padStart(2, '0')}`,
      sourceMessageID,
      title: clipInline(title, 220),
      summary: clipInline(text, 360),
      text,
      startLine: section.start + 1,
      endLine: section.end + 1,
      status: 'pending',
    }]
  })
}

function phaseStarts(lines: string[]): number[] {
  const headings = lines.flatMap((line, index) => /^\s{0,3}#{1,6}\s+\S/.test(line) ? [index] : [])
  if (headings.length >= 2) return headings
  const numbered = topLevelStarts(lines, /^\s*(?:\d+[.)]|(?:phase|step|milestone|workstream)\s+\d*\s*[:.)-])\s*\S/i)
  if (numbered.length >= 3) return numbered
  const bullets = topLevelStarts(lines, /^\s*[-*+]\s+\S/)
  return bullets.length >= MIN_STRUCTURED_PHASES ? bullets : []
}

function topLevelStarts(lines: string[], pattern: RegExp): number[] {
  const matches = lines.flatMap((line, index) => {
    if (!pattern.test(line)) return []
    const indent = (line.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '  ').length
    return [{ index, indent }]
  })
  if (matches.length === 0) return []
  const minimumIndent = Math.min(...matches.map((match) => match.indent))
  return matches.filter((match) => match.indent === minimumIndent).map((match) => match.index)
}

function paragraphSections(lines: string[]): Array<{ start: number; end: number }> {
  const sections: Array<{ start: number; end: number }> = []
  let start: number | undefined
  let nonempty = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim()) {
      if (start === undefined) start = index
      nonempty += 1
      if (nonempty >= 12) {
        sections.push({ start, end: index })
        start = undefined
        nonempty = 0
      }
      continue
    }
    if (start !== undefined) {
      sections.push({ start, end: index - 1 })
      start = undefined
      nonempty = 0
    }
  }
  if (start !== undefined) sections.push({ start, end: lines.length - 1 })
  return sections
}

function matchesPhase(todo: TodoEntry, phase: LosslessPlanPhase): boolean {
  if (new RegExp(`\\[${phase.id}\\]`, 'i').test(todo.content)) return true
  const titleTokens = tokens(phase.title)
  const todoTokens = new Set(tokens(todo.content))
  if (titleTokens.length === 0) return false
  const overlap = titleTokens.filter((token) => todoTokens.has(token)).length
  return overlap >= Math.min(3, titleTokens.length) && overlap / titleTokens.length >= 0.6
}

function isTerminalTodoStatus(status: string): boolean {
  return status === 'completed' || status === 'cancelled'
}

function todoEntry(value: unknown): TodoEntry[] {
  const record = asRecord(value)
  if (!record || typeof record.content !== 'string' || typeof record.status !== 'string' || typeof record.priority !== 'string') return []
  return [{ content: record.content, status: record.status, priority: record.priority }]
}

function ensurePhaseID(content: string, id: string): string {
  return new RegExp(`\\[${id}\\]`, 'i').test(content) ? content : `[${id}] ${content}`
}

function countStructuredLines(prompt: string): number {
  return phaseStarts(prompt.split('\n')).length
}

function lineCount(prompt: string): number {
  return prompt.split('\n').filter((line) => line.trim()).length
}

function firstContentLine(value: string): string | undefined {
  const line = value.split('\n').find((item) => item.trim())
  return line?.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|(?:phase|step|milestone|workstream)\s+\d*\s*[:.)-]\s*)/i, '').trim()
}

function normalizePrompt(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

function clipInline(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 1))}…`
}

function tokens(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9_$-]{3,}/g) ?? [])]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function clonePlan(plan: LosslessPlan): LosslessPlan {
  return structuredClone(plan)
}

function decodePlan(value: unknown, sessionID: string): LosslessPlan | undefined {
  const record = asRecord(value)
  if (!record || record.schema !== SCHEMA_VERSION || record.sessionID !== sessionID || !Array.isArray(record.sources) || !Array.isArray(record.phases)) return undefined
  const sources = record.sources.flatMap((source) => {
    const item = asRecord(source)
    if (!item || typeof item.messageID !== 'string' || typeof item.prompt !== 'string' || typeof item.lineCount !== 'number' || typeof item.capturedAt !== 'number') return []
    return [{ messageID: item.messageID, prompt: item.prompt, lineCount: item.lineCount, capturedAt: item.capturedAt }]
  })
  const phases = record.phases.flatMap((phase) => {
    const item = asRecord(phase)
    if (!item || ['id', 'sourceMessageID', 'title', 'summary', 'text', 'status'].some((key) => typeof item[key] !== 'string') || typeof item.startLine !== 'number' || typeof item.endLine !== 'number') return []
    return [{
      id: item.id as string,
      sourceMessageID: item.sourceMessageID as string,
      title: item.title as string,
      summary: item.summary as string,
      text: item.text as string,
      startLine: item.startLine as number,
      endLine: item.endLine as number,
      status: item.status as string,
    }]
  })
  if (sources.length === 0 || phases.length === 0 || sources.length !== record.sources.length || phases.length !== record.phases.length) return undefined
  if (typeof record.createdAt !== 'number' || typeof record.updatedAt !== 'number' || typeof record.lastAgent !== 'string') return undefined
  return {
    schema: SCHEMA_VERSION,
    sessionID,
    sources,
    phases,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastAgent: record.lastAgent,
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/g, (character) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character]!)
}
