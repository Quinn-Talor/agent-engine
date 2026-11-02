import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import type { McpConnection, McpServerSpec } from '../../contracts/capability.js'
import type { SecretRef } from '../../contracts/common.js'
import type { BreakerStatus } from '../../contracts/engine.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { fakeMcpServer, type FakeMcpTool } from '../../testing/fake-mcp-server.js'
import { createMcpHost } from './mcp-host.js'

const spec = (patch: Partial<McpServerSpec> = {}): McpServerSpec => ({
  name: 'crm',
  transport: { kind: 'stdio', command: 'crm-server', env: { API_KEY: { secret: 'crm-key' } } },
  ...patch,
})
const vault = { resolve: async (ref: { secret: string }) => `value-of-${ref.secret}` }
const signal = () => new AbortController().signal
const opts = () => ({ vault, signal: signal() })
const callOpts = () => ({ signal: signal(), timeoutMs: 1000 })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const KEY = /^mcp:crm@[0-9a-f]{12}$/

/** 手写的连接：按需替换 listTools / callTool，记录关闭次数。 */
function handmade(patch: Partial<McpConnection> = {}) {
  const state = { closed: 0 }
  const conn: McpConnection = {
    listTools: async () => [{ name: 'lookup', inputSchema: { type: 'object' } }],
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    onToolsChanged: () => undefined,
    onClose: () => undefined,
    close: async () => void (state.closed += 1),
    ...patch,
  }
  return { conn, state }
}

function setup(
  fakeOpts: { tools?: FakeMcpTool[]; failConnects?: number; connectDelayMs?: number } = {},
  hostOpts: Partial<Parameters<typeof createMcpHost>[0]> = {},
) {
  const clock = new FakeClock()
  const fake = fakeMcpServer({ tools: fakeOpts.tools ?? [{ name: 'lookup' }], clock, ...fakeOpts })
  const host = createMcpHost({ connect: fake.connect, clock, ...hostOpts })
  return { clock, fake, host }
}

describe('createMcpHost', () => {
  it('F19 AC-015 gives up waiting for a connection when the caller is cancelled', async () => {
    const { clock, fake, host } = setup({ connectDelayMs: 1000 })
    const controller = new AbortController()
    const waiting = host.acquire(spec(), { vault, signal: controller.signal })
    await flush()
    controller.abort()
    await expect(waiting).rejects.toThrow('MCP 取连接已取消')

    // 共享的建连照常完成，其他调用方可以用。
    const other = host.acquire(spec(), opts())
    await clock.tick(1000)
    const lease = await other
    expect(lease.tools.map((t) => t.name)).toEqual(['lookup'])
    expect(fake.connects).toHaveLength(1)
  })

  it('F19 AC-015 fails at once when the caller is already cancelled', async () => {
    const { fake, host } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(host.acquire(spec(), { vault, signal: controller.signal })).rejects.toThrow(
      'MCP 取连接已取消',
    )
    expect(fake.connects).toHaveLength(0)
  })

  it('AC-003 reuses one connection per spec fingerprint', async () => {
    const { host, fake } = setup()
    expect(host.kind).toBe('mcp')
    const [a, b] = await Promise.all([host.acquire(spec(), opts()), host.acquire(spec(), opts())])
    const c = await host.acquire(spec(), opts())
    expect(fake.connects).toHaveLength(1)
    expect(a.tools).toEqual([{ name: 'lookup', inputSchema: { type: 'object' } }])
    expect([a.version, b.version, c.version]).toEqual([1, 1, 1])
    a.release()
    a.release()
    await host.acquire(spec({ name: 'other' }), opts())
    expect(fake.connects).toHaveLength(2)
  })

  it('AC-010 resolves secret references before connecting', async () => {
    const { host, fake } = setup()
    await host.acquire(
      spec({
        transport: {
          kind: 'http',
          url: 'https://crm',
          headers: { Authorization: { secret: 'tok' }, 'X-Plain': 'p' },
        },
      }),
      opts(),
    )
    await host.acquire(spec(), opts())
    expect(fake.connects.map((s) => s.transport)).toEqual([
      {
        kind: 'http',
        url: 'https://crm',
        headers: { Authorization: 'value-of-tok', 'X-Plain': 'p' },
      },
      { kind: 'stdio', command: 'crm-server', env: { API_KEY: 'value-of-crm-key' } },
    ])
  })

  it('AC-004 gives up after the connect timeout', async () => {
    const { host, clock } = setup({ connectDelayMs: 5000 })
    const pending = host.acquire(spec(), opts())
    const rejected = expect(pending).rejects.toThrow('MCP 服务器 crm 连接失败：连接超时')
    await clock.tick(3000)
    await rejected
    const custom = host.acquire(spec({ name: 'slow', connectTimeoutMs: 6000 }), opts())
    await clock.tick(5000)
    expect((await custom).version).toBe(1)
  })

  it('AC-005 opens the breaker after 5 connect failures and probes after the cooldown', async () => {
    const { host, fake, clock } = setup({ failConnects: 5 })
    for (let i = 0; i < 5; i++)
      await expect(host.acquire(spec(), opts())).rejects.toThrow('连接失败')
    await expect(host.acquire(spec(), opts())).rejects.toThrow('MCP 服务器 crm 熔断中')
    expect(fake.connects).toHaveLength(5)
    expect(host.health()).toEqual([
      expect.objectContaining({
        key: expect.stringMatching(KEY),
        dependency: 'mcp',
        state: 'open',
      }),
    ])
    await clock.tick(30_000)
    expect((await host.acquire(spec(), opts())).version).toBe(1)
    expect(host.health()[0]!.state).toBe('closed')
  })

  it('AC-006 counts transport failures but not tool errors', async () => {
    const { host } = setup(
      {
        tools: [
          { name: 'broken', handler: () => Promise.reject(new Error('socket hang up')) },
          {
            name: 'denied',
            handler: () => ({ content: [{ type: 'text', text: 'no' }], isError: true }),
          },
        ],
      },
      { breaker: { failureThreshold: 1 } },
    )
    const lease = await host.acquire(spec(), opts())
    expect(await lease.call('denied', {}, callOpts())).toMatchObject({ isError: true })
    expect(lease.available()).toBe(true)
    await expect(lease.call('broken', {}, callOpts())).rejects.toThrow('socket hang up')
    expect(lease.available()).toBe(false)
  })

  it('AC-006 does not count cancelled calls', async () => {
    const { host } = setup(
      { tools: [{ name: 'slow', delayMs: 100 }] },
      { breaker: { failureThreshold: 1 } },
    )
    const lease = await host.acquire(spec(), opts())
    const controller = new AbortController()
    const pending = lease.call('slow', {}, { signal: controller.signal, timeoutMs: 1000 })
    const rejected = expect(pending).rejects.toThrow('aborted')
    controller.abort()
    await rejected
    expect(lease.available()).toBe(true)
  })

  it('AC-007 reconnects after a disconnect and counts it as a failure', async () => {
    const seen: BreakerStatus[] = []
    const { host, fake } = setup({}, { breaker: { failureThreshold: 2 } })
    host.onHealth((s) => seen.push(s))
    const lease = await host.acquire(spec(), opts())
    fake.disconnect()
    expect(await lease.call('lookup', {}, callOpts())).toEqual({
      content: [{ type: 'text', text: 'ok' }],
    })
    expect(fake.connects).toHaveLength(2)
    fake.disconnect()
    fake.disconnect()
    expect(seen).toEqual([])
  })

  it('AC-008 refreshes the tool list and bumps the version', async () => {
    const { host, fake } = setup()
    await host.acquire(spec(), opts())
    fake.setTools([{ name: 'lookup' }, { name: 'update' }])
    await new Promise((resolve) => setTimeout(resolve, 0))
    const lease = await host.acquire(spec(), opts())
    expect(lease.version).toBe(2)
    expect(lease.tools.map((t) => t.name)).toEqual(['lookup', 'update'])
  })

  it('AC-009 notifies health changes and preconnects the given servers', async () => {
    const { host } = setup({ failConnects: 1 }, { breaker: { failureThreshold: 1 } })
    const seen: BreakerStatus[] = []
    const off = host.onHealth((s) => seen.push(s))
    await expect(host.acquire(spec(), opts())).rejects.toThrow()
    expect(seen).toEqual([
      expect.objectContaining({
        key: expect.stringMatching(KEY),
        dependency: 'mcp',
        state: 'open',
      }),
    ])
    off()

    const pre = setup({}, { preconnect: [spec()], vault })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pre.fake.connects).toHaveLength(1)
    await pre.host.acquire(spec(), opts())
    expect(pre.fake.connects).toHaveLength(1)
  })

  it('AC-010 closes connections on shutdown without counting failures', async () => {
    const { host, fake } = setup({}, { breaker: { failureThreshold: 1 } })
    const lease = await host.acquire(spec(), opts())
    await host.shutdown()
    fake.disconnect()
    expect(lease.available()).toBe(true)
    await expect(host.acquire(spec(), opts())).rejects.toThrow('MCP 连接池已关闭')
  })

  it('AC-004 closes the connection when listing tools fails or hangs', async () => {
    const clock = new FakeClock()
    const failing = handmade({ listTools: () => Promise.reject(new Error('list failed')) })
    const host = createMcpHost({ clock, connect: async () => failing.conn })
    await expect(host.acquire(spec(), opts())).rejects.toThrow('连接失败：list failed')
    await flush()
    expect(failing.state.closed).toBe(1)

    const hanging = handmade({ listTools: () => new Promise(() => undefined) })
    const slow = createMcpHost({ clock, connect: async () => hanging.conn })
    const pending = slow.acquire(spec(), opts())
    const rejected = expect(pending).rejects.toThrow('连接超时')
    await clock.tick(3000)
    await rejected
    await flush()
    expect(hanging.state.closed).toBe(1)
  })

  it('AC-006 counts only dependency failures of a call', async () => {
    let error: unknown
    const { conn } = handmade({
      callTool: () => Promise.reject(error),
    })
    const host = createMcpHost({
      clock: new FakeClock(),
      connect: async () => conn,
      breaker: { failureThreshold: 1 },
    })
    const lease = await host.acquire(spec(), opts())
    // 服务器返回的 JSON-RPC 错误与客户端的输出 schema 校验错误不计入熔断。
    for (const e of [
      new McpError(ErrorCode.InvalidParams, 'bad args from model'),
      new McpError(
        ErrorCode.InvalidParams,
        "Structured content does not match the tool's output schema",
      ),
      new McpError(ErrorCode.InternalError, 'business rule failed'),
      new McpError(-1, 'custom server error'),
    ]) {
      error = e
      await expect(lease.call('lookup', {}, callOpts())).rejects.toBe(e)
      expect(lease.available()).toBe(true)
    }
    error = new McpError(ErrorCode.RequestTimeout, 'Request timed out')
    await expect(lease.call('lookup', {}, callOpts())).rejects.toBe(error)
    expect(lease.available()).toBe(false)
  })

  it('AC-006 counts a closed connection as a dependency failure', async () => {
    const { conn } = handmade({
      callTool: () => Promise.reject(new McpError(ErrorCode.ConnectionClosed, 'Connection closed')),
    })
    const host = createMcpHost({
      clock: new FakeClock(),
      connect: async () => conn,
      breaker: { failureThreshold: 1 },
    })
    const lease = await host.acquire(spec(), opts())
    await expect(lease.call('lookup', {}, callOpts())).rejects.toThrow('Connection closed')
    expect(lease.available()).toBe(false)
  })

  it('AC-010 resolves secrets through every caller vault and reconnects when they change', async () => {
    const { host, fake } = setup()
    const resolved: string[] = []
    const vaultOf = (run: string, value: string) => ({
      resolve: async (ref: SecretRef) => {
        resolved.push(`${run}:${ref.secret}`)
        return value
      },
    })
    const a = await host.acquire(spec(), { vault: vaultOf('a', 'k1'), signal: signal() })
    await host.acquire(spec(), { vault: vaultOf('b', 'k1'), signal: signal() })
    expect(resolved).toEqual(['a:crm-key', 'b:crm-key'])
    expect(fake.connects).toHaveLength(1)

    const c = await host.acquire(spec(), { vault: vaultOf('c', 'k2'), signal: signal() })
    expect(fake.connects.map((s) => s.transport)).toEqual([
      { kind: 'stdio', command: 'crm-server', env: { API_KEY: 'k1' } },
      { kind: 'stdio', command: 'crm-server', env: { API_KEY: 'k2' } },
    ])
    expect(await a.call('lookup', {}, callOpts())).toEqual({
      content: [{ type: 'text', text: 'ok' }],
    })
    expect(await c.call('lookup', {}, callOpts())).toEqual({
      content: [{ type: 'text', text: 'ok' }],
    })
    expect(fake.connects).toHaveLength(2)
    // 旧连接已退役关闭：断开只影响新连接。
    expect(host.health()[0]!.state).toBe('closed')
  })

  it('AC-010 retires the old connection only after its running calls finish', async () => {
    const clock = new FakeClock()
    const first = handmade({
      callTool: () =>
        new Promise((resolve) =>
          clock.setTimer(100, () => resolve({ content: [{ type: 'text', text: 'slow' }] })),
        ),
    })
    const second = handmade()
    const conns = [first.conn, second.conn]
    const host = createMcpHost({ clock, connect: async () => conns.shift()! })
    const keyed = (value: string) => ({ vault: { resolve: async () => value }, signal: signal() })
    const a = await host.acquire(spec(), keyed('k1'))
    const running = a.call('lookup', {}, callOpts())
    await flush()
    await host.acquire(spec(), keyed('k2'))
    expect(first.state.closed).toBe(0)
    await clock.tick(100)
    expect(await running).toEqual({ content: [{ type: 'text', text: 'slow' }] })
    expect(first.state.closed).toBe(1)
    expect(second.state.closed).toBe(0)
  })

  it('AC-010 fills secret templates', async () => {
    const { host, fake } = setup()
    await host.acquire(
      spec({
        transport: {
          kind: 'http',
          url: 'https://crm',
          headers: { Authorization: { secret: 'tok', template: 'Bearer ${tok}' } },
        },
      }),
      opts(),
    )
    expect(fake.connects[0]!.transport).toEqual({
      kind: 'http',
      url: 'https://crm',
      headers: { Authorization: 'Bearer value-of-tok' },
    })
  })

  it('AC-010 resolves secret references in stdio args', async () => {
    const { host, fake } = setup()
    await host.acquire(
      spec({
        transport: {
          kind: 'stdio',
          command: 'crm-server',
          args: ['--key', { secret: 'tok' }, { secret: 'tok', template: '--auth=${tok}' }],
        },
      }),
      opts(),
    )
    expect(fake.connects[0]!.transport).toMatchObject({
      args: ['--key', 'value-of-tok', '--auth=value-of-tok'],
    })
  })

  it('AC-010 closes connections still opening at shutdown', async () => {
    const { host, fake, clock } = setup({ connectDelayMs: 1000 })
    const closed: string[] = []
    const connect = fake.connect
    const tracked = createMcpHost({
      clock,
      connect: async (server, o) => {
        const conn = await connect(server, o)
        return { ...conn, close: async () => void closed.push(server.name) }
      },
    })
    const pending = tracked.acquire(spec(), opts())
    const rejected = expect(pending).rejects.toThrow('MCP 连接池已关闭')
    await flush()
    expect(fake.connects).toHaveLength(1)
    const done = tracked.shutdown()
    await clock.tick(1000)
    await done
    await rejected
    expect(closed).toEqual(['crm'])
    await host.shutdown()
  })

  it('keys health by the spec fingerprint and keeps the name for display', async () => {
    const { host } = setup()
    await host.acquire(spec(), opts())
    await host.acquire(
      spec({ transport: { kind: 'stdio', command: 'crm-server', args: ['--v2'] } }),
      opts(),
    )
    const keys = host.health().map((s) => s.key)
    expect(keys).toEqual([expect.stringMatching(KEY), expect.stringMatching(KEY)])
    expect(new Set(keys).size).toBe(2)
  })

  it('refuses preconnect secrets without a vault', async () => {
    const pre = setup({}, { preconnect: [spec()] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pre.fake.connects).toHaveLength(0)
  })
})
