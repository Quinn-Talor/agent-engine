import { describe, expect, it } from 'vitest'
import type { ModelMessage } from '../contracts/common.js'
import { estimateMessages, estimateText, estimateTools, nextCalibration } from './estimate.js'

describe('estimateText', () => {
  it.each([
    ['AC-001 CJK characters count 0.67 each', '你好世界', 3],
    ['AC-001 other characters count 0.25 each', 'abcd', 1],
    ['rounds up', 'abcde', 2],
    ['empty text', '', 0],
    ['kana and hangul are CJK', 'あ한', 2],
  ])('%s', (_name, text, expected) => {
    expect(estimateText(text)).toBe(expected)
  })
})

describe('estimateMessages', () => {
  it('AC-001 counts an image part as 85', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'image', image: 'data:image/png;base64,AAAA' }] },
    ]
    expect(estimateMessages(messages)).toBe(85)
  })

  it('sums every part kind and rounds once at the end', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'ab' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'ab' },
          { type: 'text', text: 'ab' },
          { type: 'tool-call', toolCallId: 'c', toolName: 'x', input: { a: 1 } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'x', output: 'abcd' }],
      },
      { role: 'user', content: [{ type: 'file', data: 'x', mediaType: 'application/pdf' }] },
    ]
    // 0.5 + 0.5 + 0.5 + ('x{"a":1}' 8 字符 → 2) + 1 + 85 = 89.5 → 90
    expect(estimateMessages(messages)).toBe(90)
  })
})

describe('estimateTools', () => {
  it('counts name, description and schema', () => {
    expect(estimateTools([{ name: 'ab', description: 'cd', inputSchema: {} }])).toBe(2)
  })
})

describe('nextCalibration', () => {
  it.each([
    ['AC-002 clamps to the upper bound', 1, 1000, 3000, 2],
    ['AC-002 clamps to the lower bound', 1, 1000, 100, 0.5],
    ['scales the previous factor', 1.2, 1000, 1000, 1.2],
    ['keeps the factor when actual is unknown', 1.5, 1000, 0, 1.5],
    ['keeps the factor when nothing was estimated', 1.5, 0, 500, 1.5],
  ])('%s', (_name, prev, estimate, actual, expected) => {
    expect(nextCalibration(prev, estimate, actual)).toBe(expected)
  })
})
