// ① 组装的前半部分：预演本步追加的提示与引导，渲染运行记录，取得记忆给出的视图并复核成对（I2）。

import type { Clock, ModelMessage } from '../contracts/common.js'
import type { MemoryState, MemoryView } from '../contracts/component.js'
import type { BlobRef, RunEvent, RunEventBody } from '../contracts/events.js'
import { memoryViewIssue } from '../core/component-results.js'
import { canonicalJson } from '../core/hash.js'
import { transcriptMessages } from '../core/projections.js'
import { apply, type RunState } from '../core/state.js'
import { callComponent, MEMORY_TIMEOUT_MS } from './call-component.js'

/** 本步开始的事件：step_started，再按"先提示、后封路"写入上一步留下的干预。 */
export function stepEvents(state: RunState, step: number): RunEventBody[] {
  const events: RunEventBody[] = [{ t: 'step_started', step }]
  const pending = state.pendingInterventions
  for (const i of pending) {
    if ('hint' in i) {
      events.push({
        t: 'intervention_applied',
        step,
        intervention: { hint: i.hint },
        source: i.source,
      })
    }
  }
  for (const i of pending) {
    if (!('block' in i)) continue
    events.push({
      t: 'intervention_applied',
      step,
      intervention: { block: i.block },
      source: i.source,
    })
  }
  return events
}

/** 在临时编号上预演事件，得到追加之后的状态（不写日志）。 */
export function preview(state: RunState, bodies: readonly RunEventBody[], now: number): RunState {
  return bodies.reduce(
    (s, body, i) => apply(s, { ...body, seq: state.lastSeq + 1 + i, at: now } as RunEvent),
    state,
  )
}

/** blob 正文缓存：blob 不可变，每个引用只解析一次。 */
export class BlobCache {
  private readonly cache = new Map<BlobRef, string>()

  constructor(private readonly resolve: (ref: BlobRef) => Promise<string>) {}

  async get(ref: BlobRef): Promise<string> {
    let text = this.cache.get(ref)
    if (text === undefined) {
      text = await this.resolve(ref)
      this.cache.set(ref, text)
    }
    return text
  }

  snapshot(): ReadonlyMap<BlobRef, string> {
    return this.cache
  }
}

/** 运行记录渲染为模型消息；待合并的引导作为最后一条 user 消息。 */
export async function renderTranscript(state: RunState, blobs: BlobCache): Promise<ModelMessage[]> {
  for (const entry of state.transcript) {
    if (entry.origin === 'tool') for (const r of entry.results) await blobs.get(r.shown)
    else if (entry.origin === 'hook') await blobs.get(entry.content)
  }
  const messages = transcriptMessages(state.transcript, blobs.snapshot())
  if (state.pendingSteers.length > 0) {
    messages.push({ role: 'user', content: state.pendingSteers.join('\n\n') })
  }
  return messages
}

/** 复核成对：每个工具调用后面紧跟它的结果，中间不插入其他消息（I2）。 */
export function checkPairs(messages: readonly ModelMessage[]): string[] {
  const violations: string[] = []
  let pending: string[] = []
  const flush = () => {
    if (pending.length > 0) violations.push(`工具调用 ${pending.join(', ')} 没有紧跟结果`)
    pending = []
  }
  for (const m of messages) {
    if (m.role === 'tool') {
      for (const part of m.content) {
        if (pending.includes(part.toolCallId))
          pending = pending.filter((id) => id !== part.toolCallId)
        else violations.push(`工具结果 ${part.toolCallId} 没有对应的调用`)
      }
      continue
    }
    flush()
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const part of m.content) if (part.type === 'tool-call') pending.push(part.toolCallId)
    }
  }
  flush()
  return violations
}

/**
 * 复核前缀（I3）：history 与运行记录原样保留；声明了压缩时，只有 `replaced` 区间（history + 运行记录
 * 连在一起的下标，左闭右开）可以换成别的消息。保留下来的消息不能跨过任务输入换位置；末尾可以追加消息
 * （如压缩冷却期间的警告，设计 §11），但追加的只能落在运行记录里。
 */
function checkKept(
  before: { messages: readonly string[]; history: number },
  view: MemoryView,
): string | undefined {
  const input = before.messages
  const shown = [...view.history, ...view.transcript].map((m) => canonicalJson(m))
  const n = input.length
  const inHistory = before.history
  const shownHistory = view.history.length
  let from = n
  let to = n
  if (view.compaction) {
    const [a, b] = view.compaction.replaced
    from = Math.max(0, Math.min(a, n))
    to = Math.max(0, Math.min(b, n))
    if (!(from <= to)) return `压缩区间 [${a}, ${b}) 不合法`
  }
  const at = (i: number, v: number) => shown[v] === input[i] && i < inHistory === v < shownHistory
  for (let i = 0; i < from; i++) if (!at(i, i)) return `第 ${i} 条消息被改写`
  // 被替换的区间换成了几条消息不限；没有声明压缩时不能多出消息。
  const kept = n - to
  const last = view.compaction ? shown.length - kept : from
  for (let p = from; p <= last; p++) {
    let ok = shownHistory <= p + kept
    for (let i = to; ok && i < n; i++) ok = at(i, p + i - to)
    if (ok) return undefined
  }
  return view.compaction
    ? `压缩区间 [${from}, ${to}) 之外的消息被改写`
    : '没有声明压缩却删除、改写或插入了消息'
}

/**
 * 记忆出错或超时：沿用完整视图（没有压缩），超出上下文时由组装环节按超限停止。视图破坏成对、
 * 改写了 history 与运行记录时抛错，由驱动转为 engine_error（设计 §4.4）。
 */
export async function recallView(
  memory: { recall(state: MemoryState): Promise<MemoryView> },
  memoryState: MemoryState,
  opts: { clock: Clock; timeoutMs?: number; log?: (message: string) => void },
): Promise<MemoryView> {
  // 调用前记下输入：记忆就地改了传入的数组也查得出来。
  const before = {
    messages: [...memoryState.history, ...memoryState.transcript].map((m) => canonicalJson(m)),
    history: memoryState.history.length,
  }
  // 形状不合格与出错一样沿用完整视图；拆开成对、改写记录仍按设计 §4.4 让运行失败。
  const outcome = await callComponent(() => memory.recall(memoryState), {
    clock: opts.clock,
    timeoutMs: opts.timeoutMs ?? MEMORY_TIMEOUT_MS,
    validate: memoryViewIssue,
  })
  if (!outcome.ok) {
    const why = outcome.invalid
      ? `返回值不合格：${outcome.invalid.issue}`
      : outcome.timedOut
        ? '超时'
        : String(outcome.error)
    opts.log?.(`记忆出错，沿用完整视图：${why}`)
    return { history: [...memoryState.history], transcript: [...memoryState.transcript] }
  }
  const violations = checkPairs([...outcome.value.history, ...outcome.value.transcript])
  if (violations.length > 0) throw new Error(`记忆视图破坏了成对：${violations.join('；')}`)
  const rewritten = checkKept(before, outcome.value)
  if (rewritten) throw new Error(`记忆视图改写了 history 或运行记录：${rewritten}`)
  return outcome.value
}
