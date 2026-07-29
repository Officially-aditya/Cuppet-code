import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { exploreAgentModelConfig, resolveVertexEnvironment } from '../src/opencode/server.js'

test('the native explore agent uses the configured secondary model and variant', () => {
  assert.deepEqual(exploreAgentModelConfig({
    providerID: 'openai',
    modelID: 'gpt-secondary',
    variant: 'low',
  }), {
    model: 'openai/gpt-secondary',
    variant: 'low',
  })
  assert.deepEqual(exploreAgentModelConfig({ providerID: 'vertex', modelID: 'gemini-test' }), {
    model: 'google-vertex/gemini-test',
  })
  assert.deepEqual(exploreAgentModelConfig(undefined), {})
})

test('Vertex runtime passes through a readable explicit ADC path and canonical settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cuppet-vertex-explicit-'))
  const adc = join(directory, 'adc.json')
  await writeFile(adc, 'not parsed by Cuppet', 'utf8')

  const resolved = await resolveVertexEnvironment({
    GOOGLE_APPLICATION_CREDENTIALS: adc,
    GOOGLE_VERTEX_PROJECT: 'test-project',
    GOOGLE_CLOUD_LOCATION: 'asia-south1',
  }, directory)

  assert.deepEqual(resolved.status, {
    adc: { available: true, source: 'environment', explicitUnavailable: false },
    project: { configured: true, source: 'GOOGLE_VERTEX_PROJECT' },
    location: { value: 'asia-south1', source: 'environment' },
  })
  assert.deepEqual(resolved.environment, {
    GOOGLE_APPLICATION_CREDENTIALS: adc,
    GOOGLE_CLOUD_PROJECT: 'test-project',
    GOOGLE_VERTEX_PROJECT: 'test-project',
    GOOGLE_VERTEX_LOCATION: 'asia-south1',
  })
})

test('Vertex runtime falls back to standard gcloud ADC without reading its contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cuppet-vertex-default-'))
  const gcloud = join(directory, '.config', 'gcloud')
  await mkdir(gcloud, { recursive: true })
  const adc = join(gcloud, 'application_default_credentials.json')
  await writeFile(adc, '{ deliberately invalid json', 'utf8')

  const resolved = await resolveVertexEnvironment({
    GOOGLE_APPLICATION_CREDENTIALS: join(directory, 'missing-explicit.json'),
  }, directory)

  assert.deepEqual(resolved.status, {
    adc: { available: true, source: 'gcloud-default', explicitUnavailable: true },
    project: { configured: false, source: 'provider-adc' },
    location: { value: 'global', source: 'cuppet-default' },
  })
  assert.deepEqual(resolved.environment, {
    GOOGLE_APPLICATION_CREDENTIALS: adc,
    GOOGLE_VERTEX_LOCATION: 'global',
  })
})

test('Vertex runtime reports missing ADC without fabricating a provider configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cuppet-vertex-missing-'))
  const resolved = await resolveVertexEnvironment({}, directory)

  assert.equal(resolved.status.adc.available, false)
  assert.equal(resolved.status.adc.source, 'none')
  assert.deepEqual(resolved.environment, { GOOGLE_VERTEX_LOCATION: 'global' })
})
