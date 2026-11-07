// AI SDK 适配器（设计 §8.1、方案 D2）：全包唯一 import `ai` 的地方。厂商的模型实例由应用创建后交进来。
// 单步调用：streamText + stopWhen: stepCountIs(1)，工具只传 schema、不传 execute；流式推送增量；
// 建连阶段只靠 SDK 的 maxRetries；流已建立、中途失败且还没收到内容时，可重试的错误再试一次；每次实际请求写入 attempts。
// 同一回复里重复的工具调用 id 按出现顺序加后缀，保证调用与结果一一配对。

import { jsonSchema, stepCountIs, streamText, wrapLanguageModel, type LanguageModel } from 'ai'
import { ModelCallError, abortError, systemClock } from '../../sdk.js'
import type {
  Clock,
  Delta,
  FinishReason,
  ModelAttempt,
  ModelCapabilities,
  ModelInput,
  ModelPort,
  ModelProvider,
  ModelResponse,
} from '../../sdk.js'
import { classifyError } from './errors.js'
import { cleanLeakedToolMarkup, toSdkMessages } from './messages.js'
import { reasoningOptions, type ReasoningLevel, type Vendor } from './reasoning.js'
import { normalizeUsage } from './usage.js'

const DEFAULT_MAX_RETRIES = 2
const DEFAULT_CAPABILITIES: Omit<ModelCapabilities, 'contextLimit'> = {
  maxOutputTokens: 8192,
  inputs: [],
  toolCalls: true,
  reasoning: 'none',
  systemAfterUser: true,
  parallelToolCalls: true,
}
const FINISH_REASONS = new Set<FinishReason>(['stop', 'length', 'content-filter', 'tool-calls'])

export interface AiSdkModelConfig {
  /** 应用创建的 AI SDK 模型实例（例如 anthropic('claude-…')）；不接受网关的模型 id 字符串。 */
  model: Exclude<LanguageModel, string>
  vendor?: Vendor
  capabilities: Partial<ModelCapabilities> & { contextLimit: number }
  reasoning?: ReasoningLevel
  /** 某个模型不能稳定接受带签名的推理回放时丢弃历史推理。 */
  dropReasoningHistory?: boolean
  /**
   * 应用为该模型声明、每次调用都带上的参数（设计 §8.1）：`providerOptions` 按厂商键与引擎生成的
   * 推理参数逐字段合并，同一字段应用优先；`headers` 与 AI SDK 的顶层 `reasoning` 原样传入。
   * 顶层 `reasoning` 与上面的 `reasoning` 只能给一个。
   */
  callSettings?: {
    providerOptions?: Record<string, Record<string, unknown>>
    headers?: Record<string, string>
    reasoning?: Parameters<typeof streamText>[0]['reasoning']
  }
}

type ProviderOptions = Record<string, Record<string, unknown>>

/** 按厂商键合并：`extra` 的字段覆盖 `base` 同一厂商键下的同名字段。 */
function mergeProviderOptions(
  base: ProviderOptions | undefined,
  extra: ProviderOptions | undefined,
): ProviderOptions | undefined {
  if (!extra || Object.keys(extra).length === 0) return base
  const result: ProviderOptions = { ...base }
  for (const [key, fields] of Object.entries(extra)) result[key] = { ...result[key], ...fields }
  return result
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** 同一回复里重复（或为空）的工具调用 id：按出现顺序加 `_2`、`_3`… 后缀，结果确定。 */
function uniqueId(id: string, seen: Set<string>): string {
  const base = id || 'call'
  let unique = base
  for (let n = 2; seen.has(unique); n++) unique = `${base}_${n}`
  seen.add(unique)
  return unique
}

function createPort(
  ref: string,
  config: AiSdkModelConfig,
  opts: { maxRetries: number; clock: Clock },
): ModelPort {
  const capabilities: ModelCapabilities = { ...DEFAULT_CAPABILITIES, ...config.capabilities }
  const vendor = config.vendor ?? 'other'
  const callSettings = config.callSettings ?? {}
  const providerOptions = mergeProviderOptions(
    reasoningOptions(vendor, config.reasoning),
    callSettings.providerOptions,
  )
  // 请求没写输出上限时，用应用声明的上限：不写的话 OpenAI 兼容接口按服务端默认值（常见 4K）截断。
  // 没声明就不发，免得默认值截断推理模型的思考。
  const declaredMaxOutput = config.capabilities.maxOutputTokens

  /** 一次 streamText：返回回复，或失败时的错误、流是否已建立、是否已收到内容。 */
  const attempt = async (
    input: ModelInput,
    signal: AbortSignal,
    onDelta: (d: Delta) => void,
    attempts: ModelAttempt[],
  ): Promise<
    { response: ModelResponse } | { error: unknown; streamed: boolean; received: boolean }
  > => {
    const maxOutputTokens = input.maxOutputTokens ?? declaredMaxOutput
    // 最后一次请求建流成功：之后的失败发生在流中途，SDK 不会再重试。
    let streamed = false
    const model = wrapLanguageModel({
      model: config.model,
      middleware: {
        specificationVersion: 'v4',
        async wrapStream({ doStream }) {
          const startedAt = opts.clock.now()
          try {
            streamed = false
            const result = await doStream()
            attempts.push({ startedAt, durationMs: opts.clock.now() - startedAt })
            streamed = true
            return result
          } catch (error) {
            attempts.push({
              startedAt,
              durationMs: opts.clock.now() - startedAt,
              error: messageOf(error),
            })
            throw error
          }
        },
      },
    })
    const forbidTools = input.toolChoice === 'none'
    const result = streamText({
      model,
      messages: toSdkMessages(input.messages, {
        systemAfterUser: capabilities.systemAfterUser,
        dropReasoning: config.dropReasoningHistory === true,
        ...(input.cacheBreakpoints ? { cacheBreakpoints: input.cacheBreakpoints } : {}),
        anthropic: vendor === 'anthropic',
        inputs: capabilities.inputs,
        provider: config.model.provider,
      }),
      ...(input.tools.length > 0
        ? {
            tools: Object.fromEntries(
              input.tools.map((t) => [
                t.name,
                { description: t.description, inputSchema: jsonSchema(t.inputSchema) },
              ]),
            ),
            toolChoice: forbidTools ? ('none' as const) : ('auto' as const),
          }
        : {}),
      ...(providerOptions
        ? {
            providerOptions: providerOptions as Parameters<typeof streamText>[0]['providerOptions'],
          }
        : {}),
      ...(callSettings.headers ? { headers: callSettings.headers } : {}),
      ...(callSettings.reasoning !== undefined ? { reasoning: callSettings.reasoning } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.topP !== undefined ? { topP: input.topP } : {}),
      stopWhen: stepCountIs(1),
      maxRetries: opts.maxRetries,
      abortSignal: signal,
      // 视图布局刻意把多层 system 放在消息里（设计 §3.13）。
      allowSystemInMessages: true,
      onError: () => undefined,
    })

    let received = false
    let failure: unknown
    let ignoredToolCall = false
    let text = ''
    // 推理按段（id）收集；厂商元数据（签名）可能出现在 start、delta、end 任一处，与 SDK 一样取最后一次出现的。
    const reasoning: Array<{ id: string; text: string; providerMetadata?: unknown }> = []
    const reasoningOf = (id: string) => {
      let r = reasoning.findLast((p) => p.id === id)
      if (!r) reasoning.push((r = { id, text: '' }))
      return r
    }
    const keepMetadata = (id: string, providerMetadata: unknown) => {
      if (providerMetadata) reasoningOf(id).providerMetadata = providerMetadata
    }
    const toolCalls: ModelResponse['toolCalls'] = []
    const callIds = new Set<string>()
    const warnings: string[] = []
    let finishReason: string = 'other'
    let usage: Parameters<typeof normalizeUsage>[0]
    let providerMetadata: Parameters<typeof normalizeUsage>[1]
    // 响应体流本身报错（例如连接中途断开，undici 抛 TypeError: terminated）也按失败处理：分类、重试同上。
    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'start-step':
            for (const w of part.warnings)
              warnings.push('message' in w && w.message ? w.message : JSON.stringify(w))
            break
          case 'text-delta':
            received = true
            text += part.text
            onDelta({ type: 'text', text: part.text })
            break
          case 'reasoning-start':
            reasoning.push({ id: part.id, text: '' })
            keepMetadata(part.id, part.providerMetadata)
            break
          case 'reasoning-delta':
            received = true
            reasoningOf(part.id).text += part.text
            keepMetadata(part.id, part.providerMetadata)
            onDelta({ type: 'reasoning', text: part.text })
            break
          case 'reasoning-end':
            keepMetadata(part.id, part.providerMetadata)
            break
          case 'tool-call':
            received = true
            // 工具调用的厂商元数据（例如 Gemini 的 thoughtSignature）回放时原样带回。
            toolCalls.push({
              id: uniqueId(part.toolCallId, callIds),
              name: part.toolName,
              input: part.input,
              ...(part.providerMetadata ? { providerData: part.providerMetadata } : {}),
            })
            break
          case 'finish-step':
            finishReason = part.finishReason
            usage = part.usage
            providerMetadata = part.providerMetadata
            break
          case 'error':
            // 只在兜底交付时禁用工具；厂商仍返回工具调用时忽略它（设计 §8.1 工具选择）。
            if (
              forbidTools &&
              (part.error as Error | undefined)?.name === 'AI_ToolChoiceViolationError'
            ) {
              ignoredToolCall = true
            } else {
              failure = part.error
            }
            break
        }
      }
    } catch (error) {
      failure = error
    }
    if (failure !== undefined) return { error: failure, streamed, received }

    const mapped: FinishReason = FINISH_REASONS.has(finishReason as FinishReason)
      ? (finishReason as FinishReason)
      : 'other'
    return {
      response: {
        text: cleanLeakedToolMarkup(text),
        ...(reasoning.length > 0
          ? {
              reasoning: {
                text: reasoning.map((r) => r.text).join('\n'),
                providerData: {
                  parts: reasoning.map((r) => ({
                    text: r.text,
                    ...(r.providerMetadata ? { providerMetadata: r.providerMetadata } : {}),
                  })),
                },
              },
            }
          : {}),
        toolCalls: forbidTools ? [] : toolCalls,
        finishReason: forbidTools && (ignoredToolCall || mapped === 'tool-calls') ? 'stop' : mapped,
        usage: normalizeUsage(usage, providerMetadata),
        warnings,
        attempts,
      },
    }
  }

  // 只用于算模型配置指纹：header 只取名字，值可能是凭据，轮换时不应改变指纹。
  const settings = {
    vendor,
    reasoning: config.reasoning ?? null,
    dropReasoningHistory: config.dropReasoningHistory === true,
    providerOptions: callSettings.providerOptions ?? null,
    sdkReasoning: callSettings.reasoning ?? null,
    headers: Object.keys(callSettings.headers ?? {}).sort(),
  }

  return {
    ref,
    capabilities,
    settings,
    async call(input, { signal, onDelta }) {
      const attempts: ModelAttempt[] = []
      let retried = false
      for (;;) {
        const outcome = await attempt(input, signal, onDelta, attempts)
        if (signal.aborted) throw abortError()
        if ('response' in outcome) return outcome.response
        const detail = classifyError(outcome.error, attempts)
        // 建连阶段的失败 SDK 已按 maxRetries 重试过，这里只补流中途、还没收到内容的那一种。
        if (detail.retryable && outcome.streamed && !outcome.received && !retried) {
          retried = true
          continue
        }
        throw new ModelCallError(detail)
      }
    },
  }
}

export function aiSdkProvider(opts: {
  id: string
  models: Record<string, AiSdkModelConfig>
  maxRetries?: number
  clock?: Clock
}): ModelProvider {
  for (const [name, config] of Object.entries(opts.models)) {
    // 两个是同一件事的通用开关；厂商参数会盖过顶层 reasoning，任何先后规则都会因厂商而有漏洞，
    // 所以只许给一个。
    if (config.reasoning !== undefined && config.callSettings?.reasoning !== undefined) {
      throw new Error(
        `模型 ${opts.id}:${name} 同时设置了 reasoning 与 callSettings.reasoning，只能二选一`,
      )
    }
  }
  const ports = new Map<string, ModelPort>()
  const settings = {
    maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
    clock: opts.clock ?? systemClock(),
  }
  return {
    id: opts.id,
    resolve(ref) {
      const prefix = `${opts.id}:`
      if (!ref.startsWith(prefix)) return undefined
      const config = opts.models[ref.slice(prefix.length)]
      if (!config) return undefined
      let port = ports.get(ref)
      if (!port) {
        port = createPort(ref, config, settings)
        ports.set(ref, port)
      }
      return port
    },
  }
}
