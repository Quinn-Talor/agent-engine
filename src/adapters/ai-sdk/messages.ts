// 消息规整与推理回放（设计 §8.1）：视图消息 → AI SDK 消息。systemAfterUser=false 的厂商把 user 之后的
// system 改写成带固定标记的 user 内容；推理内容、签名和工具调用的厂商元数据原样带回（可配置为丢弃历史推理）；
// 仅 Anthropic 在断点所在消息上打 ephemeral 缓存标记；清洗回复里泄漏的工具调用标记。

import type { ModelMessage as SdkModelMessage } from 'ai'
import type { ModelMessage } from '../../api.js'

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

function convert(
  m: ModelMessage,
  opts: { rewriteSystem: boolean; dropReasoning: boolean },
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
          if (p.type === 'image') {
            return {
              type: 'image' as const,
              image: p.image,
              ...(p.mediaType ? { mediaType: p.mediaType } : {}),
            }
          }
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
          output: r.isError
            ? { type: 'error-text' as const, value: r.output }
            : { type: 'text' as const, value: r.output },
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
  },
): SdkModelMessage[] {
  const breakpoints = new Set(opts.anthropic ? (opts.cacheBreakpoints ?? []) : [])
  let seenUser = false
  return messages.map((m, i) => {
    const converted = convert(m, {
      rewriteSystem: m.role === 'system' && !opts.systemAfterUser && seenUser,
      dropReasoning: opts.dropReasoning,
    })
    if (m.role === 'user') seenUser = true
    return breakpoints.has(i) ? { ...converted, providerOptions: EPHEMERAL } : converted
  })
}
