import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { explainMissingSdk, mcpConnect } from './mcp-connect.js'

const signal = () => new AbortController().signal
let http: HttpServer
let url: string

beforeAll(async () => {
  http = createServer(async (req, res) => {
    const server = new Server({ name: 'crm', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
    }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`
})

afterAll(() => new Promise<void>((resolve) => http.close(() => resolve())))

describe('mcpConnect', () => {
  it('loads the stdio adapter for a stdio server', async () => {
    const fixture = fileURLToPath(new URL('./mcp-stdio/echo-server.fixture.ts', import.meta.url))
    const conn = await mcpConnect(
      { name: 'echo', transport: { kind: 'stdio', command: process.execPath, args: [fixture] } },
      { signal: signal() },
    )
    try {
      expect((await conn.listTools()).map((t) => t.name)).toEqual(['echo', 'grow'])
    } finally {
      await conn.close()
    }
  })

  it('loads the Streamable HTTP adapter for an HTTP server', async () => {
    const conn = await mcpConnect(
      { name: 'crm', transport: { kind: 'http', url } },
      { signal: signal() },
    )
    try {
      expect((await conn.listTools()).map((t) => t.name)).toEqual(['lookup'])
    } finally {
      await conn.close()
    }
  })
})

describe('explainMissingSdk', () => {
  const notFound = (message: string) =>
    Object.assign(new Error(message), { code: 'ERR_MODULE_NOT_FOUND' })

  it('says which package to install when the MCP SDK is missing', () => {
    const error = notFound(
      "Cannot find package '@modelcontextprotocol/sdk' imported from /app/dist/adapters/mcp-stdio/mcp-client.js",
    )
    const explained = explainMissingSdk(error)
    expect(explained).toBeInstanceOf(Error)
    expect((explained as Error).message).toBe(
      '接 MCP 服务器需要安装可选依赖 @modelcontextprotocol/sdk',
    )
    expect((explained as Error).cause).toBe(error)
  })

  it.each([
    ['another missing package', notFound("Cannot find package 'left-pad' imported from /app/x.js")],
    ['an ordinary connect error', new Error('connect ECONNREFUSED')],
    ['a non-error value', 'boom'],
  ])('leaves %s unchanged', (_label, error) => {
    expect(explainMissingSdk(error)).toBe(error)
  })
})
