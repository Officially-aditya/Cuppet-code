import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskAgentRouter } from '../src/pe3/task-agents.js'

test('weak task terms decay and fingerprint collections stay bounded', () => {
  let now = 0
  const router = new TaskAgentRouter({ now: () => ++now })
  router.register('s1', 'alpha beta gamma initial request')
  for (let index = 0; index < 80; index += 1) {
    router.recordTurn(`unique-term-${index} another-term-${index} third-term-${index}`)
  }
  const active = router.active!
  assert.ok(active.fingerprint.terms.length <= 32)
  assert.ok(active.fingerprint.paths.length <= 16)
  assert.ok(active.fingerprint.symbols.length <= 16)
  assert.equal(active.fingerprint.terms.some((signal) => signal.value === 'alpha'), false)
})

test('prompt path provenance upgrades to observed active evidence', () => {
  const router = new TaskAgentRouter()
  router.register('s1', 'inspect src/auth/token.ts')
  assert.equal(pathSource(router, 'src/auth/token.ts'), 'prompt')

  router.recordSessionEvidence('s1', { activePaths: ['src/auth/token.ts'] })

  assert.equal(pathSource(router, 'src/auth/token.ts'), 'active')
})

test('prompt path provenance upgrades directly to touched evidence', () => {
  const router = new TaskAgentRouter()
  router.register('s1', 'inspect src/auth/token.ts')

  router.recordSessionEvidence('s1', { touchedPaths: ['src/auth/token.ts'] })

  assert.equal(pathSource(router, 'src/auth/token.ts'), 'touched')
})

test('observed active provenance upgrades to touched evidence', () => {
  const router = new TaskAgentRouter()
  router.register('s1', '', { activePaths: ['src/auth/token.ts'] })
  assert.equal(pathSource(router, 'src/auth/token.ts'), 'active')

  router.recordSessionEvidence('s1', { touchedPaths: ['src/auth/token.ts'] })

  assert.equal(pathSource(router, 'src/auth/token.ts'), 'touched')
})

test('weaker later evidence cannot downgrade stronger touched provenance', () => {
  const router = new TaskAgentRouter()
  router.register('s1', '', { touchedPaths: ['src/auth/token.ts'] })
  assert.equal(pathSource(router, 'src/auth/token.ts'), 'touched')

  router.recordSessionEvidence('s1', { activePaths: ['src/auth/token.ts'] })
  router.recordTurn('revisit src/auth/token.ts')

  assert.equal(pathSource(router, 'src/auth/token.ts'), 'touched')
})

test('localized provenance upgrades to observed and prompt symbols upgrade to runtime symbols', () => {
  const router = new TaskAgentRouter()
  router.register('s1', 'inspect RefreshToken', { localizedPaths: ['src/auth/token.ts'] })
  assert.equal(pathSource(router, 'src/auth/token.ts'), 'localized')
  assert.equal(symbolSource(router, 'refreshtoken'), 'prompt')

  router.recordSessionEvidence('s1', {
    activePaths: ['src/auth/token.ts'],
    recentSymbols: ['RefreshToken'],
  })

  assert.equal(pathSource(router, 'src/auth/token.ts'), 'active')
  assert.equal(symbolSource(router, 'refreshtoken'), 'symbol')
})

function pathSource(router: TaskAgentRouter, path: string) {
  return router.active?.fingerprint.paths.find((signal) => signal.value === path)?.source
}

function symbolSource(router: TaskAgentRouter, symbol: string) {
  return router.active?.fingerprint.symbols.find((signal) => signal.value === symbol)?.source
}
