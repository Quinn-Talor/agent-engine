import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { McpConnection, ResolvedMcpServer } from '../../sdk.js'
import { stdioConnect } from './mcp-stdio.js'

const fixture = fileURLToPath(new URL('./echo-server.fixture.ts', import.meta.url))
const server: ResolvedMcpServer = {
  name: 'echo',
  transport: {
    kind: 'stdio',
    command: process.execPath,
    args: [fixture],
    env: { ECHO_MODE: 'test' },
  },
}
const opts = () => ({ signal: new AbortController().signal, timeoutMs: 10_000 })

describe('stdioConnect', () => {
  it('AC-018 lists tools, calls them, hears list changes and closes', async () => {
    const conn: McpConnection = await stdioConnect(server, { signal: new AbortController().signal })
    try {
      expect(await conn.listTools()).toEqual([
        {
          name: 'echo',
          description: 'echo the text back',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
          annotations: { readOnlyHint: true },
        },
        { name: 'grow', description: 'add a tool', inputSchema: { type: 'object' } },
      ])
      expect(await conn.callTool('echo', { text: '你好' }, opts())).toEqual({
        content: [{ type: 'text', text: '你好' }],
      })
      expect(await conn.callTool('nope', {}, opts())).toEqual({
        content: [{ type: 'text', text: 'unknown nope' }],
        isError: true,
      })
      const changed = vi.fn()
      conn.onToolsChanged(changed)
      await conn.callTool('grow', {}, opts())
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
      expect((await conn.listTools()).map((t) => t.name)).toEqual(['echo', 'grow', 'extra2'])
    } finally {
      const closed = vi.fn()
      conn.onClose(closed)
      await conn.close()
      expect(closed).not.toHaveBeenCalled()
    }
  }, 20_000)

  it('rejects a cancelled call and closes quietly', async () => {
    const conn = await stdioConnect(
      { name: 'short', transport: { kind: 'stdio', command: process.execPath, args: [fixture] } },
      { signal: new AbortController().signal },
    )
    const closed = vi.fn()
    conn.onClose(closed)
    await expect(
      conn.callTool('echo', { text: 'x' }, { signal: AbortSignal.abort(), timeoutMs: 1000 }),
    ).rejects.toThrow()
    await conn.close()
    expect(closed).not.toHaveBeenCalled()
  }, 20_000)

  it('rejects other transports and failed starts', async () => {
    await expect(
      stdioConnect(
        { name: 'x', transport: { kind: 'http', url: 'http://localhost' } },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('stdio 适配器不支持 http 传输')
    await expect(
      stdioConnect(
        { name: 'missing', transport: { kind: 'stdio', command: '/nonexistent/agent-engine-mcp' } },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow()
  }, 20_000)
})
