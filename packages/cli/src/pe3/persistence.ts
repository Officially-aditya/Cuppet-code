import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { redact } from '../runtime/logger.js'
import type { TaskAgentState, TaskFingerprintSignal } from './task-agents.js'
import type { TaskSessionRouter } from './session-router.js'

const REGISTRY_SCHEMA_VERSION = 1
const MAX_PERSISTED_AGENTS = 32
const MAX_PATH_SIGNATURES = 128
const MAX_DESCRIPTOR_BYTES = 320
const MAX_PATHS = 16
const MAX_SYMBOLS = 16
const MAX_TERMS = 32

export type Pe3RegistryLoadResult = {
  agents: TaskAgentState[]
  activeSessionID?: string
  staleBySession: Map<string, string[]>
  droppedSessionCount: number
  recoveredFromCorruption: boolean
}

type FileSignature = {
  size: number
  mtimeMs: number
  mode: number
}

type StoredRegistry = {
  schemaVersion: number
  activeSessionID?: string
  agents: TaskAgentState[]
  fileSignatures: Record<string, FileSignature>
}

/**
 * Project-scoped persistence for PE3 routing/index metadata only.
 *
 * OpenCode remains authoritative for conversation history. This file never
 * stores transcripts, assistant text, tool output, or embedding vectors.
 */
export class Pe3TaskRegistry {
  readonly #path: string
  readonly #projectRoot: string

  constructor(projectStore: string, projectRoot: string) {
    this.#path = join(projectStore, 'pe3-task-agents.json')
    this.#projectRoot = projectRoot
  }

  get path(): string {
    return this.#path
  }

  async load(validSessionIDs: ReadonlySet<string>): Promise<Pe3RegistryLoadResult> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.#path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLoadResult(false)
      return emptyLoadResult(true)
    }

    const stored = parseRegistry(parsed)
    if (!stored) return emptyLoadResult(true)

    const bounded = stored.agents
      .filter((agent) => validSessionIDs.has(agent.sessionID))
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
      .slice(0, MAX_PERSISTED_AGENTS)
    const droppedSessionCount = stored.agents.length - bounded.length
    const changedPaths = await this.#changedPaths(stored.fileSignatures)
    const staleBySession = new Map<string, string[]>()
    const agents = bounded.map((agent) => {
      const privileged = new Set([...agent.activePaths, ...agent.touchedPaths])
      const offlineChanged = [...changedPaths].filter((path) => privileged.has(path))
      const stale = boundedUnique([...agent.stalePaths, ...offlineChanged], MAX_PATHS)
      if (stale.length > 0) staleBySession.set(agent.sessionID, stale)
      if (offlineChanged.length === 0) return cloneAgent(agent)

      const changed = new Set(offlineChanged)
      return {
        ...cloneAgent(agent),
        activePaths: agent.activePaths.filter((path) => !changed.has(path)),
        touchedPaths: agent.touchedPaths.filter((path) => !changed.has(path)),
        fingerprint: {
          ...cloneAgent(agent).fingerprint,
          revision: agent.fingerprint.revision + 1,
          paths: agent.fingerprint.paths.filter((signal) => !changed.has(signal.value)),
        },
        stalePaths: stale,
        cacheEpoch: agent.cacheEpoch + 1,
        workspaceEpoch: agent.workspaceEpoch + 1,
      }
    })
    const activeSessionID = stored.activeSessionID && validSessionIDs.has(stored.activeSessionID)
      ? stored.activeSessionID
      : undefined

    return {
      agents,
      ...(activeSessionID ? { activeSessionID } : {}),
      staleBySession,
      droppedSessionCount,
      recoveredFromCorruption: false,
    }
  }

  async save(
    agents: TaskAgentState[],
    activeSessionID?: string,
    supplementalStale: ReadonlyMap<string, readonly string[]> = new Map(),
  ): Promise<void> {
    const boundedAgents = agents
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
      .slice(0, MAX_PERSISTED_AGENTS)
      .map((agent) => sanitizeAgent(agent, supplementalStale.get(agent.sessionID) ?? []))
    const signaturePaths = boundedUnique(
      boundedAgents.flatMap((agent) => [...agent.activePaths, ...agent.touchedPaths]),
      MAX_PATH_SIGNATURES,
    )
    const fileSignatures: Record<string, FileSignature> = {}
    for (const path of signaturePaths) {
      const signature = await this.#signature(path)
      if (signature) fileSignatures[path] = signature
    }

    const state: StoredRegistry = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      ...(activeSessionID && boundedAgents.some((agent) => agent.sessionID === activeSessionID)
        ? { activeSessionID }
        : {}),
      agents: boundedAgents,
      fileSignatures,
    }
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
    const temp = `${this.#path}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    await chmod(temp, 0o600)
    await rename(temp, this.#path)
    await chmod(this.#path, 0o600)
  }

  async #changedPaths(signatures: Record<string, FileSignature>): Promise<Set<string>> {
    const changed = new Set<string>()
    for (const [path, previous] of Object.entries(signatures).slice(0, MAX_PATH_SIGNATURES)) {
      const current = await this.#signature(path)
      if (!current || !sameSignature(previous, current)) changed.add(path)
    }
    return changed
  }

  async #signature(path: string): Promise<FileSignature | undefined> {
    const target = safeProjectPath(this.#projectRoot, path)
    if (!target) return undefined
    try {
      const info = await lstat(target)
      return {
        size: Math.max(0, info.size),
        mtimeMs: Math.trunc(info.mtimeMs),
        mode: info.mode,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      return undefined
    }
  }
}

/** Restore inert task identities without opening sessions or invoking a model. */
export function restorePersistedTaskAgents(
  router: TaskSessionRouter,
  loaded: Pe3RegistryLoadResult,
  currentActiveSessionID?: string,
): void {
  const activeSessionID = currentActiveSessionID ?? loaded.activeSessionID
  const ordered = [...loaded.agents].sort((left, right) => left.lastActiveAt - right.lastActiveAt)
  for (const agent of ordered) {
    if (agent.sessionID === activeSessionID) continue
    router.bindSession(agent.sessionID, restoreEvidence(agent), agent.taskDescriptor)
  }
  const active = activeSessionID ? loaded.agents.find((agent) => agent.sessionID === activeSessionID) : undefined
  if (active) router.bindSession(active.sessionID, restoreEvidence(active), active.taskDescriptor)
}

function restoreEvidence(agent: TaskAgentState) {
  return {
    activePaths: agent.activePaths,
    touchedPaths: agent.touchedPaths,
    recentSymbols: agent.recentSymbols,
    workspaceEpoch: agent.workspaceEpoch,
  }
}

function parseRegistry(value: unknown): StoredRegistry | undefined {
  if (!isRecord(value) || value.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(value.agents)) return undefined
  const agents = value.agents.map(parseAgent).filter((agent): agent is TaskAgentState => Boolean(agent))
  const fileSignatures: Record<string, FileSignature> = {}
  if (isRecord(value.fileSignatures)) {
    for (const [path, signature] of Object.entries(value.fileSignatures).slice(0, MAX_PATH_SIGNATURES)) {
      if (!isRecord(signature)) continue
      const size = finiteNumber(signature.size)
      const mtimeMs = finiteNumber(signature.mtimeMs)
      const mode = finiteNumber(signature.mode)
      if (size === undefined || mtimeMs === undefined || mode === undefined) continue
      fileSignatures[bounded(path, 512)] = { size, mtimeMs, mode }
    }
  }
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    ...(typeof value.activeSessionID === 'string' ? { activeSessionID: bounded(value.activeSessionID, 256) } : {}),
    agents,
    fileSignatures,
  }
}

function parseAgent(value: unknown): TaskAgentState | undefined {
  if (!isRecord(value) || typeof value.sessionID !== 'string') return undefined
  const sessionID = bounded(value.sessionID, 256)
  if (!sessionID) return undefined
  const createdAt = finiteNumber(value.createdAt) ?? Date.now()
  const lastActiveAt = finiteNumber(value.lastActiveAt) ?? createdAt
  return {
    id: `task:${sessionID}`,
    sessionID,
    taskDescriptor: bounded(typeof value.taskDescriptor === 'string' ? redact(value.taskDescriptor) : '', MAX_DESCRIPTOR_BYTES),
    activePaths: stringArray(value.activePaths, MAX_PATHS, 512),
    touchedPaths: stringArray(value.touchedPaths, MAX_PATHS, 512),
    recentSymbols: stringArray(value.recentSymbols, MAX_SYMBOLS, 128),
    terms: stringArray(value.terms, MAX_TERMS, 96),
    fingerprint: parseFingerprint(value.fingerprint),
    stalePaths: stringArray(value.stalePaths, MAX_PATHS, 512),
    cacheEpoch: nonNegativeInteger(value.cacheEpoch),
    workspaceEpoch: nonNegativeInteger(value.workspaceEpoch),
    createdAt,
    lastActiveAt,
    turns: nonNegativeInteger(value.turns),
  }
}

function parseFingerprint(value: unknown): TaskAgentState['fingerprint'] {
  if (!isRecord(value)) return { revision: 0, paths: [], symbols: [], terms: [] }
  return {
    revision: nonNegativeInteger(value.revision),
    paths: signalArray(value.paths, MAX_PATHS),
    symbols: signalArray(value.symbols, MAX_SYMBOLS),
    terms: signalArray(value.terms, MAX_TERMS),
  }
}

function signalArray(value: unknown, limit: number): TaskFingerprintSignal[] {
  if (!Array.isArray(value)) return []
  const allowedSources = new Set<TaskFingerprintSignal['source']>(['prompt', 'localized', 'active', 'touched', 'symbol'])
  return value.slice(0, limit).flatMap((item) => {
    if (!isRecord(item) || typeof item.value !== 'string' || typeof item.source !== 'string') return []
    if (!allowedSources.has(item.source as TaskFingerprintSignal['source'])) return []
    const weight = finiteNumber(item.weight)
    const updatedAt = finiteNumber(item.updatedAt)
    if (weight === undefined || updatedAt === undefined) return []
    const safe = safeArrayValue(item.value, 512)
    if (!safe) return []
    return [{
      value: safe,
      weight: Math.max(0, Math.min(1, weight)),
      source: item.source as TaskFingerprintSignal['source'],
      updatedAt,
    }]
  })
}

function sanitizeAgent(agent: TaskAgentState, supplementalStale: readonly string[]): TaskAgentState {
  return {
    ...cloneAgent(agent),
    id: `task:${bounded(agent.sessionID, 256)}`,
    sessionID: bounded(agent.sessionID, 256),
    taskDescriptor: bounded(redact(agent.taskDescriptor), MAX_DESCRIPTOR_BYTES),
    activePaths: safeArray(agent.activePaths, MAX_PATHS, 512),
    touchedPaths: safeArray(agent.touchedPaths, MAX_PATHS, 512),
    recentSymbols: safeArray(agent.recentSymbols, MAX_SYMBOLS, 128),
    terms: safeArray(agent.terms, MAX_TERMS, 96),
    stalePaths: safeArray([...agent.stalePaths, ...supplementalStale], MAX_PATHS, 512),
    fingerprint: {
      revision: nonNegativeInteger(agent.fingerprint.revision),
      paths: sanitizeSignals(agent.fingerprint.paths, MAX_PATHS),
      symbols: sanitizeSignals(agent.fingerprint.symbols, MAX_SYMBOLS),
      terms: sanitizeSignals(agent.fingerprint.terms, MAX_TERMS),
    },
    cacheEpoch: nonNegativeInteger(agent.cacheEpoch),
    workspaceEpoch: nonNegativeInteger(agent.workspaceEpoch),
    turns: nonNegativeInteger(agent.turns),
  }
}

function sanitizeSignals(signals: TaskFingerprintSignal[], limit: number): TaskFingerprintSignal[] {
  return signals.slice(0, limit).flatMap((signal) => {
    const value = safeArrayValue(signal.value, 512)
    if (!value) return []
    return [{ ...signal, value, weight: Math.max(0, Math.min(1, signal.weight)) }]
  })
}

function safeArray(values: Iterable<string>, limit: number, bytes: number): string[] {
  return boundedUnique([...values].map((value) => safeArrayValue(value, bytes)).filter(Boolean), limit)
}

function stringArray(value: unknown, limit: number, bytes: number): string[] {
  return Array.isArray(value) ? safeArray(value.filter((item): item is string => typeof item === 'string'), limit, bytes) : []
}

function safeArrayValue(value: string, bytes: number): string {
  const redacted = redact(value.trim())
  if (!redacted || redacted.includes('[REDACTED]')) return ''
  return bounded(redacted, bytes)
}

function safeProjectPath(root: string, path: string): string | undefined {
  if (!path || isAbsolute(path)) return undefined
  const target = resolve(root, path)
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return target
}

function sameSignature(left: FileSignature, right: FileSignature): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.mode === right.mode
}

function cloneAgent(agent: TaskAgentState): TaskAgentState {
  return {
    ...agent,
    activePaths: [...agent.activePaths],
    touchedPaths: [...agent.touchedPaths],
    recentSymbols: [...agent.recentSymbols],
    terms: [...agent.terms],
    stalePaths: [...agent.stalePaths],
    fingerprint: {
      revision: agent.fingerprint.revision,
      paths: agent.fingerprint.paths.map((signal) => ({ ...signal })),
      symbols: agent.fingerprint.symbols.map((signal) => ({ ...signal })),
      terms: agent.fingerprint.terms.map((signal) => ({ ...signal })),
    },
  }
}

function emptyLoadResult(recoveredFromCorruption: boolean): Pe3RegistryLoadResult {
  return {
    agents: [],
    staleBySession: new Map(),
    droppedSessionCount: 0,
    recoveredFromCorruption,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegativeInteger(value: unknown): number {
  const number = finiteNumber(value) ?? 0
  return Math.max(0, Math.trunc(number))
}

function boundedUnique(values: Iterable<string>, limit: number): string[] {
  const output: string[] = []
  for (const raw of values) {
    const value = String(raw).trim()
    if (!value) continue
    const index = output.indexOf(value)
    if (index >= 0) output.splice(index, 1)
    output.push(value)
    if (output.length > limit) output.splice(0, output.length - limit)
  }
  return output
}

function bounded(value: string, maxBytes: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (Buffer.byteLength(normalized) <= maxBytes) return normalized
  let end = normalized.length
  while (end > 0 && Buffer.byteLength(normalized.slice(0, end)) > maxBytes) end -= 1
  return normalized.slice(0, end)
}

export const PE3_MAX_PERSISTED_AGENTS = MAX_PERSISTED_AGENTS
