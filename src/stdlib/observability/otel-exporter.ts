// OpenTelemetry 导出（设计 §6.6、方案 D7）：运行事件 → OTLP 风格的 span 数据；只产出数据结构，
// 发送由应用注入。traceId 由根运行 id 得出，同一棵委托树的运行在同一条 trace 里；子运行的根 span
// 挂在父运行发起它的工具 span 下。会话的一轮在根 span 上带会话 id；没通过的验收 span 状态仍为 OK，
// 由属性 `agent.pass` 标出。

import { sha256Hex } from '../../sdk.js'
import type { Logger, TraceNode } from '../../sdk.js'
import { delegateNodeId, exportOnEnd, walk, type ExportSubscriber } from './trace-export.js'

export interface OtelSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: 'INTERNAL'
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Record<string, string | number | boolean>
  status: { code: 'OK' | 'ERROR'; message?: string }
}

const nanos = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString()

/**
 * 会话 id 的属性名，取自 OpenTelemetry GenAI 语义约定（开发中，2026-06 迁到 semantic-conventions-genai）；
 * 约定改名时只改这一处。
 */
const CONVERSATION_ID = 'gen_ai.conversation.id'

function attributesOf(node: TraceNode): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(node.attrs)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[`agent.${key}`] = value
    } else if (key === 'usage' && typeof value === 'object' && value !== null) {
      for (const [k, v] of Object.entries(value))
        if (typeof v === 'number') out[`agent.usage.${k}`] = v
    }
  }
  return out
}

export function otelExporter(opts: {
  send(spans: OtelSpan[]): void | Promise<void>
  logger?: Logger
  serviceName?: string
}): ExportSubscriber {
  const serviceName = opts.serviceName ?? 'agent-engine'
  return exportOnEnd({
    send: opts.send,
    ...(opts.logger ? { logger: opts.logger } : {}),
    transform(trace, runId, events) {
      const started = events.find((e) => e.t === 'run_started')
      const traceId = sha256Hex(started?.t === 'run_started' ? started.rootRunId : runId).slice(
        0,
        32,
      )
      const parentRunId = started?.t === 'run_started' ? started.parentRunId : undefined
      const nodes = walk(trace, runId, parentRunId ? { parentId: delegateNodeId(runId) } : {})
      return nodes.map(({ node, id, parentId, error }) => ({
        traceId,
        spanId: id,
        ...(parentId ? { parentSpanId: parentId } : {}),
        name: node.name,
        kind: 'INTERNAL' as const,
        startTimeUnixNano: nanos(node.startedAt),
        endTimeUnixNano: nanos(node.startedAt + (node.durationMs ?? 0)),
        attributes: {
          'service.name': serviceName,
          'agent.kind': node.kind,
          'agent.run_id': runId,
          ...(node.kind === 'run' && typeof node.attrs.session === 'string'
            ? { [CONVERSATION_ID]: node.attrs.session }
            : {}),
          ...attributesOf(node),
        },
        status: error ? { code: 'ERROR' as const, message: error } : { code: 'OK' as const },
      }))
    },
  })
}
