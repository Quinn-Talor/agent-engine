// 错误分类（设计 §8.1）：剥开 NoOutputGeneratedError 与 RetryError 后，归类为 MODEL_TIMEOUT、MODEL_CONNECTION、
// RATE_LIMITED、AUTH_FAILED、CONTEXT_TOO_LONG、CONTENT_FILTER、MODEL_ERROR；模型库据此决定是否计入熔断。

import { APICallError, NoOutputGeneratedError, RetryError } from 'ai'
import type { ModelAttempt, ModelError, ModelErrorCode } from '../../api.js'

// Anthropic：input length and `max_tokens` exceed context limit；Gemini：input token count … exceeds the
// maximum number of tokens allowed；OpenAI：maximum context length。
const CONTEXT_TOO_LONG =
  /context (length|window|limit)|maximum context|too many tokens|prompt is too long|input is too long|exceeds the maximum number of tokens/i
// 参数名（safety_settings、safetySettings、safety settings）不算内容过滤。
const CONTENT_FILTER =
  /content[ _-]?(filter|policy|management)|\bsafety\b(?![ _-]?settings?\b)|\bblocked\b/i
const NETWORK =
  /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|socket hang up|other side closed|cannot connect|network/i
const TIMEOUT = /ETIMEDOUT|timed? ?out/i
// Node / undici / Bun 的网络错误码（与 provider-utils 的 handleFetchError 一致）。
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
])
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

function unwrap(error: unknown): unknown {
  let current = error
  for (;;) {
    if (NoOutputGeneratedError.isInstance(current) && current.cause !== undefined)
      current = current.cause
    else if (RetryError.isInstance(current) && current.lastError !== undefined)
      current = current.lastError
    else return current
  }
}

/** 沿 cause 链找网络故障：超时、建连失败、DNS、连接中途断开（undici 的 `terminated`）。 */
function transportFailure(error: unknown): 'MODEL_TIMEOUT' | 'MODEL_CONNECTION' | undefined {
  const seen = new Set<unknown>()
  for (let e = error; e instanceof Error && !seen.has(e); e = e.cause) {
    seen.add(e)
    const code = (e as { code?: unknown }).code
    if ((typeof code === 'string' && TIMEOUT_CODES.has(code)) || TIMEOUT.test(e.message))
      return 'MODEL_TIMEOUT'
    if (
      (typeof code === 'string' && NETWORK_CODES.has(code)) ||
      NETWORK.test(e.message) ||
      e.message === 'terminated'
    )
      return 'MODEL_CONNECTION'
  }
  return undefined
}

export function classifyError(error: unknown, attempts: ModelAttempt[]): ModelError {
  const e = unwrap(error)
  const message = e instanceof Error ? e.message : String(e)
  const result = (code: ModelErrorCode, retryable: boolean, status?: number): ModelError => ({
    code,
    message,
    retryable,
    ...(status !== undefined ? { status } : {}),
    attempts,
  })
  if (APICallError.isInstance(e)) {
    const status = e.statusCode
    const text = `${message}\n${e.responseBody ?? ''}`
    if (status === 401 || status === 403) return result('AUTH_FAILED', false, status)
    if (status === 429) return result('RATE_LIMITED', true, status)
    if (status === 408) return result('MODEL_TIMEOUT', true, status)
    // 建连失败、DNS、undici 超时被 SDK 包成没有状态码、可重试的 APICallError：按超时 / 连接错误计入熔断。
    if (status === undefined) {
      const transport = transportFailure(e)
      if (transport || e.isRetryable) return result(transport ?? 'MODEL_CONNECTION', true)
    }
    if (CONTEXT_TOO_LONG.test(text)) return result('CONTEXT_TOO_LONG', false, status)
    if (CONTENT_FILTER.test(text)) return result('CONTENT_FILTER', false, status)
    if (status !== undefined && status >= 500) return result('MODEL_ERROR', true, status)
    return result('MODEL_ERROR', e.isRetryable, status)
  }
  const transport = transportFailure(e)
  if (transport) return result(transport, true)
  if (CONTEXT_TOO_LONG.test(message)) return result('CONTEXT_TOO_LONG', false)
  return result('MODEL_ERROR', false)
}
