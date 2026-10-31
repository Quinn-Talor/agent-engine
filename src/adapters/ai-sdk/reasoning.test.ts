import { describe, expect, it } from 'vitest'
import { reasoningOptions } from './reasoning.js'

describe('reasoningOptions', () => {
  it.each([
    ['anthropic', 'low', { anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } } }],
    ['anthropic', 'medium', { anthropic: { thinking: { type: 'enabled', budgetTokens: 4096 } } }],
    ['anthropic', 'high', { anthropic: { thinking: { type: 'enabled', budgetTokens: 8192 } } }],
    ['openai', 'medium', { openai: { reasoningEffort: 'medium', parallelToolCalls: true } }],
    ['google', 'medium', { google: { thinkingConfig: { thinkingBudget: 4096 } } }],
    ['ollama', 'medium', { ollama: { think: true } }],
  ] as const)('AC-009 %s at %s', (vendor, level, expected) => {
    expect(reasoningOptions(vendor, level)).toEqual(expected)
  })

  it.each([
    ['anthropic', { anthropic: { thinking: { type: 'disabled' } } }],
    ['openai', { openai: { parallelToolCalls: true } }],
    ['google', { google: { thinkingConfig: { thinkingBudget: 0 } } }],
    ['ollama', { ollama: { think: false } }],
    ['other', undefined],
  ] as const)('AC-010 %s switched off', (vendor, expected) => {
    expect(reasoningOptions(vendor, 'off')).toEqual(expected)
  })

  it.each([
    ['anthropic', undefined],
    ['openai', { openai: { parallelToolCalls: true } }],
    ['google', undefined],
    ['ollama', undefined],
    ['other', undefined],
  ] as const)('AC-010 %s without a reasoning setting', (vendor, expected) => {
    expect(reasoningOptions(vendor, undefined)).toEqual(expected)
  })
})
