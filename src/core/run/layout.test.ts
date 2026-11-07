import { describe, expect, it } from 'vitest'
import type { ModelMessage, Segment } from '../../contracts/common.js'
import {
  ageImages,
  layout,
  renderView,
  segmentToMessage,
  summaryMessage,
  type ViewParts,
} from './layout.js'

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
  it('AC-003 copies the sampling settings into the model input only when given', () => {
    expect(layout(parts({ temperature: 0.2, topP: 0.9 }))).toMatchObject({
      temperature: 0.2,
      topP: 0.9,
    })
    const plain = layout(parts())
    expect('temperature' in plain || 'topP' in plain).toBe(false)
  })

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

describe('renderView', () => {
  const history = [msg('h0'), msg('h1'), msg('h2')]
  const transcript = [msg('t0'), msg('t1')]

  it('§3.13 leaves history and transcript as they are without a compaction', () => {
    expect(renderView(history, transcript)).toEqual({ history, transcript })
  })

  it('§3.13 replaces the first upTo messages of history + transcript with one summary', () => {
    expect(renderView(history, transcript, { upTo: 2, summary: 's' })).toEqual({
      history: [summaryMessage('s'), msg('h2')],
      transcript,
    })
    // 覆盖到运行记录时，前文只剩摘要（布局里任务输入仍在摘要和剩下的运行记录之间）。
    expect(renderView(history, transcript, { upTo: 4, summary: 's' })).toEqual({
      history: [summaryMessage('s')],
      transcript: [msg('t1')],
    })
  })

  it('renders the summary as one system message with a fixed heading', () => {
    expect(summaryMessage('意图：查天气')).toEqual({
      role: 'system',
      content: '【前文摘要】\n意图：查天气',
    })
  })
})

describe('ageImages', () => {
  /** 一次截图：调用与带 1 张图片的结果。 */
  const shot = (n: number): ModelMessage[] => [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: `c${n}`, toolName: 'shot', input: {} }],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: `c${n}`,
          toolName: 'shot',
          output: `第 ${n} 张`,
          images: [{ type: 'image', image: `img${n}` }],
        },
      ],
    },
  ]
  const shots = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => shot(from + i)).flat()
  const imagesOf = (messages: readonly ModelMessage[]) =>
    messages.flatMap((m) =>
      m.role === 'tool' ? m.content.flatMap((r) => (r.images ?? []).map((i) => i.image)) : [],
    )
  const outputs = (messages: readonly ModelMessage[]) =>
    messages.flatMap((m) => (m.role === 'tool' ? m.content.map((r) => r.output) : []))

  it.each([
    ['30 images keeping 3', 30, 3, 3],
    ['7 images keeping 3 removes one chunk', 7, 3, 4],
    ['5 images keeping 3 removes nothing yet', 5, 3, 5],
    ['3 images keeping 3', 3, 3, 3],
  ])('AC-009 %s', (_name, total, keep, left) => {
    const messages = shots(1, total)
    const aged = ageImages(messages, keep)
    expect(imagesOf(aged)).toEqual(
      Array.from({ length: left }, (_, i) => `img${total - left + 1 + i}`),
    )
    expect(aged.map((m) => m.role)).toEqual(messages.map((m) => m.role))
    expect(imagesOf(messages)).toHaveLength(total)
  })

  it('AC-009 notes the dropped images on their tool results', () => {
    const aged = ageImages(shots(1, 7), 3)
    expect(outputs(aged)[0]).toBe('第 1 张\n[较早的图片 1 张已从视图省略，需要时重新调用工具]')
    expect(outputs(aged)[3]).toBe('第 4 张')
    const first = aged[1] as Extract<ModelMessage, { role: 'tool' }>
    expect(first.content[0]).not.toHaveProperty('images')
  })

  it('AC-009 layout ages images across history and transcript only when configured', () => {
    const history = shots(1, 4)
    const transcript = shots(5, 7)
    const view = (patch: Partial<ViewParts>) =>
      layout(parts({ history, transcript, ...patch })).messages
    expect(imagesOf(view({}))).toHaveLength(7)
    expect(imagesOf(view({ keepRecentImages: 3 }))).toEqual(['img4', 'img5', 'img6', 'img7'])
    expect(view({ keepRecentImages: 3 })).toHaveLength(view({}).length)
  })
})
