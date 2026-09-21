import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelBrand, type ModelBrand } from '../src/shared/model-brand'

// Snapshot of https://opencode.ai/zen/go/v1/models on 2026-09-17 (38 models).
const catalog: Partial<Record<ModelBrand, string[]>> = {
  minimax: ['minimax-m3', 'minimax-m2.7', 'minimax-m2.5'],
  kimi: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5'],
  longcat: ['longcat-2.0'],
  zai: ['glm-5.2', 'glm-5.3-flash', 'glm-5.3', 'glm-5.1', 'glm-5'],
  deepseek: [
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'deepseek-flash',
    'deepseek-v4.1-flash',
    'deepseek-v4-flash-vision-exp'
  ],
  qwen: [
    'qwen3.7-max',
    'qwen3.8-max',
    'qwen3.8-flash',
    'qwen3.7-plus',
    'qwen3.6-plus',
    'qwen3.5-plus'
  ],
  mimo: ['mimo-v2-pro', 'mimo-v2-omni', 'mimo-v2.5-pro', 'mimo-v2.5'],
  hunyuan: ['hy4-preview', 'hy3', 'hy3-preview'],
  openai: ['gpt-5.6-luna'],
  grok: ['grok-4.5', 'grok-4.6'],
  meta: ['muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'],
  opencode: ['union-alpha', 'omen-alpha']
}

test('all 38 current OpenCode Go models have deliberate logo mappings', () => {
  assert.equal(Object.values(catalog).flat().length, 38)
  for (const [brand, models] of Object.entries(catalog))
    for (const id of models) {
      assert.equal(modelBrand(id), brand, id)
      assert.equal(modelBrand(`opencode-go/${id}`), brand, id)
    }
})

test('direct providers, display names and future family versions keep their brand', () => {
  for (const [id, expected] of [
    ['kimi-for-coding', 'kimi'],
    ['kimi-for-coding-highspeed', 'kimi'],
    ['k3', 'kimi'],
    ['k3-256k', 'kimi'],
    ['Kimi K3', 'kimi'],
    ['x-ai/grok-4.6', 'grok'],
    ['Qwen/Qwen3-235B-A22B', 'qwen'],
    ['DeepSeek-V4.1-Flash', 'deepseek'],
    ['mimo-v3-pro', 'mimo'],
    ['claude-sonnet-4', 'claude'],
    ['gemini-3-pro', 'gemini'],
    ['glm-6', 'zai'],
    ['huawei/pangu-pro', 'huawei'],
    ['spark-4', 'spark'],
    ['stepfun/step-3', 'stepfun'],
    ['doubao-seed-1.6', 'doubao']
  ])
    assert.equal(modelBrand(id), expected, id)
  for (const id of ['', 'other-kimi', 'my-grok-proxy', 'qwendog', 'unknown-model'])
    assert.equal(modelBrand(id), null, id)
})
