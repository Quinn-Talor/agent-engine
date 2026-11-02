import { describe, expect, it } from 'vitest'
import type { ModelMessage, ToolCallPart } from '../../sdk.js'
import { cleanLeakedToolMarkup, toSdkMessages } from './messages.js'

const view: ModelMessage[] = [
  { role: 'system', content: '准则' },
  {
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      { type: 'image', image: 'data:image/png;base64,AA', mediaType: 'image/png' },
      { type: 'file', data: 'JVBER', mediaType: 'application/pdf', filename: 'a.pdf' },
    ],
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'reasoning',
        text: '先查',
        providerData: {
          parts: [
            { text: '先', providerMetadata: { anthropic: { signature: 's1' } } },
            { text: '查', providerMetadata: { anthropic: { signature: 's2' } } },
          ],
        },
      },
      { type: 'text', text: '我查一下' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: { q: 'x' } },
    ],
  },
  {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: 'c1', toolName: 'search', output: '结果', isError: false },
      {
        type: 'tool-result',
        toolCallId: 'c2',
        toolName: 'fetch',
        output: 'ERROR [TOOL_TIMEOUT]',
        isError: true,
      },
    ],
  },
  { role: 'system', content: '[corrector:repeat L1] 换个做法' },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '旧推理', providerData: { anthropic: { signature: 'old' } } },
    ],
  },
]
const plain = { systemAfterUser: true, dropReasoning: false, anthropic: false }

describe('toSdkMessages', () => {
  it('AC-011 converts every part and replays reasoning with its signature', () => {
    const out = toSdkMessages(view, plain)
    expect(out[0]).toEqual({ role: 'system', content: '准则' })
    expect(out[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', image: 'data:image/png;base64,AA', mediaType: 'image/png' },
        { type: 'file', data: 'JVBER', mediaType: 'application/pdf', filename: 'a.pdf' },
      ],
    })
    expect(out[2]).toEqual({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '先', providerOptions: { anthropic: { signature: 's1' } } },
        { type: 'reasoning', text: '查', providerOptions: { anthropic: { signature: 's2' } } },
        { type: 'text', text: '我查一下' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: { q: 'x' } },
      ],
    })
    expect(out[3]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'search',
          output: { type: 'text', value: '结果' },
        },
        {
          type: 'tool-result',
          toolCallId: 'c2',
          toolName: 'fetch',
          output: { type: 'error-text', value: 'ERROR [TOOL_TIMEOUT]' },
        },
      ],
    })
    expect(out[4]).toEqual({ role: 'system', content: '[corrector:repeat L1] 换个做法' })
    expect(out[5]).toEqual({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '旧推理', providerOptions: { anthropic: { signature: 'old' } } },
      ],
    })
    expect(
      toSdkMessages(
        [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'ok' },
        ],
        plain,
      ),
    ).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
    ])
    expect(
      toSdkMessages([{ role: 'assistant', content: [{ type: 'reasoning', text: 'r' }] }], plain),
    ).toEqual([{ role: 'assistant', content: [{ type: 'reasoning', text: 'r' }] }])
  })

  it('replays tool call metadata such as the Gemini thought signature', () => {
    // providerData 是 ModelResponse.toolCalls 带回的厂商私有数据，由核心原样放进工具调用片段。
    const call = {
      type: 'tool-call',
      toolCallId: 'c1',
      toolName: 'search',
      input: {},
      providerData: { google: { thoughtSignature: 'TS' } },
    } as ToolCallPart
    expect(toSdkMessages([{ role: 'assistant', content: [call] }], plain)).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'search',
            input: {},
            providerOptions: { google: { thoughtSignature: 'TS' } },
          },
        ],
      },
    ])
  })

  it('AC-012 rewrites system messages after the first user message when the vendor needs it', () => {
    const out = toSdkMessages(view, { ...plain, systemAfterUser: false })
    expect(out[0]).toEqual({ role: 'system', content: '准则' })
    expect(out[4]).toEqual({ role: 'user', content: '[system] [corrector:repeat L1] 换个做法' })
  })

  it('AC-013 drops reasoning from the history on request', () => {
    const out = toSdkMessages(view, { ...plain, dropReasoning: true })
    expect(out[2]).toMatchObject({ content: [{ type: 'text' }, { type: 'tool-call' }] })
    expect(out[5]).toEqual({ role: 'assistant', content: '' })
  })

  it('AC-016 marks cache breakpoints on Anthropic only', () => {
    const anthropic = toSdkMessages(view, { ...plain, anthropic: true, cacheBreakpoints: [0, 3] })
    const marked = { anthropic: { cacheControl: { type: 'ephemeral' } } }
    expect(anthropic[0]).toEqual({ role: 'system', content: '准则', providerOptions: marked })
    expect(anthropic[3]).toMatchObject({ role: 'tool', providerOptions: marked })
    expect(anthropic[1]).not.toHaveProperty('providerOptions')
    expect(toSdkMessages(view, { ...plain, cacheBreakpoints: [0] })[0]).not.toHaveProperty(
      'providerOptions',
    )
  })
})

describe('cleanLeakedToolMarkup', () => {
  it('AC-014 removes leaked tool call markup', () => {
    expect(cleanLeakedToolMarkup('结论如下<tool_call>{"name":"x"}</tool_call>')).toBe('结论如下')
    expect(cleanLeakedToolMarkup('<function_calls><invoke name="x"/></function_calls>\n答案')).toBe(
      '答案',
    )
    expect(cleanLeakedToolMarkup('好<|tool_calls_section_begin|>a<|tool_calls_section_end|>')).toBe(
      '好',
    )
    expect(cleanLeakedToolMarkup('<|tool_call_begin|>b<|tool_call_end|> 继续')).toBe('继续')
    expect(cleanLeakedToolMarkup('普通文本')).toBe('普通文本')
  })
})
