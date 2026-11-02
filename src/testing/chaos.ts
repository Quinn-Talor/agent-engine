// 故障注入（设计 §13 `chaos`）：包装可注入的端口——模型提供方、运行档案、MCP 连接函数、hook 执行函数，
// 按种子随机数以给定比率注入模型 5xx 与超时、MCP 断连、hook 超时、存储写失败。引擎内部不变，应用把包装后的
// 端口装进引擎。
// 超时不是立即报错，而是挂起，等调用方的计时器或取消来结束：模型调用等模型库的首 token、空闲、单次时长
// 计时器（走模型库的时钟）或取消；hook 等 `timeoutMs`（走 `clock`，默认系统时钟）或取消。

import { ModelCallError, abortError, seededRandom, systemClock } from '../api.js'
import type { HookExec, HookExecResult } from '../contracts/capability.js'
import type { McpConnect, McpConnection } from '../contracts/mcp.js'
import type { Clock } from '../contracts/common.js'
import type { ArchiveStore } from '../contracts/events.js'
import type { ModelPort, ModelProvider } from '../contracts/model.js'

export type ChaosFault =
  'model_5xx' | 'model_timeout' | 'mcp_disconnect' | 'hook_timeout' | 'archive_write'

const ALL_FAULTS: readonly ChaosFault[] = [
  'model_5xx',
  'model_timeout',
  'mcp_disconnect',
  'hook_timeout',
  'archive_write',
]

export interface Chaos {
  provider(p: ModelProvider): ModelProvider
  archive(a: ArchiveStore): ArchiveStore
  mcpConnect(c: McpConnect): McpConnect
  hookExec(e: HookExec): HookExec
  readonly injected: Array<{ fault: ChaosFault; target: string }>
}

/** 挂起直到 signal 取消，再以 AbortError 拒绝。 */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(abortError())
    signal.addEventListener('abort', () => reject(abortError()), { once: true })
  })
}

export function chaos(
  opts: { seed?: number; rate?: number; faults?: ChaosFault[]; clock?: Clock } = {},
): Chaos {
  const random = seededRandom(opts.seed ?? 1)
  const clock = opts.clock ?? systemClock()
  const rate = opts.rate ?? 0.3
  const faults = new Set(opts.faults ?? ALL_FAULTS)
  const injected: Chaos['injected'] = []
  const hit = (fault: ChaosFault, target: string) => {
    if (!faults.has(fault) || random() >= rate) return false
    injected.push({ fault, target })
    return true
  }

  const port = (p: ModelPort): ModelPort => ({
    ...p,
    async call(input, callOpts) {
      if (hit('model_5xx', p.ref)) {
        throw new ModelCallError({
          code: 'MODEL_ERROR',
          status: 503,
          retryable: true,
          message: 'chaos: 503',
          attempts: [],
        })
      }
      if (hit('model_timeout', p.ref)) {
        // 卡住的流：照常请求，第一个 delta 之后不再转发，也不交回响应；没有 delta 时就是等不到首 token。
        let stalled = false
        p.call(input, {
          signal: callOpts.signal,
          onDelta: (d) => {
            if (stalled) return
            stalled = true
            callOpts.onDelta(d)
          },
        }).catch(() => undefined)
        return untilAborted(callOpts.signal)
      }
      return p.call(input, callOpts)
    },
  })

  /** hook 超时：不执行命令，到 timeoutMs 时按超时返回；先被取消时以 AbortError 拒绝。 */
  const hookTimeout = (execOpts: { timeoutMs: number; signal?: AbortSignal }) =>
    new Promise<HookExecResult>((resolve, reject) => {
      const { signal } = execOpts
      if (signal?.aborted) return reject(abortError())
      const onAbort = () => {
        cancel()
        reject(abortError())
      }
      const cancel = clock.setTimer(execOpts.timeoutMs, () => {
        signal?.removeEventListener('abort', onAbort)
        resolve({ exitCode: null, stdout: '', stderr: '', timedOut: true })
      })
      signal?.addEventListener('abort', onAbort, { once: true })
    })

  const connection = (conn: McpConnection, server: string): McpConnection => {
    const closes: Array<() => void> = []
    conn.onClose(() => closes.forEach((fn) => fn()))
    return {
      listTools: () => conn.listTools(),
      async callTool(name, args, callOpts) {
        if (hit('mcp_disconnect', `${server}/${name}`)) {
          await conn.close()
          closes.forEach((fn) => fn())
          throw new Error('chaos: MCP 断连')
        }
        return conn.callTool(name, args, callOpts)
      },
      onToolsChanged: (fn) => conn.onToolsChanged(fn),
      onClose: (fn) => void closes.push(fn),
      close: () => conn.close(),
    }
  }

  return {
    injected,
    provider: (p) => ({
      id: p.id,
      resolve(ref) {
        const resolved = p.resolve(ref)
        return resolved ? port(resolved) : undefined
      },
    }),
    archive: (a) => ({
      async append(runId, events) {
        if (hit('archive_write', runId)) throw new Error('chaos: 存储写失败')
        return a.append(runId, events)
      },
      read: (runId, fromSeq) => a.read(runId, fromSeq),
      async putBlob(data) {
        if (hit('archive_write', 'blob')) throw new Error('chaos: 存储写失败')
        return a.putBlob(data)
      },
      getBlob: (ref) => a.getBlob(ref),
      query: (filter) => a.query(filter),
      pin: (runId, reason) => a.pin(runId, reason),
      retain: (policy) => a.retain(policy),
    }),
    mcpConnect: (c) => async (server, connectOpts) =>
      connection(await c(server, connectOpts), server.name),
    hookExec: (e) => async (command, input, execOpts) => {
      if (hit('hook_timeout', command)) return hookTimeout(execOpts)
      return e(command, input, execOpts)
    },
  }
}
