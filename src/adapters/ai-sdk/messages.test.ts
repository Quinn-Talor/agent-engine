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
const plain = {
  systemAfterUser: true,
  dropReasoning: false,
  anthropic: false,
  vision: false,
  provider: 'mock',
}

describe('toSdkMessages', () => {
  it('AC-011 converts every part and replays reasoning with its signature', () => {
    const out = toSdkMessages(view, plain)
    expect(out[0]).toEqual({ role: 'system', content: '准则' })
    expect(out[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'file', data: 'data:image/png;base64,AA', mediaType: 'image/png' },
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

describe('tool results with images', () => {
  type ToolResult = Extract<ModelMessage, { role: 'tool' }>['content'][number]
  const shot: ToolResult = {
    type: 'tool-result',
    toolCallId: 'c1',
    toolName: 'screenshot',
    output: '截图如下',
    isError: false,
    images: [{ type: 'image', image: 'AQID', mediaType: 'image/png' }],
  }
  const withImage: ModelMessage[] = [{ role: 'tool', content: [shot] }]
  const outputOf = (vision: boolean, provider = 'anthropic.messages') => {
    const [message] = toSdkMessages(withImage, { ...plain, vision, provider })
    return (message as { content: Array<{ output: unknown }> }).content[0]!.output
  }

  it.each(['anthropic.messages', 'openai.responses', 'google.generative-ai'])(
    'AC-017 sends the image inside the tool result through %s',
    (provider) => {
      expect(toSdkMessages(withImage, { ...plain, vision: true, provider })).toHaveLength(1)
      expect(outputOf(true, provider)).toEqual({
        type: 'content',
        value: [
          { type: 'text', text: '截图如下' },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } },
        ],
      })
    },
  )

  it('AC-017 tells a model without vision that the image was left out', () => {
    expect(outputOf(false)).toEqual({
      type: 'text',
      value: '截图如下\n[图片 1 张：模型不支持视觉，未展示]',
    })
    expect(toSdkMessages(withImage, { ...plain, provider: 'openai.chat' })).toHaveLength(1)
  })

  // OpenAI Chat 与 OpenAI 兼容接口把工具结果里的图片序列化成文本：图片改放进下一条 user 消息。
  describe('through a provider that turns tool result images into text', () => {
    const batch: ModelMessage[] = [
      { role: 'user', content: '截两张图' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'screenshot', input: {} },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'search', input: {} },
          { type: 'tool-call', toolCallId: 'c3', toolName: 'camera', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          shot,
          { type: 'tool-result', toolCallId: 'c2', toolName: 'search', output: '无图' },
          {
            type: 'tool-result',
            toolCallId: 'c3',
            toolName: 'camera',
            output: '',
            images: [
              { type: 'image', image: 'BBBB' },
              { type: 'image', image: 'CCCC', mediaType: 'image/jpeg' },
            ],
          },
        ],
      },
      { role: 'assistant', content: '看到了' },
    ]
    const chat = { ...plain, vision: true, provider: 'openai.chat' }

    it('AC-017 leaves a note in the tool result and sends the images right after the batch', () => {
      const out = toSdkMessages(batch, chat)
      expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant'])
      expect(
        (out[2] as { content: Array<{ output: unknown }> }).content.map((r) => r.output),
      ).toEqual([
        { type: 'text', value: '截图如下\n[图片 1 张：见下一条消息]' },
        { type: 'text', value: '无图' },
        { type: 'text', value: '\n[图片 2 张：见下一条消息]' },
      ])
      expect(out[3]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: '[工具 screenshot（调用 c1）返回的图片 1 张，不是用户发送的]' },
          { type: 'file', data: 'AQID', mediaType: 'image/png' },
          { type: 'text', text: '[工具 camera（调用 c3）返回的图片 2 张，不是用户发送的]' },
          { type: 'file', data: 'BBBB', mediaType: 'image' },
          { type: 'file', data: 'CCCC', mediaType: 'image/jpeg' },
        ],
      })
    })

    it('AC-017 waits for every tool message of the batch before sending the images', () => {
      const split: ModelMessage[] = [
        batch[1]!,
        { role: 'tool', content: [shot] },
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'c2', toolName: 'search', output: '无图' }],
        },
      ]
      expect(toSdkMessages(split, chat).map((m) => m.role)).toEqual([
        'assistant',
        'tool',
        'tool',
        'user',
      ])
    })

    it('AC-017 sends no images for an error result', () => {
      const failed: ModelMessage[] = [
        {
          role: 'tool',
          content: [{ ...shot, isError: true, output: 'ERROR' }],
        },
      ]
      expect(toSdkMessages(failed, chat)).toEqual([
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'screenshot',
              output: { type: 'error-text', value: 'ERROR' },
            },
          ],
        },
      ])
    })

    it('AC-016 puts a cache breakpoint on the tool batch after its images', () => {
      const out = toSdkMessages(batch, { ...chat, anthropic: true, cacheBreakpoints: [2] })
      expect(out[2]).not.toHaveProperty('providerOptions')
      expect(out[3]).toMatchObject({
        role: 'user',
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      })
    })

    it('AC-012 rewrites a later system message once the images went out as a user message', () => {
      const out = toSdkMessages([batch[1]!, batch[2]!, { role: 'system', content: '提示' }], {
        ...chat,
        systemAfterUser: false,
      })
      expect(out.at(-1)).toEqual({ role: 'user', content: '[system] 提示' })
    })
  })
})
