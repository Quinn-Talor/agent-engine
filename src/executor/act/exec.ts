// 工具流水线 f–h（设计 §8.2）：熔断、执行（超时即中止，取消信号传给工具）、规整。
// 流水线不重试任何调用：有副作用的调用永不自动重做（设计 I15），重试由工具自己决定。

import type { Clock } from '../../contracts/common.js'
import { isToolError, toolError, type ToolErrorEnvelope } from '../../contracts/errors.js'
import type { SideModelRequest, SideModelResponse } from '../../contracts/model.js'
import { isToolContent, type ToolContent, type ToolCtx } from '../../contracts/tool.js'
import type { PreparedTool } from './tools.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_CHARS = 8192
const MAX_RAW_CHARS = 1_048_576

/** `unknown`：工具已经开始执行，但不知道结果（超时、抛错、执行中取消）。 */
export type ExecOutcome = { value: unknown } | { error: ToolErrorEnvelope; unknown?: true }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const ERROR_CLASSES: ReadonlySet<unknown> = new Set(['deterministic', 'transient'])

/** 工具声明的错误类别只认两个合法值；其他值（拼错、配置里读来的任意值）丢掉，按错误码判断。 */
function declared(envelope: ToolErrorEnvelope): ToolErrorEnvelope {
  if (envelope.errorClass === undefined || ERROR_CLASSES.has(envelope.errorClass)) return envelope
  const { errorClass: _dropped, ...rest } = envelope
  return rest
}

export async function executeTool(
  tool: PreparedTool,
  input: unknown,
  ctx: ToolCtx,
  opts: {
    clock: Clock
    signal: AbortSignal
    /** 工具经引擎调用模型；`signal` 是这次调用的信号（工具超时或取消时触发）。 */
    callModel?: (
      req: SideModelRequest,
      signal: AbortSignal,
    ) => Promise<SideModelResponse | undefined>
  },
): Promise<ExecOutcome> {
  const { def } = tool
  let available: boolean
  try {
    available = tool.available?.() ?? true
  } catch (error) {
    return {
      error: toolError('TOOL_EXCEPTION', `工具 ${def.name} 的熔断检查出错：${messageOf(error)}`),
    }
  }
  if (!available) {
    return {
      error: toolError(
        'TOOL_UNAVAILABLE',
        `工具 ${def.name} 依赖的服务暂时不可用`,
        '改用其他能力，或说明限制',
      ),
    }
  }
  const timeoutMs = def.execution?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  return new Promise<ExecOutcome>((resolve) => {
    let settled = false
    const finish = (outcome: ExecOutcome) => {
      if (settled) return
      settled = true
      cancelTimer()
      opts.signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    let started = false
    const unknown = (): { unknown?: true } => (started ? { unknown: true } : {})
    const onAbort = () => {
      controller.abort()
      finish({ error: toolError('TOOL_ABORTED', '运行已取消'), ...unknown() })
    }
    const cancelTimer = opts.clock.setTimer(timeoutMs, () => {
      controller.abort()
      finish({ error: toolError('TOOL_TIMEOUT', `工具执行超过 ${timeoutMs}ms`), ...unknown() })
    })
    if (opts.signal.aborted) return onAbort()
    started = true
    opts.signal.addEventListener('abort', onAbort, { once: true })
    // 子运行跟随本次调用的信号：工具超时或运行取消时子运行一起取消。
    const signal = controller.signal
    const spawn: ToolCtx['spawn'] = (agent, task, o) =>
      ctx.spawn(agent, task, {
        ...o,
        signal: o?.signal ? AbortSignal.any([o.signal, signal]) : signal,
      })
    Promise.resolve()
      .then(() => {
        // 工具里的模型调用同样跟随本次调用的信号。
        const callModel: ToolCtx['callModel'] = opts.callModel
          ? (req) => opts.callModel!(req, signal)
          : ctx.callModel
        return def.execute(input, { ...ctx, signal, spawn, callModel })
      })
      .then(
        (value) => finish(isToolError(value) ? { error: declared(value) } : { value }),
        // 抛出的信封是工具明确报告的失败；其他异常不知道执行到了哪里。
        (error: unknown) =>
          finish(
            isToolError(error)
              ? { error: declared(error) }
              : { error: toolError('TOOL_EXCEPTION', messageOf(error)), unknown: true },
          ),
      )
  })
}

export interface NormalizedOutput {
  /** 模型实际看到的内容：`<tool_output>` 包裹、超长截断。 */
  shown: string
  /** 发生截断时的原始输出（超过 1MB 时截断并注明原始大小）。 */
  raw?: string
  isError: boolean
  errorCode?: string
  /** 内容块结果里的图片（base64）。 */
  images?: ToolImage[]
}

export interface ToolImage {
  data: string
  mediaType: string
}

/** 单张图片的大小上限（字节）与每次结果的张数上限。 */
const MAX_IMAGE_BYTES = 5_242_880
const MAX_IMAGES = 8
const BASE64 = /^[A-Za-z0-9+/=\s]+$/

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  // 分段拼接，避免大图一次展开参数过多。
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** 内容块结果拆成正文与图片；有不合格的块时整个结果按工具异常处理。 */
function contentOf(
  content: ToolContent,
): { text: string; images: ToolImage[] } | { error: ToolErrorEnvelope } {
  const texts: string[] = []
  const images: ToolImage[] = []
  let overflow = 0
  for (const [i, part] of content.parts.entries()) {
    let image: { data: string; bytes: number } | undefined
    if (part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text)
      continue
    } else if (part.type === 'image' && part.image instanceof Uint8Array) {
      image = { data: bytesToBase64(part.image), bytes: part.image.length }
    } else if (part.type === 'image' && typeof part.image === 'string' && BASE64.test(part.image)) {
      const data = part.image.replace(/\s/g, '')
      image = { data, bytes: Math.floor((data.length * 3) / 4) }
    } else {
      return { error: toolError('TOOL_EXCEPTION', `工具返回的内容块不合格：第 ${i + 1} 块`) }
    }
    if (image.bytes > MAX_IMAGE_BYTES) texts.push(`[图片过大，未展示：${image.bytes} 字节]`)
    else if (images.length >= MAX_IMAGES) overflow += 1
    else images.push({ data: image.data, mediaType: part.mediaType ?? 'image' })
  }
  if (overflow > 0) texts.push(`[其余 ${overflow} 张图片未展示：每次最多 ${MAX_IMAGES} 张]`)
  return { text: texts.join('\n'), images }
}

function bodyOf(outcome: ExecOutcome): string {
  if ('error' in outcome) {
    const { code, message, hint } = outcome.error
    return `ERROR [${code}]: ${message}${hint ? `\nHINT: ${hint}` : ''}`
  }
  const { value } = outcome
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  const json = JSON.stringify(value) as string | undefined
  if (json === undefined) throw new Error(`不支持的类型 ${typeof value}`)
  return json
}

/**
 * h 规整：识别错误信封；超长时保留头尾截断并注明原始长度；外面包一层 `<tool_output>`。
 * 脱敏在截断之前做，避免密钥被截成半截而逃过模式匹配。
 */
export function normalizeOutput(
  outcome: ExecOutcome,
  maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
  redact: (text: string) => string = (text) => text,
): NormalizedOutput {
  let text: string
  let images: ToolImage[] = []
  try {
    if ('value' in outcome && isToolContent(outcome.value)) {
      const content = contentOf(outcome.value)
      if ('error' in content) {
        outcome = content
        text = bodyOf(outcome)
      } else {
        text = content.text
        images = content.images
      }
    } else text = bodyOf(outcome)
  } catch (error) {
    // BigInt、循环引用、函数等无法序列化的结果按工具异常处理（I5）。
    outcome = { error: toolError('TOOL_EXCEPTION', `工具结果无法序列化：${messageOf(error)}`) }
    text = bodyOf(outcome)
  }
  const original = redact(text)
  let body = original
  let raw: string | undefined
  if (original.length > maxOutputChars) {
    const half = Math.floor(maxOutputChars / 2)
    body = `${original.slice(0, half)}\n…[已截断：原始长度 ${original.length} 字符]…\n${original.slice(-half)}`
    raw =
      original.length > MAX_RAW_CHARS
        ? `${original.slice(0, MAX_RAW_CHARS)}\n…[raw 已截断：原始长度 ${original.length} 字符]`
        : original
  }
  // 工具输出伪造不了标签（设计 §10.7）。
  const safe = body.replaceAll('</tool_output>', '<\\/tool_output>')
  const out: NormalizedOutput = { shown: `<tool_output>\n${safe}\n</tool_output>`, isError: false }
  if (raw !== undefined) out.raw = raw
  if (images.length > 0) out.images = images
  if ('error' in outcome) {
    out.isError = true
    out.errorCode = outcome.error.code
  }
  return out
}
