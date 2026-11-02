// 测试用 MCP 服务器（设计 §13）：脚本化的工具与结果，可以注入连接延迟、连接失败、调用延迟、工具列表变化与断连。

import { abortError, systemClock } from '../api.js'
import type {
  McpCallResult,
  McpConnect,
  McpConnection,
  McpToolInfo,
  ResolvedMcpServer,
} from '../contracts/mcp.js'
import type { Clock, JsonSchema } from '../contracts/common.js'

export interface FakeMcpTool {
  name: string
  description?: string
  inputSchema?: JsonSchema
  annotations?: McpToolInfo['annotations']
  handler?: (args: unknown) => McpCallResult | string | Promise<McpCallResult | string>
  delayMs?: number
}

export interface FakeMcpServer {
  connect: McpConnect
  readonly connects: ResolvedMcpServer[]
  readonly calls: Array<{ name: string; args: unknown }>
  /** 替换工具并通知每个活动连接。 */
  setTools(tools: FakeMcpTool[]): void
  /** 断开全部活动连接（触发 onClose）。 */
  disconnect(): void
}

interface Live {
  closed: boolean
  changed: Array<() => void>
  closes: Array<() => void>
}

function wait(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const onAbort = () => {
      cancel()
      reject(abortError())
    }
    const cancel = clock.setTimer(ms, () => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const infoOf = (t: FakeMcpTool): McpToolInfo => ({
  name: t.name,
  ...(t.description !== undefined ? { description: t.description } : {}),
  inputSchema: t.inputSchema ?? { type: 'object' },
  ...(t.annotations ? { annotations: t.annotations } : {}),
})

export function fakeMcpServer(opts: {
  tools: FakeMcpTool[]
  clock?: Clock
  connectDelayMs?: number
  failConnects?: number
}): FakeMcpServer {
  const clock = opts.clock ?? systemClock()
  let tools = opts.tools
  let failConnects = opts.failConnects ?? 0
  const connects: ResolvedMcpServer[] = []
  const calls: Array<{ name: string; args: unknown }> = []
  const lives = new Set<Live>()

  const connection = (live: Live): McpConnection => ({
    listTools: async () => tools.map(infoOf),
    async callTool(name, args, { signal }) {
      if (live.closed) throw new Error('fake mcp: closed')
      calls.push({ name, args })
      const tool = tools.find((t) => t.name === name)
      if (!tool) throw new Error(`fake mcp: unknown tool ${name}`)
      if (tool.delayMs) await wait(clock, tool.delayMs, signal)
      const out = tool.handler ? await tool.handler(args) : 'ok'
      return typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : out
    },
    onToolsChanged: (fn) => void live.changed.push(fn),
    onClose: (fn) => void live.closes.push(fn),
    async close() {
      live.closed = true
      lives.delete(live)
    },
  })

  return {
    connects,
    calls,
    async connect(server, { signal }) {
      connects.push(server)
      if (failConnects > 0) {
        failConnects -= 1
        throw new Error('fake mcp: connect failed')
      }
      if (opts.connectDelayMs) await wait(clock, opts.connectDelayMs, signal)
      const live: Live = { closed: false, changed: [], closes: [] }
      lives.add(live)
      return connection(live)
    },
    setTools(next) {
      tools = next
      for (const live of lives) for (const fn of live.changed) fn()
    },
    disconnect() {
      for (const live of [...lives]) {
        live.closed = true
        lives.delete(live)
        for (const fn of live.closes) fn()
      }
    },
  }
}
