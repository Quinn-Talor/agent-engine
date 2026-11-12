// 投影（设计 §6.3）：状态、运行记录、观察、交付记录、副作用清单、语料、运行摘要都由运行日志推导。

import type { ModelMessage, Segment } from '../../contracts/common.js'
import type { Corpus, Observation } from '../../contracts/component.js'
import type { BlobRef, LedgerEntry, RunEvent, RunOrigin } from '../../contracts/events.js'
import type { QualityReport, RunSummary } from '../../contracts/run.js'
import type { ToolEffect } from '../../contracts/tool.js'
import { parseCanonical } from '../definition/hash.js'
import { possiblyExecuted } from '../supervision/error-class.js'
import { segmentToMessage } from '../run/layout.js'
import { apply, initial, type RunState, type TranscriptEntry } from '../run/state.js'

type Of<T extends RunEvent['t']> = Extract<RunEvent, { t: T }>

const find = <T extends RunEvent['t']>(events: readonly RunEvent[], t: T): Of<T> | undefined =>
  events.find((e): e is Of<T> => e.t === t)

function unstartedSummary(ended: Of<'run_ended'>, origin: RunOrigin): RunSummary {
  const summary: RunSummary = {
    runId: ended.result.runId,
    rootRunId: origin.rootRunId,
    environment: origin.environment,
    environmentFingerprint: origin.environmentFingerprint,
    engineFingerprint: origin.engineFingerprint,
    agentId: origin.agentId,
    agentFingerprint: origin.agentFingerprint,
    model: ended.result.model,
    startedAt: ended.at,
    endedAt: ended.at,
    status: ended.result.status,
    steps: 0,
    toolCalls: 0,
    usage: ended.result.usage,
    pinned: false,
  }
  if (origin.parentRunId !== undefined) summary.parentRunId = origin.parentRunId
  if (origin.agentVersion !== undefined) summary.agentVersion = origin.agentVersion
  if (origin.subject !== undefined) summary.subject = origin.subject
  if (origin.session !== undefined) summary.session = origin.session
  if (ended.result.code !== undefined) summary.code = ended.result.code
  return summary
}

export function foldState(events: readonly RunEvent[]): RunState {
  const runId = find(events, 'run_ended')?.result.runId ?? ''
  return events.reduce(apply, initial({ runId }))
}

/**
 * 运行摘要；runId 由档案以自己的键覆盖。没有 run_started 的运行（受理失败等）按 run_ended 上的
 * 归属给出摘要；两者都还没写入时没有摘要。
 */
export function summarize(events: readonly RunEvent[]): RunSummary | undefined {
  const started = find(events, 'run_started')
  const ended = find(events, 'run_ended')
  if (!started) return ended?.origin ? unstartedSummary(ended, ended.origin) : undefined
  const state = foldState(events)
  const summary: RunSummary = {
    runId: ended?.result.runId ?? state.runId,
    rootRunId: started.rootRunId,
    environment: started.environment.name,
    environmentFingerprint: started.environment.fingerprint,
    engineFingerprint: started.engine.fingerprint,
    agentId: started.agent.id,
    agentFingerprint: started.agent.fingerprint,
    model: started.model,
    startedAt: started.at,
    steps: events.filter((e) => e.t === 'step_started').length,
    toolCalls: events.filter((e) => e.t === 'tool_finished').length,
    usage: state.usage,
    pinned: false,
  }
  if (started.parentRunId !== undefined) summary.parentRunId = started.parentRunId
  if (started.agent.version !== undefined) summary.agentVersion = started.agent.version
  if (started.task.subject !== undefined) summary.subject = started.task.subject
  if (started.session) {
    summary.session = started.session.id
    summary.turn = started.session.turn
    if (started.session.continues) summary.continues = started.session.continues.runId
  }
  if (ended) {
    summary.status = ended.result.status
    if (ended.result.code !== undefined) summary.code = ended.result.code
    summary.endedAt = ended.at
    if (ended.result.cost !== undefined) summary.cost = ended.result.cost
  }
  return summary
}

/** 运行记录条目转为模型消息；blob 正文由调用方预先取出。 */
export function transcriptMessages(
  entries: readonly TranscriptEntry[],
  blobs: ReadonlyMap<BlobRef, string>,
): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const entry of entries) {
    switch (entry.origin) {
      case 'model':
        messages.push(entry.message)
        break
      case 'tool':
        messages.push({
          role: 'tool',
          content: entry.results.map((r) => ({
            type: 'tool-result',
            toolCallId: r.callId,
            toolName: r.toolName,
            output: blobs.get(r.shown) ?? '',
            isError: r.isError,
            ...(r.images && r.images.length > 0
              ? {
                  images: r.images.map((i) => ({
                    type: 'image' as const,
                    image: blobs.get(i.blob) ?? '',
                    mediaType: i.mediaType,
                  })),
                }
              : {}),
          })),
        })
        break
      case 'hint':
        // 纠偏消息自带标题，不再加来源前缀。
        messages.push({
          role: 'system',
          content: entry.source === 'steering' ? entry.text : `[${entry.source}] ${entry.text}`,
        })
        break
      case 'steer':
        messages.push({ role: 'user', content: entry.text })
        break
      case 'hook': {
        const segments = parseCanonical(blobs.get(entry.content) ?? '[]') as Segment[]
        messages.push(...segments.map(segmentToMessage))
        break
      }
    }
  }
  return messages
}

export function observations(events: readonly RunEvent[]): Observation[] {
  return events.filter((e): e is Of<'evaluated'> => e.t === 'evaluated').map((e) => e.observation)
}

export function deliveries(
  events: readonly RunEvent[],
): Array<Of<'delivery_checked'> | Of<'fallback_generated'>> {
  return events.filter(
    (e): e is Of<'delivery_checked'> | Of<'fallback_generated'> =>
      e.t === 'delivery_checked' || e.t === 'fallback_generated',
  )
}

/** 质量报告：取最后一次定稿的交付记录；拦截项放行未解决的进 unresolved，标注项进 annotations。 */
export function qualityOf(events: readonly RunEvent[]): QualityReport | undefined {
  const final = [...events]
    .reverse()
    .find(
      (e): e is Of<'delivery_checked'> => e.t === 'delivery_checked' && e.outcome === 'delivered',
    )
  if (!final) return undefined
  const unresolved = final.checks
    .filter((c) => c.mode === 'gate' && !c.pass)
    .map((c) => ({ source: c.source, issues: c.issues ?? [] }))
  const annotations = final.checks
    .filter((c) => c.mode === 'annotate')
    .map((c) => ({ source: c.source, pass: c.pass, ...(c.issues ? { issues: c.issues } : {}) }))
  if (unresolved.length === 0 && annotations.length === 0) return undefined
  return { unresolved, annotations }
}

export interface SideEffect {
  callId: string
  toolName: string
  capability: string
  effect: 'idempotent' | 'side_effect'
  step: number
  input: unknown
  status: 'executed' | 'possibly_executed'
}

export function sideEffects(events: readonly RunEvent[]): SideEffect[] {
  const calls = new Map<string, { name: string; input: unknown; step: number }>()
  const list: SideEffect[] = []
  for (const e of events) {
    if (e.t === 'model_responded') {
      for (const c of e.response.toolCalls)
        calls.set(c.id, { name: c.name, input: c.input, step: e.step })
    } else if (e.t === 'tool_finished' && e.effect !== 'none') {
      let status: SideEffect['status'] | undefined
      if (!e.isError) status = 'executed'
      else if (possiblyExecuted(e)) status = 'possibly_executed'
      if (!status) continue
      const c = calls.get(e.callId)
      list.push({
        callId: e.callId,
        toolName: c?.name ?? '',
        capability: e.capability,
        effect: e.effect,
        step: c?.step ?? 0,
        input: c?.input,
        status,
      })
    }
  }
  return list
}

const LEDGER_STATUS = { executed: '已执行', possibly_executed: '可能已执行' } as const

/** 语料：任务输入 + history + 工具输出中的 shown + 会话之前各轮的副作用台账（设计 §6.3）。 */
export function buildCorpus(parts: {
  input: readonly Segment[]
  history: readonly ModelMessage[]
  toolOutputs: ReadonlyArray<{
    callId: string
    text: string
    toolName?: string
    effect?: ToolEffect
    isError?: boolean
  }>
  ledger?: readonly LedgerEntry[]
}): Corpus {
  const sources: Array<Corpus['sources'][number]> = []
  for (const segment of parts.input) {
    for (const p of segment.parts)
      if (p.type === 'text') sources.push({ origin: 'input', text: p.text })
  }
  for (const m of parts.history) {
    if (typeof m.content === 'string') {
      sources.push({ origin: 'history', text: m.content })
      continue
    }
    for (const p of m.content) {
      if (p.type === 'text') sources.push({ origin: 'history', text: p.text })
      else if (p.type === 'tool-result') sources.push({ origin: 'history', text: p.output })
    }
  }
  for (const { text, callId, ...meta } of parts.toolOutputs)
    sources.push({ origin: 'tool', text, callId, ...meta })
  for (const l of parts.ledger ?? []) {
    sources.push({
      origin: 'ledger',
      text: `第 ${l.turn} 轮${LEDGER_STATUS[l.status]} ${l.tool} ${l.input}`,
      toolName: l.tool,
    })
  }
  return { sources }
}
