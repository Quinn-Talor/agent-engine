// ① 组装的前半部分：预演本步追加的提示与引导，渲染运行记录，取得记忆的压缩决定并复核成对（I2）。

import type { Clock, ModelMessage } from '../../contracts/common.js'
import type { MemoryState, MemoryView } from '../../contracts/component.js'
import type { BlobRef, RunEvent, RunEventBody } from '../../contracts/events.js'
import { memoryViewIssue } from '../../core/definition/component-results.js'
import { transcriptMessages } from '../../core/log/projections.js'
import { renderView } from '../../core/run/layout.js'
import { apply, type RunState } from '../../core/run/state.js'
import { callComponent, MEMORY_TIMEOUT_MS } from '../call-component.js'

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
    if (entry.origin === 'tool') {
      for (const r of entry.results) {
        await blobs.get(r.shown)
        for (const i of r.images ?? []) await blobs.get(i.blob)
      }
    } else if (entry.origin === 'hook') await blobs.get(entry.content)
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

/** 记忆的决定；`failed` 表示这一步记忆没有给出可用的决定，组装沿用上一步生效的压缩。 */
export type RecalledView = MemoryView & { failed?: true }

/**
 * 记忆给出压缩决定（设计 §9.3），视图由 renderView 渲染。记忆拿到的是深拷贝，改了也不影响运行。
 * 出错、超时、形状不合格、压缩超出给定的消息、切点拆开成对时返回 `failed`（会话方案 §8）：压缩一旦
 * 声明，记忆失败不能让它退回；提示照常保留。
 */
export async function recallView(
  memory: { recall(state: MemoryState): Promise<MemoryView> },
  memoryState: MemoryState,
  opts: { clock: Clock; timeoutMs?: number; log?: (message: string) => void },
): Promise<RecalledView> {
  const { history, transcript } = memoryState
  const copy: MemoryState = {
    ...memoryState,
    history: structuredClone(history),
    transcript: structuredClone(transcript),
    turnStarts: [...memoryState.turnStarts],
  }
  const outcome = await callComponent(() => memory.recall(copy), {
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
    opts.log?.(`记忆出错，沿用上一步的压缩：${why}`)
    return { failed: true }
  }
  const { compaction, notice } = outcome.value
  if (!compaction) return notice !== undefined ? { notice } : {}
  const total = history.length + transcript.length
  const rendered = renderView(history, transcript, compaction)
  const issue =
    compaction.upTo > total
      ? `upTo ${compaction.upTo} 超出了 ${total} 条消息`
      : checkPairs([...rendered.history, ...rendered.transcript]).length > 0
        ? '切点拆开了工具调用与结果'
        : undefined
  if (issue) {
    opts.log?.(`记忆的压缩不合格，沿用上一步的压缩：${issue}`)
    return { failed: true, ...(notice !== undefined ? { notice } : {}) }
  }
  return {
    compaction: { upTo: compaction.upTo, summary: compaction.summary },
    ...(notice !== undefined ? { notice } : {}),
  }
}
