// 包入口的 mcpHost 第一次连接时才加载 MCP 适配器（MCP SDK 是可选 peer 依赖）：经真实的 stdio 服务器走通一次。

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mcpHost } from '../../../src/index.js'

const fixture = fileURLToPath(
  new URL('../../../src/adapters/mcp-stdio/echo-server.fixture.ts', import.meta.url),
)

describe('mcpHost from the package entry', () => {
  it('loads the stdio adapter on first connect and talks to a real server', async () => {
    const host = mcpHost({})
    const signal = new AbortController().signal
    try {
      const lease = await host.acquire(
        { name: 'echo', transport: { kind: 'stdio', command: process.execPath, args: [fixture] } },
        { vault: { resolve: async () => '' }, signal },
      )
      expect(lease.tools.map((t) => t.name)).toEqual(['echo', 'grow'])
      expect(await lease.call('echo', { text: '你好' }, { signal, timeoutMs: 10_000 })).toEqual({
        content: [{ type: 'text', text: '你好' }],
      })
      lease.release()
    } finally {
      await host.shutdown()
    }
  })
})
