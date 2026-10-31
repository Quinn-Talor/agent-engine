import { describe, expect, it } from 'vitest'
import { normalizeUsage } from './usage.js'

const details = (noCacheTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number) => ({
  noCacheTokens,
  cacheReadTokens,
  cacheWriteTokens,
})
const usage = (
  inputTokens: number | undefined,
  input: ReturnType<typeof details>,
  outputTokens?: number,
) => ({
  inputTokens,
  inputTokenDetails: input,
  outputTokens,
  outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  totalTokens: undefined,
})

describe('normalizeUsage', () => {
  it('AC-017 reads the input token details first', () => {
    expect(normalizeUsage(usage(100, details(70, 20, 10), 9), undefined)).toEqual({
      input: 70,
      output: 9,
      cacheRead: 20,
      cacheWrite: 10,
    })
  })

  it('AC-017 derives the uncached input when only totals are reported', () => {
    expect(normalizeUsage(usage(100, details(undefined, 30, undefined), 5), undefined)).toEqual({
      input: 70,
      output: 5,
      cacheRead: 30,
      cacheWrite: 0,
    })
  })

  it('AC-017 falls back to provider metadata', () => {
    expect(
      normalizeUsage(usage(100, details(), 1), {
        anthropic: { cacheReadInputTokens: 40, cacheCreationInputTokens: 25 },
      }),
    ).toEqual({ input: 35, output: 1, cacheRead: 40, cacheWrite: 25 })
    expect(normalizeUsage(usage(50, details(), 2), { openai: { cachedPromptTokens: 10 } })).toEqual(
      {
        input: 40,
        output: 2,
        cacheRead: 10,
        cacheWrite: 0,
      },
    )
  })

  it('is all zeros without usage', () => {
    expect(normalizeUsage(undefined, undefined)).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
    expect(normalizeUsage(usage(5, details(), undefined), undefined)).toEqual({
      input: 5,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })
})
