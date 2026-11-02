// 导出器共用（设计 §6.6、方案 D7）：订阅运行的事件，按运行分别缓存，run_ended 时由 trace 投影得到节点树，
// 按节点路径生成稳定的 id；发起子运行的工具节点的 id 由子运行 id 得出，子运行的根节点据此挂到它下面。
// 发送函数由应用注入，失败只写诊断日志。

import { buildTrace, sha256Hex } from '../../sdk.js'
import type { Logger, RunEvent, RunSubscriber, TraceNode } from '../../sdk.js'

export interface ExportNode {
  node: TraceNode
  id: string
  parentId?: string
  /** 出错时的说明（错误码、错误或运行的结局 code）。 */
  error?: string
}

/** 发起子运行的工具节点的 id：父运行导出工具节点、子运行导出根节点时都能算出同一个值。 */
export const delegateNodeId = (childRunId: string): string =>
  sha256Hex(`${childRunId}/delegate`).slice(0, 16)

/**
 * 先序遍历：路径为每层的 `${kind}:${name}:${同级序号}` 用 '/' 连接；id 取 sha256(runId/路径) 的前 16 位，
 * 发起子运行的工具节点取 delegateNodeId(子运行 id)。`parentId` 是根节点的父节点（子运行挂到委托工具下）。
 */
export function walk(
  trace: TraceNode,
  runId: string,
  opts: { parentId?: string } = {},
): ExportNode[] {
  const out: ExportNode[] = []
  const visit = (node: TraceNode, path: string, parentId?: string) => {
    const childRunId = node.kind === 'tool' ? node.attrs.childRunId : undefined
    const id =
      typeof childRunId === 'string'
        ? delegateNodeId(childRunId)
        : sha256Hex(`${runId}/${path}`).slice(0, 16)
    const failedRun = node.kind === 'run' && node.attrs.status === 'failed'
    const error =
      node.attrs.isError === true
        ? String(node.attrs.errorCode ?? 'error')
        : node.attrs.error !== undefined
          ? String(node.attrs.error)
          : failedRun
            ? String(node.attrs.code ?? 'failed')
            : undefined
    out.push({ node, id, ...(parentId ? { parentId } : {}), ...(error ? { error } : {}) })
    node.children.forEach((child, i) =>
      visit(child, `${path}/${child.kind}:${child.name}:${i}`, id),
    )
  }
  visit(trace, `${trace.kind}:${trace.name}:0`, opts.parentId)
  return out
}

export interface ExportSubscriber extends RunSubscriber {
  /**
   * 给出 `run` 时按运行分别缓存，同一个订阅者可以同时订阅多次运行；不给时所有事件进同一个缓存，
   * 只能一次订阅一次运行（运行事件本身不带 runId）。
   */
  onEvent(e: RunEvent, run?: { runId: string }): Promise<void>
}

/** 按运行缓存事件，run_ended 时转换并发送一次。 */
export function exportOnEnd<T>(opts: {
  transform(trace: TraceNode, runId: string, events: readonly RunEvent[]): T
  send(payload: T): void | Promise<void>
  logger?: Logger
}): ExportSubscriber {
  const buffers = new Map<string, RunEvent[]>()
  return {
    async onEvent(e, run) {
      const key = run?.runId ?? ''
      const buffer = buffers.get(key) ?? []
      buffers.set(key, buffer)
      buffer.push(e)
      if (e.t !== 'run_ended') return
      buffers.delete(key)
      const events = buffer
      const runId = e.result.runId
      try {
        await opts.send(opts.transform(buildTrace(events)!, runId, events))
      } catch (error) {
        opts.logger?.log({
          level: 'warn',
          message: '观测导出失败',
          runId,
          detail: { error: String(error) },
        })
      }
    },
  }
}
