// 运行 → AI SDK UI message stream（设计 §2）：前端 useChat 直接消费，断线后从运行日志续上。
// 片段由日志事件决定（投影）：同一运行、同一 fromSeq 回放出的片段相同。瞬时通知只做实时预览与工具进度；
// 每一步的推理与正文在模型调用落定时按日志校正，预览与日志对不上时先 reset-step 再整段重发，
// 所以不论何时接入、从哪条事件续上，前端最后拼出的消息都与日志一致。

import {
  UI_MESSAGE_STREAM_HEADERS,
  type FinishReason,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import type {
  ArchiveStore,
  BlobRef,
  Notice,
  Run,
  RunEvent,
  RunResult,
  RunStatus,
} from '../../sdk.js'

/** `start` 带 runId；`finish` 带结局（只写结果里有的字段）。 */
export interface RunMessageMetadata {
  runId: string
  status?: RunStatus
  code?: string
  intent?: RunResult['intent']
  output?: unknown
  error?: RunResult['error']
}

/** 数据部件：工具进度，瞬时，不进消息（前端在 `onData` 里收到）。 */
export type RunDataParts = { 'tool-progress': { toolCallId: string; note: string } }
export type RunUIMessage = UIMessage<RunMessageMetadata, RunDataParts>
export type RunUIMessageChunk = UIMessageChunk<RunMessageMetadata, RunDataParts>

export interface RunUIStreamOptions {
  /**
   * 从这条事件起发送（含）。缺省 1：从头回放，前端收到 `start` 重建整条消息；
   * 续流时取 SSE 的 `Last-Event-ID + 1`，不再发 `start`。
   */
  fromSeq?: number
  /** 读工具结果正文用；不给时结果只带状态，出错时 errorText 为错误码。 */
  archive?: Pick<ArchiveStore, 'getBlob'>
}

/** `seq`：这个片段是该事件产生的最后一个时有，写成 SSE 的 `id`，前端据此续流。 */
interface Item {
  chunk: RunUIMessageChunk
  seq?: number
}

type Kind = 'reasoning' | 'text'
const KINDS: readonly Kind[] = ['reasoning', 'text']

const FINISH_REASONS: Record<RunStatus, FinishReason> = {
  completed: 'stop',
  finalized: 'stop',
  awaiting_input: 'stop',
  stopped: 'other',
  failed: 'error',
  aborted: 'interrupted',
}

const startOf = (kind: Kind, id: string): RunUIMessageChunk =>
  kind === 'text' ? { type: 'text-start', id } : { type: 'reasoning-start', id }
const deltaOf = (kind: Kind, id: string, delta: string): RunUIMessageChunk =>
  kind === 'text' ? { type: 'text-delta', id, delta } : { type: 'reasoning-delta', id, delta }
const endOf = (kind: Kind, id: string): RunUIMessageChunk =>
  kind === 'text' ? { type: 'text-end', id } : { type: 'reasoning-end', id }

/** 该事件产生的片段：最后一个带 seq。 */
const group = (seq: number, chunks: RunUIMessageChunk[]) =>
  chunks.map((chunk, i): Item => (i === chunks.length - 1 ? { chunk, seq } : { chunk }))

function ending(runId: string, r: RunResult): RunUIMessageChunk[] {
  const messageMetadata: RunMessageMetadata = {
    runId,
    status: r.status,
    ...(r.code !== undefined ? { code: r.code } : {}),
    ...(r.intent ? { intent: r.intent } : {}),
    ...(r.output !== undefined ? { output: r.output } : {}),
    ...(r.error ? { error: r.error } : {}),
  }
  const finish: RunUIMessageChunk = {
    type: 'finish',
    finishReason: FINISH_REASONS[r.status],
    messageMetadata,
  }
  // useChat 收到 error 即抛错、不再处理后面的片段：先 finish 带上结局，再报错。
  if (r.status === 'failed') {
    const errorText = r.error ? `${r.error.code}: ${r.error.message}` : (r.code ?? 'failed')
    return [finish, { type: 'error', errorText }]
  }
  if (r.status === 'aborted')
    return [{ type: 'abort', ...(r.code ? { reason: r.code } : {}) }, finish]
  return [finish]
}

/** 工具结果：待审批的不发（部件停在 approval-requested）；委托人拒绝的标成 denied。 */
function toolResult(
  e: Extract<RunEvent, { t: 'tool_finished' }>,
  body: string | undefined,
): RunUIMessageChunk[] {
  if (e.errorCode === 'APPROVAL_PENDING') return []
  if (e.errorCode === 'USER_DENIED') {
    return [
      { type: 'tool-approval-response', approvalId: e.callId, approved: false },
      { type: 'tool-output-denied', toolCallId: e.callId },
    ]
  }
  if (e.isError) {
    // 正文第一行是 `ERROR [CODE]: message`，后面的 HINT 是给模型看的。
    const errorText = body?.split('\n')[0] || e.errorCode || 'TOOL_ERROR'
    return [{ type: 'tool-output-error', toolCallId: e.callId, errorText }]
  }
  return [{ type: 'tool-output-available', toolCallId: e.callId, output: body }]
}

function createProjector(runId: string, fromSeq: number, archive: RunUIStreamOptions['archive']) {
  let step: number | undefined
  let stepSeq = 0
  let settled = true
  /** 本条流里这一步已经发出的推理与正文（按开始的顺序）。 */
  let live = new Map<Kind, string>()
  /** 每个调用的审批理由（非影子规则的 ask.summary）。 */
  const asks = new Map<string, string[]>()

  const delta = (kind: Kind, text: string): RunUIMessageChunk[] => {
    const id = `${kind}-${step}`
    const sent = live.get(kind)
    live.set(kind, (sent ?? '') + text)
    return sent === undefined
      ? [startOf(kind, id), deltaOf(kind, id, text)]
      : [deltaOf(kind, id, text)]
  }

  /** 模型调用落定：以日志为准对齐本步的推理与正文（BR-002）。 */
  const settle = (auth: Record<Kind, string>): RunUIMessageChunk[] => {
    const expected = KINDS.filter((k) => auth[k] !== '')
    const order = [...live.keys()]
    const consistent =
      order.every((k, i) => expected[i] === k) &&
      order.every((k) => auth[k].startsWith(live.get(k)!))
    const out: RunUIMessageChunk[] = []
    // 从这一步中间续上时，前端可能留着旧连接的半截：总是先清掉。
    if (stepSeq < fromSeq || !consistent) {
      out.push({ type: 'reset-step' })
      live = new Map()
    }
    for (const kind of expected) {
      const id = `${kind}-${step}`
      const sent = live.get(kind)
      if (sent === undefined) out.push(startOf(kind, id))
      const rest = auth[kind].slice(sent?.length ?? 0)
      if (rest !== '') out.push(deltaOf(kind, id, rest))
      out.push(endOf(kind, id))
    }
    live = new Map()
    settled = true
    return out
  }

  const readShown = async (ref: BlobRef): Promise<string | undefined> => {
    if (!archive) return undefined
    try {
      const data = await archive.getBlob(ref)
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
      return text.replace(/^<tool_output>\n/, '').replace(/\n<\/tool_output>$/, '')
    } catch {
      return undefined
    }
  }

  return {
    async event(e: RunEvent): Promise<Item[]> {
      switch (e.t) {
        case 'run_started':
          return group(e.seq, [{ type: 'start', messageId: runId, messageMetadata: { runId } }])
        case 'step_started':
          step = e.step
          stepSeq = e.seq
          settled = false
          live = new Map()
          return group(e.seq, [{ type: 'start-step' }])
        case 'model_responded': {
          const { response } = e
          const calls = response.toolCalls.map((c): RunUIMessageChunk => ({
            type: 'tool-input-available',
            toolCallId: c.id,
            toolName: c.name,
            input: c.input,
          }))
          const text = settle({ reasoning: response.reasoning?.text ?? '', text: response.text })
          return group(e.seq, [...text, ...calls])
        }
        case 'model_failed':
          return group(e.seq, settle({ reasoning: '', text: '' }))
        case 'model_aborted':
          return group(e.seq, settle({ reasoning: '', text: e.partialText }))
        case 'permission_decided': {
          const { verdict } = e
          if (typeof verdict === 'object' && 'ask' in verdict && !e.source.startsWith('shadow:')) {
            asks.set(e.callId, [...(asks.get(e.callId) ?? []), verdict.ask.summary])
          }
          return []
        }
        case 'approval_answered': {
          const reason = (asks.get(e.callId) ?? []).join('；')
          const chunks: RunUIMessageChunk[] = [
            {
              type: 'tool-approval-request',
              approvalId: e.callId,
              toolCallId: e.callId,
              ...(reason ? { reason } : {}),
            },
          ]
          if (e.approved) {
            chunks.push({ type: 'tool-approval-response', approvalId: e.callId, approved: true })
          }
          return group(e.seq, chunks)
        }
        case 'tool_finished':
          return group(
            e.seq,
            toolResult(e, e.seq >= fromSeq ? await readShown(e.shown) : undefined),
          )
        case 'step_ended':
          return group(e.seq, [{ type: 'finish-step' }])
        case 'delivery_checked':
          // 被退回或转兜底的草稿不是最终文本：去掉这一步。
          return e.path === 'normal' && (e.outcome === 'returned' || e.outcome === 'fallback')
            ? group(e.seq, [{ type: 'reset-step' }])
            : []
        case 'fallback_generated':
          settled = true
          return group(e.seq, [
            { type: 'start-step' },
            startOf('text', 'text-fallback'),
            deltaOf('text', 'text-fallback', e.text),
            endOf('text', 'text-fallback'),
            { type: 'finish-step' },
          ])
        case 'run_ended':
          return group(e.seq, ending(runId, e.result))
        default:
          return []
      }
    },

    notice(n: Notice): RunUIMessageChunk[] {
      switch (n.t) {
        case 'text_delta':
        case 'reasoning_delta': {
          // 只预览本条流从开头看着的那一步；早于它的 step_started 到达、或从这一步中间续上时，
          // 增量丢掉，落定时按日志整段发。
          if (n.step !== step || settled || stepSeq < fromSeq) return []
          return delta(n.t === 'text_delta' ? 'text' : 'reasoning', n.text)
        }
        case 'tool_progress':
          return [
            {
              type: 'data-tool-progress',
              id: n.callId,
              data: { toolCallId: n.callId, note: n.note },
              transient: true,
            },
          ]
        default:
          return []
      }
    },
  }
}

function items(run: Run, opts: RunUIStreamOptions): ReadableStream<Item> {
  const fromSeq = opts.fromSeq ?? 1
  if (!Number.isSafeInteger(fromSeq) || fromSeq < 1) {
    throw new RangeError(`fromSeq 必须是不小于 1 的整数：${fromSeq}`)
  }
  const projector = createProjector(run.runId, fromSeq, opts.archive)
  let closed = false
  let off = () => {}
  return new ReadableStream<Item>({
    start(controller) {
      // 总是从第 1 条事件建状态；fromSeq 之前的事件只更新状态、不发片段。不订阅子运行。
      off = run.subscribe({
        async onEvent(e) {
          if (closed) return
          const out = await projector.event(e)
          if (closed) return
          if (e.seq >= fromSeq) for (const item of out) controller.enqueue(item)
          if (e.t === 'run_ended') {
            closed = true
            off()
            controller.close()
          }
        },
        onNotice(n) {
          if (closed) return
          for (const chunk of projector.notice(n)) controller.enqueue({ chunk })
        },
      })
    },
    // 前端断开只解除订阅，不取消运行（停止运行由应用调用 run.abort）。
    cancel() {
      closed = true
      off()
    },
  })
}

/** 运行 → UI message stream 片段流（`useChat` 的协议）。 */
export function runToUIMessageStream(
  run: Run,
  opts: RunUIStreamOptions = {},
): ReadableStream<RunUIMessageChunk> {
  return items(run, opts).pipeThrough(
    new TransformStream<Item, RunUIMessageChunk>({
      transform: (item, controller) => controller.enqueue(item.chunk),
    }),
  )
}

/** 同上，包成 SSE 响应；每个事件产生的最后一个片段带 `id: <seq>`，客户端重连时据 `Last-Event-ID` 续上。 */
export function runToUIMessageStreamResponse(
  run: Run,
  opts: RunUIStreamOptions & { headers?: Record<string, string> } = {},
): Response {
  const body = items(run, opts)
    .pipeThrough(
      new TransformStream<Item, string>({
        transform({ chunk, seq }, controller) {
          const id = seq === undefined ? '' : `id: ${seq}\n`
          controller.enqueue(`${id}data: ${JSON.stringify(chunk)}\n\n`)
        },
        flush(controller) {
          controller.enqueue('data: [DONE]\n\n')
        },
      }),
    )
    .pipeThrough(new TextEncoderStream())
  return new Response(body, { headers: { ...UI_MESSAGE_STREAM_HEADERS, ...opts.headers } })
}
