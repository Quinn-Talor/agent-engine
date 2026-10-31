// 测试模型（设计 §13）：按脚本回复的模型提供方与端口，可以注入延迟、错误、截断、挂起。

import { ModelCallError, abortError, estimateMessages, estimateText, systemClock } from '../api.js'
import type { Clock } from '../contracts/common.js'
import type { ModelErrorCode } from '../contracts/errors.js'
import type {
  FinishReason,
  ModelCapabilities,
  ModelInput,
  ModelPort,
  ModelProvider,
  ModelRef,
  ModelResponse,
  NormalizedUsage,
} from '../contracts/model.js'

export type FakeReply =
  | {
      text?: string
      toolCalls?: Array<{ id?: string; name: string; input?: unknown }>
      finishReason?: FinishReason
      usage?: Partial<NormalizedUsage>
      reasoning?: { text: string; providerData?: unknown }
      delayMs?: number
    }
  | {
      error: { code: ModelErrorCode; message?: string; retryable?: boolean; status?: number }
      delayMs?: number
    }
  | { hang: true }
  | ((input: ModelInput) => FakeReply)

export interface FakeModel extends ModelProvider {
  readonly ref: ModelRef
  readonly port: ModelPort
  /** 每次调用收到的输入，按调用顺序。 */
  readonly inputs: ModelInput[]
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  contextLimit: 128_000,
  maxOutputTokens: 8192,
  vision: false,
  toolCalls: true,
  reasoning: 'none',
  systemAfterUser: true,
  parallelToolCalls: true,
}

type StaticReply = Exclude<FakeReply, (input: ModelInput) => FakeReply>

/** 函数型回复按输入展开，直到得到静态回复。 */
function settle(reply: FakeReply, input: ModelInput): StaticReply {
  return typeof reply === 'function' ? settle(reply(input), input) : reply
}

function waitFor(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cancel()
      reject(abortError())
    }
    const cancel = clock.setTimer(ms, () => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function fakeModel(opts: {
  provider?: string
  model?: string
  capabilities?: Partial<ModelCapabilities>
  replies: FakeReply[]
  clock?: Clock
  repeatLast?: boolean
}): FakeModel {
  const provider = opts.provider ?? 'fake'
  const ref = `${provider}:${opts.model ?? 'model'}`
  const clock = opts.clock ?? systemClock()
  const inputs: ModelInput[] = []

  const port: ModelPort = {
    ref,
    capabilities: { ...DEFAULT_CAPABILITIES, ...opts.capabilities },
    async call(input, { signal, onDelta }): Promise<ModelResponse> {
      const n = inputs.length
      inputs.push(input)
      const scripted = opts.replies[n] ?? (opts.repeatLast ? opts.replies.at(-1) : undefined)
      if (!scripted) {
        throw new ModelCallError({
          code: 'MODEL_ERROR',
          message: 'fake model script exhausted',
          retryable: false,
          attempts: [],
        })
      }
      const reply = settle(scripted, input)
      if ('hang' in reply) {
        return new Promise((_, reject) => {
          if (signal.aborted) reject(abortError())
          signal.addEventListener('abort', () => reject(abortError()), { once: true })
        })
      }
      if (signal.aborted) throw abortError()
      if (reply.delayMs) await waitFor(clock, reply.delayMs, signal)
      if ('error' in reply) {
        const { code, message, retryable, status } = reply.error
        throw new ModelCallError({
          code,
          message: message ?? code,
          retryable: retryable ?? false,
          ...(status !== undefined ? { status } : {}),
          attempts: [],
        })
      }
      const text = reply.text ?? ''
      if (reply.reasoning) onDelta({ type: 'reasoning', text: reply.reasoning.text })
      if (text) onDelta({ type: 'text', text })
      const toolCalls = (reply.toolCalls ?? []).map((c, i) => ({
        id: c.id ?? `call-${n}-${i}`,
        name: c.name,
        input: c.input ?? {},
      }))
      const response: ModelResponse = {
        text,
        toolCalls,
        finishReason: reply.finishReason ?? (toolCalls.length > 0 ? 'tool-calls' : 'stop'),
        usage: {
          input: estimateMessages(input.messages),
          output: estimateText(text),
          cacheRead: 0,
          cacheWrite: 0,
          ...reply.usage,
        },
        warnings: [],
        attempts: [{ startedAt: clock.now(), durationMs: 0 }],
      }
      if (reply.reasoning) response.reasoning = reply.reasoning
      return response
    },
  }

  return {
    id: provider,
    ref,
    port,
    inputs,
    resolve: (r) => (r === ref ? port : undefined),
  }
}
