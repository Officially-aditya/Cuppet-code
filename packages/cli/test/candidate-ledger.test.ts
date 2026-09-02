import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CandidateLedger,
  candidateSourceRef,
  hasCorrectionCue,
  hasDurableUserCue,
  type CandidateLedgerObservation,
} from '../src/background/candidate-ledger.js'

const baseObservation: CandidateLedgerObservation = {
  key: 'Package manager preference: pnpm',
  claim: 'Prefer pnpm for package management',
  kind: 'preference',
  relation: 'support',
  sessionID: 'session-1',
  projectID: 'project-1',
  sourceRef: 'user:1',
  timestampMs: 1_000,
  trustedSupport: true,
  explicitUser: true,
  downstreamVerified: false,
}

test('one explicit preference records user evidence but does not independently admit itself', async () => {
  const ledger = new CandidateLedger({ now: () => 1_000 })
  await ledger.ready()
  ledger.observe(baseObservation)

  const admission = ledger.admission(baseObservation.key, 'preference')
  assert.equal(admission.explicitUserPreference, true)
  assert.equal(admission.independentlyReinforced, false)
  assert.equal(admission.reinforcementEvidenceCount, 0)
  assert.equal(admission.score, 0.6)
})

test('semantically canonicalized repeats merge and reinforce across sessions', async () => {
  const ledger = new CandidateLedger({ now: () => 2_000 })
  await ledger.ready()
  ledger.observe(baseObservation)
  ledger.observe({
    ...baseObservation,
    key: ' package-manager   preference: PNPM ',
    sessionID: 'session-2',
    sourceRef: 'user:2',
    timestampMs: 2_000,
  })

  assert.equal(ledger.size, 1)
  const entry = ledger.entry(baseObservation.key, 'preference')
  assert.equal(entry?.support_count, 2)
  assert.equal(entry?.explicit_user_count, 2)
  assert.equal(entry?.session_count, 2)
  const admission = ledger.admission(baseObservation.key, 'preference')
  assert.equal(admission.independentlyReinforced, true)
  assert.equal(admission.reinforcementEvidenceCount, 2)
  assert.ok(admission.score >= 0.8)
})

test('model-only canonicalization never becomes recurrence evidence', async () => {
  const ledger = new CandidateLedger({ now: () => 3_000 })
  await ledger.ready()
  for (let index = 1; index <= 3; index += 1) {
    ledger.observe({
      ...baseObservation,
      explicitUser: false,
      trustedSupport: false,
      sessionID: `session-${index}`,
      sourceRef: `turn:${index}`,
      timestampMs: index * 1_000,
    })
  }

  const entry = ledger.entry(baseObservation.key, 'preference')
  assert.equal(entry?.support_count, 0)
  assert.equal(entry?.session_count, 0)
  const admission = ledger.admission(baseObservation.key, 'preference')
  assert.equal(admission.explicitUserPreference, false)
  assert.equal(admission.independentlyReinforced, false)
  assert.equal(admission.reinforcementEvidenceCount, 0)
  assert.equal(admission.score, 0.5)
})

test('a correction accumulates evidence and resolves one contradiction', async () => {
  const ledger = new CandidateLedger({ now: () => 3_000 })
  await ledger.ready()
  ledger.observe(baseObservation)
  ledger.observe({
    ...baseObservation,
    relation: 'contradiction',
    explicitUser: true,
    sourceRef: 'user:contradiction',
    timestampMs: 2_000,
  })
  assert.equal(ledger.admission(baseObservation.key, 'preference').blocked, true)

  ledger.observe({
    ...baseObservation,
    relation: 'correction',
    sessionID: 'session-2',
    sourceRef: 'user:correction',
    timestampMs: 3_000,
  })
  const entry = ledger.entry(baseObservation.key, 'preference')
  assert.equal(entry?.correction_count, 1)
  assert.equal(entry?.contradiction_count, 0)
  assert.equal(ledger.admission(baseObservation.key, 'preference').blocked, false)
})

test('unresolved contradiction caps and blocks admission', async () => {
  const ledger = new CandidateLedger({ now: () => 3_000 })
  await ledger.ready()
  ledger.observe(baseObservation)
  ledger.observe({ ...baseObservation, sessionID: 'session-2', sourceRef: 'user:2', timestampMs: 2_000 })
  ledger.observe({
    ...baseObservation,
    relation: 'contradiction',
    sessionID: 'session-3',
    sourceRef: 'user:3',
    timestampMs: 3_000,
  })

  const admission = ledger.admission(baseObservation.key, 'preference')
  assert.equal(admission.blocked, true)
  assert.equal(admission.reinforcementEvidenceCount, 0)
  assert.ok(admission.score < 0.8)
})

test('project recurrence is tracked independently from session recurrence', async () => {
  const ledger = new CandidateLedger({ now: () => 2_000 })
  await ledger.ready()
  ledger.observe(baseObservation)
  ledger.observe({
    ...baseObservation,
    projectID: 'project-2',
    sessionID: 'session-2',
    sourceRef: 'user:2',
    timestampMs: 2_000,
  })
  const entry = ledger.entry(baseObservation.key, 'preference')
  assert.equal(entry?.project_count, 2)
  assert.equal(entry?.session_count, 2)
})

test('bounded persisted ledger is private, reloadable, compactable, and decays weak noise', async () => {
  const directory = await temporaryDirectory()
  const path = join(directory, 'candidate-ledger.json')
  try {
    let now = 1_000
    const ledger = new CandidateLedger({ path, now: () => now, maxEntries: 2, weakTtlMs: 100 })
    await ledger.ready()
    ledger.observe(baseObservation)
    ledger.observe({
      ...baseObservation,
      key: 'weak old',
      claim: 'weak old',
      kind: 'concept_anchor',
      explicitUser: false,
      trustedSupport: false,
      sourceRef: candidateSourceRef('turn_context', 'weak old'),
      timestampMs: 1_001,
    })
    ledger.observe({
      ...baseObservation,
      key: 'weak new',
      claim: 'weak new',
      kind: 'concept_anchor',
      explicitUser: false,
      trustedSupport: false,
      sourceRef: candidateSourceRef('turn_context', 'weak new'),
      timestampMs: 1_002,
    })
    assert.equal(ledger.size, 2)
    assert.ok(ledger.entry(baseObservation.key, 'preference'))
    await ledger.persist()
    assert.equal((await stat(path)).mode & 0o777, 0o600)

    const raw = await readFile(path, 'utf8')
    assert.doesNotMatch(raw, /session-1|project-1/)

    now = 2_000
    const reopened = new CandidateLedger({ path, now: () => now, maxEntries: 2, weakTtlMs: 100 })
    await reopened.ready()
    assert.ok(reopened.entry(baseObservation.key, 'preference'))
    assert.equal(reopened.size, 1, 'old weak noise decays while explicit evidence survives')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('high-recall user cue detection covers preferences and corrections without matching ordinary prose', () => {
  assert.equal(hasDurableUserCue('I prefer pnpm'), true)
  assert.equal(hasDurableUserCue('this repo should use pnpm'), true)
  assert.equal(hasDurableUserCue('never use npm here'), true)
  assert.equal(hasDurableUserCue('please use pnpm'), true)
  assert.equal(hasCorrectionCue('I already told you to use pnpm'), true)
  assert.equal(hasDurableUserCue('The package build completed successfully'), false)
})

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'cuppet-ledger-test-'))
}
