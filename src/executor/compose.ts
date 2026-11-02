// ① 组装（设计 §3.5）：追加上一步留下的提示和委托人引导 → 记忆给出视图 → 工具呈现给出可见工具
// → 固定布局 → 复核成对与前缀哈希 → 估算。step_started、intervention_applied、context_built 一次产出。

import type { Clock, LogLevel, ModelMessage, Segment } from '../contracts/common.js'
import type { MemoryState, MemoryView, RunInfo, ToolboxState } from '../contracts/component.js'
import type { BlobRef, RunEventBody } from '../contracts/events.js'
import type { ModelInput } from '../contracts/model.js'
import { visibleToolsIssue } from '../core/component-results.js'
import { estimateMessages, estimateTools } from '../core/estimate.js'
import { canonicalJson, hashOf } from '../core/hash.js'
import { layout, segmentToMessage } from '../core/layout.js'
import type { RunState } from '../core/state.js'
import { callComponent, failureDetail } from './call-component.js'
import { BlobCache, preview, recallView, renderTranscript, stepEvents } from './compose-view.js'
import { toModelTool, type PreparedTool } from './tools.js'

export interface ComposeDeps {
  run: RunInfo
  clock: Clock
  notice: Segment[]
  instructions: Segment[]
  capabilities: Segment[]
  task: { input: Segment[]; history: ModelMessage[]; volatile: Segment[] }
  unavailable: ReadonlyArray<{ capability: string; reason: string }>
  toolset: ReadonlyMap<string, PreparedTool>
  exposureOf: ReadonlyMap<string, 'eager' | 'deferred'>
  memory: { recall(state: MemoryState): Promise<MemoryView> }
  exposure?: { visible(state: ToolboxState): string[] }
  getBlob(ref: BlobRef): Promise<string>
  putBlob(data: string): Promise<BlobRef>
  log(level: LogLevel, message: string, detail?: unknown): void
  componentTimeoutMs?: number
  /** 记忆的超时；默认 MEMORY_TIMEOUT_MS。 */
  memoryTimeoutMs?: number
}

export interface ComposeResult {
  events: RunEventBody[]
  input: ModelInput
  visible: ReadonlySet<string>
}

export interface Composer {
  compose(state: RunState): Promise<ComposeResult>
  /** 本步的模型回复与工具结果（兜底交付接在上一次视图后面，设计 §11）。 */
  lastStep(state: RunState): Promise<ModelMessage[]>
}

export function unavailableSegment(
  unavailable: ReadonlyArray<{ capability: string; reason: string }>,
): Segment | undefined {
  if (unavailable.length === 0) return undefined
  const lines = unavailable.map((u) => `- ${u.capability}：${u.reason}`).join('\n')
  return { role: 'system', parts: [{ type: 'text', text: `以下能力本次不可用：\n${lines}` }] }
}

export function createComposer(deps: ComposeDeps): Composer {
  const blobs = new BlobCache((ref) => deps.getBlob(ref))
  let prefix: { stable: string; input: string } | undefined

  const visibleTools = async (step: number, state: RunState): Promise<string[]> => {
    const all = [...deps.toolset.keys()]
    const exposure = deps.exposure
    if (!exposure) return all
    const prepared = all.map((name) => {
      const tool = deps.toolset.get(name)!
      return {
        name,
        capability: tool.capability,
        exposure: deps.exposureOf.get(name) ?? 'eager',
        description: tool.def.description,
      }
    })
    const calls: Array<{ step: number; name: string }> = []
    for (const entry of state.transcript) {
      if (entry.origin !== 'model' || !Array.isArray(entry.message.content)) continue
      for (const part of entry.message.content) {
        if (part.type === 'tool-call') calls.push({ step: entry.step, name: part.toolName })
      }
    }
    const outcome = await callComponent(
      () => Promise.resolve(exposure.visible({ step, prepared, calls })),
      { clock: deps.clock, timeoutMs: deps.componentTimeoutMs, validate: visibleToolsIssue },
    )
    // 出错与返回值不合格（设计 §4.4）：退回全部可见。
    if (!outcome.ok) {
      const why = outcome.invalid ? `返回值不合格：${outcome.invalid.issue}；` : '出错，'
      deps.log('warn', `工具呈现${why}退回全部可见`, failureDetail(outcome))
      return all
    }
    const chosen = new Set(outcome.value)
    const unknown = [...chosen].filter((name) => !deps.toolset.has(name))
    if (unknown.length > 0) deps.log('warn', `工具呈现给出了不存在的工具：${unknown.join(', ')}`)
    // 按呈现方式给出的顺序（去掉不存在的、去重）：新加载的工具追加在末尾，不打碎提示词前缀
    const ordered: string[] = []
    for (const name of outcome.value) {
      if (deps.toolset.has(name) && !ordered.includes(name)) ordered.push(name)
    }
    return ordered
  }

  return {
    async lastStep(state) {
      const entries = state.transcript.filter(
        (e) => (e.origin === 'model' || e.origin === 'tool') && e.step === state.step,
      )
      return renderTranscript({ ...state, transcript: entries, pendingSteers: [] }, blobs)
    },
    async compose(state) {
      const step = state.step + 1
      const now = deps.clock.now()
      const bodies = stepEvents(state, step)
      const next = preview(state, bodies, now)
      const transcript = await renderTranscript(next, blobs)

      const visible = await visibleTools(step, next)
      const tools = visible.map((name) => toModelTool(deps.toolset.get(name)!))

      const stable = [...deps.notice, ...deps.instructions, ...deps.capabilities].map(
        segmentToMessage,
      )
      const inputMessages = deps.task.input.map(segmentToMessage)
      const unavailable = unavailableSegment(deps.unavailable)
      const tail = [...deps.task.volatile, ...(unavailable ? [unavailable] : [])]
      const calibrate = (raw: number) => Math.ceil(raw * next.calibration)

      const view = await recallView(
        deps.memory,
        {
          step,
          history: deps.task.history,
          transcript,
          contextLimit: deps.run.model.contextLimit,
          fixedTokens: calibrate(
            estimateMessages([...stable, ...inputMessages, ...tail.map(segmentToMessage)]) +
              estimateTools(tools),
          ),
          estimate: (messages) => calibrate(estimateMessages(messages)),
        },
        {
          clock: deps.clock,
          ...(deps.memoryTimeoutMs !== undefined ? { timeoutMs: deps.memoryTimeoutMs } : {}),
          log: (message) => deps.log('warn', message),
        },
      )

      const input = layout({
        notice: deps.notice,
        instructions: deps.instructions,
        capabilities: deps.capabilities,
        history: view.history,
        input: deps.task.input,
        transcript: view.transcript,
        tail,
        tools,
      })

      // 前缀复核（I3）：须知、指令、能力说明与任务输入不参与压缩，必须与第一步相同。
      const hashes = { stable: hashOf(stable), input: hashOf(inputMessages) }
      if (!prefix) prefix = hashes
      else if (prefix.stable !== hashes.stable || prefix.input !== hashes.input) {
        throw new Error('视图前缀被改写（须知、指令、能力说明或任务输入）')
      }

      const messages: BlobRef[] = []
      for (const m of input.messages) messages.push(await deps.putBlob(canonicalJson(m)))
      const compaction = view.compaction
        ? {
            replaced: view.compaction.replaced,
            summary: await deps.putBlob(view.compaction.summary),
            anchorsKept: view.compaction.anchorsKept,
          }
        : undefined
      const contextBuilt: RunEventBody = {
        t: 'context_built',
        step,
        messages,
        tools: visible,
        estimate: calibrate(estimateMessages(input.messages) + estimateTools(input.tools)),
        ...(compaction ? { compaction } : {}),
      }
      return { events: [...bodies, contextBuilt], input, visible: new Set(visible) }
    },
  }
}
