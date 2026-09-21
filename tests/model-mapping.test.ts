import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  accountSupportsModel,
  exposedModels,
  mappedModel,
  validateModelMappings
} from '../src/shared/model-mapping'
import { registryModels } from '../src/main/services/model-registry'
import { parseCatalogEntries } from '../src/main/services/model-price-catalog'

test('model mappings prefer exact IDs, then longest prefix, without chaining or case folding', () => {
  const account = {
    modelMappings: {
      '*': 'fallback',
      'claude-*': 'family',
      'claude-sonnet-*': 'sonnet',
      'claude-sonnet-latest': 'exact',
      exact: 'chained'
    }
  }
  assert.equal(mappedModel(account, 'claude-sonnet-latest'), 'exact')
  assert.equal(mappedModel(account, 'claude-sonnet-v2'), 'sonnet')
  assert.equal(mappedModel(account, 'claude-opus-v2'), 'family')
  assert.equal(mappedModel(account, 'Claude-opus-v2'), 'fallback')
  assert.equal(mappedModel({}, 'unknown'), 'unknown')
  assert.equal(mappedModel({ modelMappings: { 'a*': 'b' } }, 'a'), 'b')
  assert.equal(mappedModel({}, 'constructor'), 'constructor')
})

test('mapping validation rejects malformed rules and preserves safe own-property keys', () => {
  assert.deepEqual(validateModelMappings({ ' alias ': ' upstream ' }), { alias: 'upstream' })
  assert.deepEqual(validateModelMappings({}), {})
  for (const value of [
    null,
    [],
    'model',
    { '': 'm' },
    { alias: '' },
    { alias: 1 },
    { 'a b': 'm' },
    { alias: 'a\nb' },
    { 'a*b': 'm' },
    { 'a**': 'm' },
    { a: '*' },
    { ['a'.repeat(201)]: 'm' },
    { a: 'm', ' a ': 'n' },
    Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`a${i}`, 'm']))
  ]) {
    assert.throws(() => validateModelMappings(value))
  }
  const modelMappings = validateModelMappings(JSON.parse('{"__proto__":"m","constructor":"m"}'))
  assert.equal(mappedModel({ modelMappings }, '__proto__'), 'm')
  assert.equal(mappedModel({ modelMappings }, 'constructor'), 'm')
  assert.equal(Object.getPrototypeOf(modelMappings), Object.prototype)
})

test('aliases require enabled targets and only concrete supported IDs are advertised', () => {
  const account = {
    models: ['m', 'disabled-alias'],
    modelMappings: { alias: 'm', 'wild-*': 'm', missing: 'removed', 'disabled-alias': 'removed' }
  }
  assert.deepEqual(exposedModels(account), ['m', 'alias'])
  assert.equal(accountSupportsModel(account, 'wild-anything'), true)
  assert.equal(accountSupportsModel(account, 'missing'), false)
  assert.equal(accountSupportsModel(account, 'disabled-alias'), false)
  assert.equal(accountSupportsModel(account, 'unknown'), false)
})

test('registry aliases derive metadata from actual targets, including wildcard candidates', () => {
  const entries = parseCatalogEntries({
    'kimi-for-coding': {
      models: {
        upstream: { name: 'Actual', limit: { context: 1000 } },
        alternate: { name: 'Other', limit: { context: 500 } }
      }
    }
  })
  const models = registryModels(
    [
      { models: ['upstream'], modelMappings: { alias: 'upstream' } },
      { models: ['alternate'], modelMappings: { 'ali*': 'alternate' } }
    ],
    entries,
    []
  )
  assert.equal(models.alias.id, 'alias')
  assert.equal(models.alias.name, 'Actual')
  assert.equal(models.alias.limit?.context, 500)
  assert.equal(models['ali*'], undefined)
})
