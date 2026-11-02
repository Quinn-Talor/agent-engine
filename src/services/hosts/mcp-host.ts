// MCP 连接池（设计 §8.3、§5.2）：按服务器规格的指纹复用连接；连接等待有上限；按服务器规格的指纹熔断，只统计
// 依赖本身的故障（连接失败、超时、断连、传输错误），服务器返回的 JSON-RPC 错误与输出 schema 校验错误不计入；
// 每次获取都经调用方的凭据库解析凭据（运行的脱敏器由此记下凭据值），解析值与池中连接不同就换新连接，
// 旧连接等进行中的调用结束再关闭；只预连接应用给出的列表；工具列表变化时更新版本。
// 连接通过端口 McpConnect 建立，stdio / HTTP 适配器由包入口装配（方案 D10）。

import type { CapabilityHost } from '../../contracts/capability.js'
import type {
  McpCallResult,
  McpConnect,
  McpConnection,
  McpServerSpec,
  McpToolInfo,
  ResolvedMcpServer,
} from '../../contracts/mcp.js'
import type { Clock, SecretRef, SecretResolver } from '../../contracts/common.js'
import type { BreakerStatus } from '../../contracts/engine.js'
import type { BreakerPolicy } from '../../contracts/model.js'
import { hashOf } from '../../core/definition/hash.js'
import { createBreaker, type Breaker, type BreakerTicket } from '../breaker.js'
import { systemClock } from '../clock.js'

const DEFAULT_CONNECT_TIMEOUT_MS = 3000
// MCP（JSON-RPC）错误码：断连与请求超时是依赖故障。
const CONNECTION_CLOSED = -32000
const REQUEST_TIMEOUT = -32001

export interface McpLease {
  tools: McpToolInfo[]
  version: number
  call(
    name: string,
    args: unknown,
    opts: { signal: AbortSignal; timeoutMs: number },
  ): Promise<McpCallResult>
  /** 熔断没有打开。 */
  available(): boolean
  /** 归还租约；连接留在池中复用。 */
  release(): void
}

export interface McpHost extends CapabilityHost {
  readonly kind: 'mcp'
  acquire(
    spec: McpServerSpec,
    opts: { vault: SecretResolver; signal: AbortSignal },
  ): Promise<McpLease>
  health(): BreakerStatus[]
  onHealth(fn: (status: BreakerStatus) => void): () => void
  shutdown(): Promise<void>
}

interface Live {
  conn: McpConnection
  tools: McpToolInfo[]
  version: number
  /** 建连所用凭据值的指纹。 */
  secrets: string
  /** 进行中的调用数：退役的连接等它归零再关闭。 */
  calls: number
  retired: boolean
  closed: boolean
}

/** 一次获取解析出的服务器规格。 */
interface Target {
  server: ResolvedMcpServer
  secrets: string
}

interface Entry {
  spec: McpServerSpec
  breaker: Breaker
  live?: Live
  connecting?: { secrets: string; promise: Promise<Live> }
}

const isSecret = (v: string | SecretRef): v is SecretRef => typeof v !== 'string'

const acquireCancelled = () => new Error('MCP 取连接已取消')

/** 等待与取消竞速（设计 §3.1）：取消时本次等待立即失败，被等待的操作（共享的建连）照常进行。 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(acquireCancelled())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(acquireCancelled())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** 凭据库只解析引用名；带模板时由这里把 `${<secret>}` 换成凭据值。 */
async function resolveSecret(ref: SecretRef, vault: SecretResolver): Promise<string> {
  const value = await vault.resolve({ secret: ref.secret })
  return ref.template === undefined ? value : ref.template.split(`\${${ref.secret}}`).join(value)
}

async function resolveRecord(
  record: Record<string, string | SecretRef> | undefined,
  vault: SecretResolver,
): Promise<Record<string, string> | undefined> {
  if (!record) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    out[key] = isSecret(value) ? await resolveSecret(value, vault) : value
  }
  return out
}

async function resolveServer(
  spec: McpServerSpec,
  vault: SecretResolver,
): Promise<ResolvedMcpServer> {
  const t = spec.transport
  if (t.kind === 'stdio') {
    const env = await resolveRecord(t.env, vault)
    const args = t.args
      ? await Promise.all(t.args.map((a) => (isSecret(a) ? resolveSecret(a, vault) : a)))
      : undefined
    return {
      name: spec.name,
      transport: {
        kind: 'stdio',
        command: t.command,
        ...(args ? { args } : {}),
        ...(env ? { env } : {}),
        ...(t.cwd ? { cwd: t.cwd } : {}),
      },
    }
  }
  const headers = await resolveRecord(t.headers, vault)
  return {
    name: spec.name,
    transport: { kind: 'http', url: t.url, ...(headers ? { headers } : {}) },
  }
}

/**
 * 只有依赖本身的故障计入熔断（设计 §5.2）：超时、断连、传输错误。服务器返回的 JSON-RPC 错误（参数错误、
 * 业务错误）与客户端的输出 schema 校验错误（官方 SDK 都以带数字错误码的 McpError 抛出）不计入。
 */
function isDependencyFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  if (!(error instanceof Error) || error.name !== 'McpError' || typeof code !== 'number')
    return true
  return code === CONNECTION_CLOSED || code === REQUEST_TIMEOUT
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createMcpHost(opts: {
  connect: McpConnect
  breaker?: BreakerPolicy
  preconnect?: McpServerSpec[]
  vault?: SecretResolver
  clock?: Clock
}): McpHost {
  const clock = opts.clock ?? systemClock()
  const pool = new Map<string, Entry>()
  const listeners = new Set<(status: BreakerStatus) => void>()
  /** 所有没关闭的连接，含等调用结束的退役连接；关闭连接池时一并关闭。 */
  const lives = new Set<Live>()
  let closing = false

  const closeLive = async (live: Live) => {
    if (live.closed) return
    live.closed = true
    lives.delete(live)
    await live.conn.close().catch(() => undefined)
  }

  /** 换下的连接：没有进行中的调用就关闭，否则等最后一个调用结束。 */
  const retire = (live: Live | undefined) => {
    if (!live) return
    live.retired = true
    if (live.calls === 0) void closeLive(live)
  }

  const dropLive = (entry: Entry) => {
    const live = entry.live
    if (!live) return
    entry.live = undefined
    void closeLive(live)
  }

  const entryOf = (spec: McpServerSpec): Entry => {
    const fingerprint = hashOf(spec)
    let entry = pool.get(fingerprint)
    if (!entry) {
      const created: Entry = {
        spec,
        breaker: createBreaker({
          // 按服务器规格的指纹熔断；名字留在键里方便辨认。
          key: `mcp:${spec.name}@${fingerprint.slice(0, 12)}`,
          dependency: 'mcp',
          ...(opts.breaker ? { policy: opts.breaker } : {}),
          clock,
          onChange: (status) => {
            // 熔断打开时放弃现有连接，冷却后由半开探测重新连接。
            if (status.state === 'open') dropLive(created)
            for (const fn of listeners) fn(status)
          },
        }),
      }
      entry = created
      pool.set(fingerprint, entry)
    }
    return entry
  }

  /** 在连接等待上限内完成连接与列工具；超时则取消。连接建好却没能用上（列工具失败或超时）时关闭它。 */
  const open = async (entry: Entry, target: Target, ticket: BreakerTicket): Promise<Live> => {
    const { spec } = entry
    const controller = new AbortController()
    let cancelTimer = () => {}
    const timeout = new Promise<never>((_, reject) => {
      cancelTimer = clock.setTimer(spec.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, () => {
        controller.abort()
        reject(new Error('连接超时'))
      })
    })
    const connected = opts.connect(target.server, { signal: controller.signal })
    const attempt = connected.then(async (conn) => ({ conn, tools: await conn.listTools() }))
    try {
      const { conn, tools } = await Promise.race([attempt, timeout])
      const live: Live = {
        conn,
        tools,
        version: 1,
        secrets: target.secrets,
        calls: 0,
        retired: false,
        closed: false,
      }
      lives.add(live)
      conn.onToolsChanged(() => {
        conn.listTools().then(
          (next) => {
            live.tools = next
            live.version += 1
          },
          () => undefined,
        )
      })
      conn.onClose(() => {
        if (closing || live.closed) return
        live.closed = true
        lives.delete(live)
        entry.breaker.onFailure()
        if (entry.live === live) entry.live = undefined
      })
      ticket.onSuccess()
      return live
    } catch (error) {
      connected.then(
        (late) => late.close().catch(() => undefined),
        () => undefined,
      )
      ticket.onFailure()
      throw new Error(`MCP 服务器 ${spec.name} 连接失败：${messageOf(error)}`, { cause: error })
    } finally {
      cancelTimer()
    }
  }

  /**
   * 取池中的连接。获取（exact）要求连接用的是这次解析出的凭据值：不同就按这次的值建新连接，旧连接退役；
   * 调用沿用池中现有的连接，没有时按租约解析的值重连。
   */
  const liveOf = async (entry: Entry, target: Target, exact: boolean): Promise<Live> => {
    for (;;) {
      if (closing) throw new Error('MCP 连接池已关闭')
      const live = entry.live
      if (live && (!exact || live.secrets === target.secrets)) return live
      const pending = entry.connecting
      if (pending && (!exact || pending.secrets === target.secrets)) return pending.promise
      if (pending) {
        await pending.promise.catch(() => undefined)
        continue
      }
      const ticket = entry.breaker.admit()
      if (!ticket) throw new Error(`MCP 服务器 ${entry.spec.name} 熔断中`)
      const promise: Promise<Live> = open(entry, target, ticket)
        .then(async (next) => {
          // 连接池在建连期间关闭：建好的连接立即关闭。
          if (closing) {
            await closeLive(next)
            throw new Error('MCP 连接池已关闭')
          }
          retire(entry.live)
          entry.live = next
          return next
        })
        .finally(() => {
          if (entry.connecting?.promise === promise) entry.connecting = undefined
        })
      entry.connecting = { secrets: target.secrets, promise }
      return promise
    }
  }

  const host: McpHost = {
    kind: 'mcp',
    async acquire(spec, { vault, signal }) {
      if (closing) throw new Error('MCP 连接池已关闭')
      if (signal.aborted) throw acquireCancelled()
      const entry = entryOf(spec)
      if (entry.breaker.cooling()) throw new Error(`MCP 服务器 ${spec.name} 熔断中`)
      // 每次获取都经调用方的凭据库解析，运行的脱敏器由此记下凭据值。
      const server = await untilAborted(resolveServer(spec, vault), signal)
      const target: Target = { server, secrets: hashOf(server) }
      const live = await untilAborted(liveOf(entry, target, true), signal)
      return {
        tools: live.tools,
        version: live.version,
        async call(name, args, callOpts) {
          const current = await liveOf(entry, target, false)
          const ticket = entry.breaker.admit()
          if (!ticket) throw new Error(`MCP 服务器 ${spec.name} 熔断中`)
          current.calls += 1
          try {
            const result = await current.conn.callTool(name, args, callOpts)
            ticket.onSuccess()
            return result
          } catch (error) {
            if (callOpts.signal.aborted) ticket.release()
            else if (isDependencyFailure(error)) ticket.onFailure()
            else ticket.onSuccess()
            throw error
          } finally {
            current.calls -= 1
            if (current.retired && current.calls === 0) void closeLive(current)
          }
        },
        available: () => !entry.breaker.cooling(),
        // 连接按规格指纹留在池中供后续运行复用，归还不需要关闭任何东西。
        release: () => undefined,
      }
    },
    health: () => [...pool.values()].map((e) => e.breaker.status()),
    onHealth(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    async shutdown() {
      closing = true
      const entries = [...pool.values()]
      pool.clear()
      // 正在建立的连接建好后立即关闭（见 liveOf），这里等它们落定。
      await Promise.all(entries.map((e) => e.connecting?.promise.catch(() => undefined)))
      await Promise.all([...lives].map(closeLive))
    },
  }

  const preconnectVault: SecretResolver = opts.vault ?? {
    resolve: async () => {
      throw new Error('没有配置凭据库')
    },
  }
  for (const spec of opts.preconnect ?? []) {
    host.acquire(spec, { vault: preconnectVault, signal: new AbortController().signal }).then(
      (lease) => lease.release(),
      () => undefined,
    )
  }
  return host
}
