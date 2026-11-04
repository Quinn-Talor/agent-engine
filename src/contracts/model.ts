// 模型相关契约：模型引用与要求、模型端口与提供方、输入输出、用量与价格、模型库（设计 §1.8、§8.1）。

import type { JsonSchema, ModelMessage } from './common.js'
import type { BreakerStatus } from './engine.js'
import type { ModelErrorCode } from './errors.js'

/** 模型引用，格式 `<提供方 id>:<模型 id>`；模型库按冒号前缀分派提供方。 */
export type ModelRef = string

/** Agent 对模型的要求（设计 §1.8）。 */
export interface ModelRequirements {
  vision?: boolean
  minContext?: number
  toolCalls?: boolean
  reasoning?: boolean
}

export interface ModelCapabilities {
  contextLimit: number
  maxOutputTokens: number
  vision: boolean
  toolCalls: boolean
  reasoning: 'none' | 'optional' | 'forced'
  systemAfterUser: boolean
  parallelToolCalls: boolean
}

/** 交给模型的工具定义：schema 已在准备环节转换为 JSON Schema。 */
export interface ModelToolSpec {
  name: string
  description: string
  inputSchema: JsonSchema
}

/** 固定视图布局的产物（设计 §3.13）。 */
export interface ModelInput {
  messages: ModelMessage[]
  tools: ModelToolSpec[]
  /** 只在兜底交付时为 `none`（设计 §8.1 工具选择）。 */
  toolChoice?: 'auto' | 'none'
  /** 缓存断点：消息下标，断点打在该消息末尾（设计 §8.1 缓存断点）。 */
  cacheBreakpoints?: number[]
  maxOutputTokens?: number
  /** Agent 的采样参数（`AgentDef.model.settings`）：只用于主模型调用与兜底调用。 */
  temperature?: number
  topP?: number
}

/** Agent 给主模型调用定的采样参数（设计 §1.4）；推理档位等厂商参数在模型配置里。 */
export interface ModelSettings {
  /** 0 到 2。 */
  temperature?: number
  /** 大于 0、不超过 1。 */
  topP?: number
}

export type Delta = { type: 'text'; text: string } | { type: 'reasoning'; text: string }

/** 一次实际请求，含建连重试（设计 §8.1）。 */
export interface ModelAttempt {
  startedAt: number
  durationMs: number
  error?: string
}

export interface NormalizedUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** 运行结果的用量：总量，以及主模型、记忆、监督、子运行分开统计（设计 §2）。 */
export interface RunUsage extends NormalizedUsage {
  main: NormalizedUsage
  memory: NormalizedUsage
  supervision: NormalizedUsage
  /** 工具经 `ToolCtx.callModel` 的模型调用。 */
  tools: NormalizedUsage
  children: NormalizedUsage
}

export type FinishReason = 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'other'

export interface ModelResponse {
  text: string
  /** 保留签名，回放时原样带回。 */
  reasoning?: { text: string; providerData?: unknown }
  /** `providerData`：厂商私有数据（例如 Gemini 的 thoughtSignature），回放时原样带回。 */
  toolCalls: Array<{ id: string; name: string; input: unknown; providerData?: unknown }>
  finishReason: FinishReason
  usage: NormalizedUsage
  warnings: string[]
  /** 每次实际请求，含建连重试。 */
  attempts: ModelAttempt[]
}

export interface ModelError {
  code: ModelErrorCode
  message: string
  retryable: boolean
  status?: number
  attempts: ModelAttempt[]
}

export interface ModelPort {
  ref: ModelRef
  /** 可以随应用配置变化（例如用 getter 读当前配置）；引擎在每次运行开始时读取，运行中不变。 */
  capabilities: ModelCapabilities
  /**
   * 端口每次调用都带上的配置（可序列化），引擎只用它算模型配置指纹（`run_started.modelFingerprint`）；
   * 可以用 getter 读当前配置。凭据不要放进来。
   */
  readonly settings?: unknown
  call(
    input: ModelInput,
    opts: { signal: AbortSignal; onDelta: (d: Delta) => void },
  ): Promise<ModelResponse>
}

export interface ModelProvider {
  id: string
  resolve(ref: ModelRef): ModelPort | undefined
}

/** 价格：美元 / 百万 token。 */
export interface ModelPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export type PriceTable = Record<ModelRef, ModelPrice>

/** 熔断策略（设计 §5.2）：默认连续失败 5 次打开，冷却 30 秒后半开。 */
export interface BreakerPolicy {
  failureThreshold?: number
  cooldownMs?: number
}

/** 模型库：提供方、默认模型、价格表；按提供方并发、按模型熔断（设计 §1.2、§8.1）。 */
export interface ModelHub {
  readonly defaultModel?: ModelRef
  /** 返回经过并发上限与熔断包装的端口；不认识的引用返回 undefined。 */
  resolve(ref: ModelRef): ModelPort | undefined
  price(ref: ModelRef): ModelPrice | undefined
  health(): BreakerStatus[]
  onHealth(fn: (status: BreakerStatus) => void): () => void
}

/** 组件经 `ctx.callModel` 发起的模型调用（设计 §9.1）。 */
export interface SideModelRequest {
  /** 用途，写入 `external_call.source`，例如 `memory:compaction`、`supervision:advise`。 */
  purpose: string
  system?: string
  messages: ModelMessage[]
  /** 不指定时使用运行的模型。 */
  model?: ModelRef
  maxOutputTokens?: number
  timeoutMs?: number
}

export interface SideModelResponse {
  text: string
  usage: NormalizedUsage
  model: ModelRef
  /** `length` 表示输出被截断。 */
  finishReason: FinishReason
}
