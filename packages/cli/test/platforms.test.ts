import assert from 'node:assert/strict'
import { test } from 'node:test'
import { integrationMatchesPlatform, modelMatchesPlatform } from '../src/platforms.js'

test('platform model groups include Azure, Gemini, and Vertex AI without crossing vendors', () => {
  assert.equal(modelMatchesPlatform({ providerID: 'anthropic' }, 'anthropic'), true)
  assert.equal(modelMatchesPlatform({ providerID: 'azure' }, 'openai'), true)
  assert.equal(modelMatchesPlatform({ providerID: 'google' }, 'google'), true)
  assert.equal(modelMatchesPlatform({ providerID: 'google-vertex' }, 'vertex'), true)
  assert.equal(modelMatchesPlatform({ providerID: 'google-vertex-anthropic' }, 'vertex'), true)
  assert.equal(modelMatchesPlatform({ providerID: 'opencode' }, 'opencode'), true)
  assert.equal(modelMatchesPlatform({ providerID: 'anthropic' }, 'openai'), false)
  assert.equal(modelMatchesPlatform({ providerID: 'google-vertex' }, 'google'), false)
  assert.equal(modelMatchesPlatform({ providerID: 'google' }, 'vertex'), false)
})

test('platform authentication groups recognize advertised provider integrations', () => {
  assert.equal(integrationMatchesPlatform({ id: 'google', name: 'Google Gemini' }, 'google'), true)
  assert.equal(integrationMatchesPlatform({ id: 'google-vertex', name: 'Vertex' }, 'vertex'), true)
  assert.equal(integrationMatchesPlatform({ id: 'google-vertex-anthropic', name: 'Vertex (Anthropic)' }, 'vertex'), true)
  assert.equal(integrationMatchesPlatform({ id: 'azure', name: 'Microsoft Azure' }, 'openai'), true)
  assert.equal(integrationMatchesPlatform({ id: 'anthropic', name: 'Anthropic' }, 'google'), false)
  assert.equal(integrationMatchesPlatform({ id: 'google-vertex', name: 'Vertex' }, 'google'), false)
  assert.equal(integrationMatchesPlatform({ id: 'google', name: 'Google' }, 'vertex'), false)
  assert.equal(integrationMatchesPlatform({ id: 'google-vertex-anthropic', name: 'Vertex (Anthropic)' }, 'anthropic'), false)
})
