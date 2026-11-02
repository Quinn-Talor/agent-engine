import { describe, expect, it } from 'vitest'
import type { ResolvedMcpServer } from '../contracts/mcp.js'
import { FakeClock } from './fake-clock.js'
import { fakeMcpServer } from './fake-mcp-server.js'

const server: ResolvedMcpServer = {
  name: 'crm',
  transport: { kind: 'stdio', command: 'crm-server' },
}
const signal = () => new AbortController().signal

describe('fakeMcpServer', () => {
  it('AC-001 lists scripted tools and answers calls', async () => {
    const fake = fakeMcpServer({
      tools: [
        {
          name: 'lookup',
          description: '查客户',
          annotations: { readOnlyHint: true },
          handler: (args) => `found ${JSON.stringify(args)}`,
        },
        {
          name: 'fail',
          handler: () => ({ content: [{ type: 'text', text: 'no such customer' }], isError: true }),
        },
        { name: 'plain' },
      ],
    })
    const conn = await fake.connect(server, { signal: signal() })
    expect(fake.connects).toEqual([server])
    expect(await conn.listTools()).toEqual([
      {
        name: 'lookup',
        description: '查客户',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      },
      { name: 'fail', inputSchema: { type: 'object' } },
      { name: 'plain', inputSchema: { type: 'object' } },
    ])
    const opts = { signal: signal(), timeoutMs: 1000 }
    expect(await conn.callTool('lookup', { id: 7 }, opts)).toEqual({
      content: [{ type: 'text', text: 'found {"id":7}' }],
    })
    expect(await conn.callTool('fail', {}, opts)).toMatchObject({ isError: true })
    expect(await conn.callTool('plain', {}, opts)).toEqual({
      content: [{ type: 'text', text: 'ok' }],
    })
    await expect(conn.callTool('nope', {}, opts)).rejects.toThrow('fake mcp: unknown tool nope')
    expect(fake.calls.map((c) => c.name)).toEqual(['lookup', 'fail', 'plain', 'nope'])
  })

  it('AC-001 injects connect failures and delays that can be cancelled', async () => {
    const clock = new FakeClock()
    const fake = fakeMcpServer({ tools: [], failConnects: 1, connectDelayMs: 500, clock })
    await expect(fake.connect(server, { signal: signal() })).rejects.toThrow(
      'fake mcp: connect failed',
    )
    const controller = new AbortController()
    const pending = fake.connect(server, { signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('aborted')
    controller.abort()
    await rejected
    const slow = fake.connect(server, { signal: signal() })
    await clock.tick(500)
    expect(await (await slow).listTools()).toEqual([])
  })

  it('AC-001 delays calls and lets them be cancelled', async () => {
    const clock = new FakeClock()
    const fake = fakeMcpServer({ tools: [{ name: 'slow', delayMs: 100 }], clock })
    const conn = await fake.connect(server, { signal: signal() })
    const controller = new AbortController()
    const pending = conn.callTool('slow', {}, { signal: controller.signal, timeoutMs: 1000 })
    const rejected = expect(pending).rejects.toThrow('aborted')
    controller.abort()
    await rejected
    const ok = conn.callTool('slow', {}, { signal: signal(), timeoutMs: 1000 })
    await clock.tick(100)
    expect(await ok).toEqual({ content: [{ type: 'text', text: 'ok' }] })
  })

  it('AC-002 notifies tool list changes and disconnects', async () => {
    const fake = fakeMcpServer({ tools: [{ name: 'a' }] })
    const conn = await fake.connect(server, { signal: signal() })
    const events: string[] = []
    conn.onToolsChanged(() => events.push('changed'))
    conn.onClose(() => events.push('closed'))
    fake.setTools([{ name: 'a' }, { name: 'b' }])
    expect((await conn.listTools()).map((t) => t.name)).toEqual(['a', 'b'])
    fake.disconnect()
    expect(events).toEqual(['changed', 'closed'])
    await expect(conn.callTool('a', {}, { signal: signal(), timeoutMs: 1 })).rejects.toThrow(
      'fake mcp: closed',
    )
  })

  it('closes without reporting a disconnect', async () => {
    const fake = fakeMcpServer({ tools: [] })
    const conn = await fake.connect(server, { signal: signal() })
    let closed = false
    conn.onClose(() => (closed = true))
    await conn.close()
    fake.disconnect()
    expect(closed).toBe(false)
  })
})
