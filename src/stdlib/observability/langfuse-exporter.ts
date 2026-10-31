// Langfuse 导出（设计 §6.6、方案 D7）：运行事件 → Langfuse ingestion 事件数据：trace、span、generation
// （模型调用，带模型与用量）；只产出数据结构，发送由应用注入。

import type { Logger } from '../../api.js'
import { exportOnEnd, walk, type ExportSubscriber } from './trace-export.js'

export interface LangfuseEvent {
  type: 'trace-create' | 'span-create' | 'generation-create'
  body: Record<string, unknown>
}

const iso = (ms: number) => new Date(ms).toISOString()

export function langfuseExporter(opts: {
  send(events: LangfuseEvent[]): void | Promise<void>
  logger?: Logger
}): ExportSubscriber {
  return exportOnEnd({
    send: opts.send,
    ...(opts.logger ? { logger: opts.logger } : {}),
    transform(trace, runId) {
      const nodes = walk(trace, runId)
      const runNodeId = nodes[0]!.id
      const model = typeof trace.attrs.model === 'string' ? trace.attrs.model : undefined
      const events: LangfuseEvent[] = [
        {
          type: 'trace-create',
          body: {
            id: runId,
            name: typeof trace.attrs.agentId === 'string' ? trace.attrs.agentId : 'run',
            timestamp: iso(trace.startedAt),
            metadata: {
              status: trace.attrs.status,
              ...(trace.attrs.code !== undefined ? { code: trace.attrs.code } : {}),
            },
          },
        },
      ]
      for (const { node, id, parentId, error } of nodes.slice(1)) {
        const common = {
          id,
          traceId: runId,
          ...(parentId && parentId !== runNodeId ? { parentObservationId: parentId } : {}),
          name: node.name,
          startTime: iso(node.startedAt),
          endTime: iso(node.startedAt + (node.durationMs ?? 0)),
        }
        if (node.kind === 'model') {
          const usage = node.attrs.usage as { input?: number; output?: number } | undefined
          events.push({
            type: 'generation-create',
            body: {
              ...common,
              ...(model ? { model } : {}),
              ...(usage ? { usage: { input: usage.input ?? 0, output: usage.output ?? 0 } } : {}),
              ...(error ? { level: 'ERROR', statusMessage: error } : {}),
            },
          })
        } else {
          events.push({
            type: 'span-create',
            body: { ...common, metadata: node.attrs, level: error ? 'ERROR' : 'DEFAULT' },
          })
        }
      }
      return events
    },
  })
}
