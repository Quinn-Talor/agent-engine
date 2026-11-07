// 消息规整与推理回放（设计 §8.1）：视图消息 → AI SDK 消息。systemAfterUser=false 的厂商把 user 之后的
// system 改写成带固定标记的 user 内容；推理内容、签名和工具调用的厂商元数据原样带回（可配置为丢弃历史推理）；
// 仅 Anthropic 在断点所在消息上打 ephemeral 缓存标记；工具结果里的图片，厂商包不能作为图片发出时改放进
// 这批工具结果之后的一条 user 消息；清洗回复里泄漏的工具调用标记。

import type { ModelMessage as SdkModelMessage } from 'ai'
import type { ModelMessage } from '../../sdk.js'

type SdkAssistantPart = Exclude<
  Extract<SdkModelMessage, { role: 'assistant' }>['content'],
  string
>[number]
type SdkProviderOptions = NonNullable<
  Extract<SdkModelMessage, { role: 'system' }>['providerOptions']
>

const EPHEMERAL: SdkProviderOptions = { anthropic: { cacheControl: { type: 'ephemeral' } } }
const LEAKED_MARKUP = [
  /<tool_call>[\s\S]*?<\/tool_call>/g,
  /<function_calls>[\s\S]*?<\/function_calls>/g,
  /<\|tool_calls?_(?:section_)?begin\|>[\s\S]*?<\|tool_calls?_(?:section_)?end\|>/g,
]

export function cleanLeakedToolMarkup(text: string): string {
  return LEAKED_MARKUP.reduce((t, re) => t.replace(re, ''), text).trim()
}

/** 回复里的推理按段保存：每段的厂商元数据（签名）原样回放。 */
interface ReplayedReasoning {
  parts?: Array<{ text: string; providerMetadata?: SdkProviderOptions }>
}

function reasoningParts(text: string, providerData: unknown): SdkAssistantPart[] {
  const parts = (providerData as ReplayedReasoning | undefined)?.parts
  if (Array.isArray(parts)) {
    return parts.map((p) => ({
      type: 'reasoning' as const,
      text: p.text,
      ...(p.providerMetadata ? { providerOptions: p.providerMetadata } : {}),
    }))
  }
  return [
    {
      type: 'reasoning' as const,
      text,
      // 推理签名是厂商私有数据，按原样作为 providerOptions 带回。
      ...(providerData !== undefined
        ? { providerOptions: providerData as SdkProviderOptions }
        : {}),
    },
  ]
}

type ToolResult = Extract<ModelMessage, { role: 'tool' }>['content'][number]
type ImagePart = Extract<
  Exclude<Extract<ModelMessage, { role: 'user' }>['content'], string>[number],
  { type: 'image' }
>
type SdkUserPart = Exclude<Extract<SdkModelMessage, { role: 'user' }>['content'], string>[number]

// 能把工具结果里的图片作为图片发给模型的厂商包（按 AI SDK 7 各厂商包的源码核对）。其他厂商包会把图片
// 序列化成文本（例如 OpenAI Chat、OpenAI 兼容接口），图片改由这批工具结果之后的一条 user 消息带上。
const TOOL_RESULT_IMAGES = new Set([
  'anthropic.messages',
  'openai.responses',
  'google.generative-ai',
])

/** 工具结果里的图片怎么发：随结果发出、放进下一条消息，或不支持视觉时略去。 */
type ToolImages = 'inline' | 'next' | 'omit'

// AI SDK 7 已弃用 image 片段：图片用 file 片段发出，没给类型时写 image，由 SDK 按字节识别具体格式。
// data 用简写，base64、data URL、网址都由 SDK 自己识别。
const imagePart = (p: ImagePart) => ({
  type: 'file' as const,
  data: p.image,
  mediaType: p.mediaType ?? 'image',
})

/** 工具结果：图片按 `images` 发出；放进下一条消息或略去时，文本后加一行说明。 */
function toolOutput(r: ToolResult, images: ToolImages) {
  if (r.isError) return { type: 'error-text' as const, value: r.output }
  const list = r.images ?? []
  if (list.length === 0) return { type: 'text' as const, value: r.output }
  if (images !== 'inline') {
    const note = images === 'next' ? '见下一条消息' : '模型不支持视觉，未展示'
    return { type: 'text' as const, value: `${r.output}\n[图片 ${list.length} 张：${note}]` }
  }
  return {
    type: 'content' as const,
    value: [
      ...(r.output ? [{ type: 'text' as const, text: r.output }] : []),
      ...list.map((i) => ({
        type: 'file' as const,
        mediaType: i.mediaType ?? 'image',
        data: { type: 'data' as const, data: i.image },
      })),
    ],
  }
}

/** 放进下一条消息的图片：先注明来自哪次工具调用，免得模型当成用户发的。 */
function nextImages(r: ToolResult): SdkUserPart[] {
  if (r.isError || !r.images || r.images.length === 0) return []
  return [
    {
      type: 'text',
      text: `[工具 ${r.toolName}（调用 ${r.toolCallId}）返回的图片 ${r.images.length} 张，不是用户发送的]`,
    },
    ...r.images.map(imagePart),
  ]
}

function convert(
  m: ModelMessage,
  opts: { rewriteSystem: boolean; dropReasoning: boolean; images: ToolImages },
): SdkModelMessage {
  switch (m.role) {
    case 'system':
      return opts.rewriteSystem
        ? { role: 'user', content: `[system] ${m.content}` }
        : { role: 'system', content: m.content }
    case 'user':
      if (typeof m.content === 'string') return { role: 'user', content: m.content }
      return {
        role: 'user',
        content: m.content.map((p) => {
          if (p.type === 'text') return { type: 'text' as const, text: p.text }
          if (p.type === 'image') return imagePart(p)
          return {
            type: 'file' as const,
            data: p.data,
            mediaType: p.mediaType,
            ...(p.filename ? { filename: p.filename } : {}),
          }
        }),
      }
    case 'assistant': {
      if (typeof m.content === 'string') return { role: 'assistant', content: m.content }
      const content: SdkAssistantPart[] = []
      for (const p of m.content) {
        if (p.type === 'text') content.push({ type: 'text', text: p.text })
        else if (p.type === 'reasoning') {
          if (!opts.dropReasoning) content.push(...reasoningParts(p.text, p.providerData))
        } else
          content.push({
            type: 'tool-call',
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            input: p.input,
            // 工具调用的厂商元数据（例如 Gemini 的 thoughtSignature）同样原样带回。
            ...('providerData' in p && p.providerData !== undefined
              ? { providerOptions: p.providerData as SdkProviderOptions }
              : {}),
          })
      }
      return { role: 'assistant', content: content.length > 0 ? content : '' }
    }
    case 'tool':
      return {
        role: 'tool',
        content: m.content.map((r) => ({
          type: 'tool-result' as const,
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          output: toolOutput(r, opts.images),
        })),
      }
  }
}

export function toSdkMessages(
  messages: readonly ModelMessage[],
  opts: {
    systemAfterUser: boolean
    dropReasoning: boolean
    cacheBreakpoints?: number[]
    anthropic: boolean
    /** 模型支持视觉：工具结果里的图片作为图片发出；不支持时换成一行说明。 */
    vision: boolean
    /** AI SDK 模型实例的 provider（例如 openai.chat），决定工具结果里的图片放在哪。 */
    provider: string
  },
): SdkModelMessage[] {
  const breakpoints = new Set(opts.anthropic ? (opts.cacheBreakpoints ?? []) : [])
  const images: ToolImages = !opts.vision
    ? 'omit'
    : TOOL_RESULT_IMAGES.has(opts.provider)
      ? 'inline'
      : 'next'
  const out: SdkModelMessage[] = []
  let held: SdkUserPart[] = []
  let seenUser = false
  messages.forEach((m, i) => {
    out.push(
      convert(m, {
        rewriteSystem: m.role === 'system' && !opts.systemAfterUser && seenUser,
        dropReasoning: opts.dropReasoning,
        images,
      }),
    )
    if (m.role === 'user') seenUser = true
    if (images === 'next' && m.role === 'tool') held.push(...m.content.flatMap(nextImages))
    // 图片等这批工具消息结束再发：OpenAI 要求工具结果紧跟在发起调用的 assistant 消息之后。
    if (held.length > 0 && messages[i + 1]?.role !== 'tool') {
      out.push({ role: 'user', content: held })
      held = []
      seenUser = true
    }
    // 断点落在这条视图消息转出的最后一条上（带图片时是那条图片消息）。
    const last = out.length - 1
    if (breakpoints.has(i)) out[last] = { ...out[last]!, providerOptions: EPHEMERAL }
  })
  return out
}
