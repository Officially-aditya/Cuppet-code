import assert from 'node:assert/strict'
import { test } from 'node:test'
import { integrationMatchesPlatform, modelMatchesPlatform } from '../src/platforms.js'

test('platform model groups include Vertex AI and Azure without crossing vendors', () => {
  assert.equal(modelMatchesPlatform({ providerID: 'anthropic' }, 'anthropic'), true)
  assert.equal(modelMatchesPlatform({ providerID: 'azure' }, 'openai'), true)
  assert.equal(modelMatchesPlatform({ providerID: 'google-vertex' }, 'google'), true)
  assert.equal(modelMatchesPlatform({ providerID: 'opencode' }, 'opencode'), true)
  assert.equal(modelMatchesPlatform({ providerID: 'anthropic' }, 'openai'), false)
})

test('platform authentication groups recognize advertised provider integrations', () => {
  assert.equal(integrationMatchesPlatform({ id: 'google-vertex', name: 'Vertex AI' }, 'google'), true)
  assert.equal(integrationMatchesPlatform({ id: 'azure', name: 'Microsoft Azure' }, 'openai'), true)
  assert.equal(integrationMatchesPlatform({ id: 'anthropic', name: 'Anthropic' }, 'google'), false)
})
