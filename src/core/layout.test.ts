import { describe, expect, it } from 'vitest'
import type { ModelMessage, Segment } from '../contracts/common.js'
import { layout, segmentToMessage, type ViewParts } from './layout.js'

const sys = (text: string): Segment => ({ role: 'system', parts: [{ type: 'text', text }] })
const user = (text: string): Segment => ({ role: 'user', parts: [{ type: 'text', text }] })
const msg = (content: string): ModelMessage => ({ role: 'user', content })

const parts = (patch: Partial<ViewParts> = {}): ViewParts => ({
  notice: [sys('notice')],
  instructions: [sys('instructions')],
  capabilities: [sys('capabilities')],
  history: [msg('h1'), msg('h2')],
  input: [user('input')],
  transcript: [msg('t1'), msg('t2')],
  tail: [sys('tail')],
  tools: [{ name: 'search', description: 'search', inputSchema: {} }],
  ...patch,
})

const texts = (messages: ModelMessage[]) =>
  messages.map((m) =>
    typeof m.content === 'string' ? m.content : (m.content[0] as { text: string }).text,
  )

describe('layout', () => {
  it('AC-003 orders the blocks and places breakpoints after capabilities and the transcript', () => {
    const input = layout(parts())
    expect(texts(input.messages)).toEqual([
      'notice',
      'instructions',
      'capabilities',
      'h1',
      'h2',
      'input',
      't1',
      't2',
      'tail',
    ])
    expect(input.cacheBreakpoints).toEqual([2, 7])
    expect(input.tools).toHaveLength(1)
    expect('toolChoice' in input).toBe(false)
  })

  it('AC-004 puts the second breakpoint at the end of the task input when there is no transcript', () => {
    expect(layout(parts({ transcript: [] })).cacheBreakpoints).toEqual([2, 5])
  })

  it('AC-004 keeps a single breakpoint when both coincide', () => {
    const input = layout(parts({ history: [], input: [], transcript: [] }))
    expect(input.cacheBreakpoints).toEqual([2])
  })

  it('returns no messages and no breakpoints for empty parts', () => {
    const input = layout({
      notice: [],
      instructions: [],
      capabilities: [],
      history: [],
      input: [],
      transcript: [],
      tail: [],
      tools: [],
      toolChoice: 'none',
    })
    expect(input).toEqual({ messages: [], tools: [], toolChoice: 'none', cacheBreakpoints: [] })
  })
})

describe('segmentToMessage', () => {
  it('joins text-only system segments into a system string', () => {
    const segment: Segment = {
      role: 'system',
      parts: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    }
    expect(segmentToMessage(segment)).toEqual({ role: 'system', content: 'a\nb' })
  })

  it('keeps images by turning a mixed system segment into a user message', () => {
    const segment: Segment = {
      role: 'system',
      parts: [
        { type: 'text', text: 'see' },
        { type: 'image', image: 'data:x' },
      ],
    }
    expect(segmentToMessage(segment)).toEqual({ role: 'user', content: segment.parts })
  })
})
