import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { httpConnect } from './mcp-http.js'

let http: HttpServer
let url: string
const keys: Array<string | undefined> = []

function mcpServer(): Server {
  const server = new Server({ name: 'crm', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'lookup', inputSchema: { type: 'object' }, annotations: { idempotentHint: true } },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: 'text', text: `customer ${String(request.params.arguments?.id)}` }],
    structuredContent: { id: request.params.arguments?.id },
  }))
  return server
}

beforeAll(async () => {
  http = createServer(async (req, res) => {
    keys.push(req.headers['x-api-key'] as string | undefined)
    const server = mcpServer()
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

afterAll(async () => {
  await new Promise((resolve) => http.close(resolve))
})

describe('httpConnect', () => {
  it('AC-019 connects over Streamable HTTP with headers', async () => {
    const conn = await httpConnect(
      { name: 'crm', transport: { kind: 'http', url, headers: { 'X-Api-Key': 'k-1' } } },
      { signal: new AbortController().signal },
    )
    try {
      expect(await conn.listTools()).toEqual([
        { name: 'lookup', inputSchema: { type: 'object' }, annotations: { idempotentHint: true } },
      ])
      expect(
        await conn.callTool(
          'lookup',
          { id: 7 },
          { signal: new AbortController().signal, timeoutMs: 5000 },
        ),
      ).toEqual({ content: [{ type: 'text', text: 'customer 7' }], structuredContent: { id: 7 } })
      expect(keys.length).toBeGreaterThan(0)
      expect(keys.every((k) => k === 'k-1')).toBe(true)
    } finally {
      await conn.close()
    }
  })

  it('rejects other transports', async () => {
    await expect(
      httpConnect(
        { name: 'x', transport: { kind: 'stdio', command: 'x' } },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('HTTP 适配器不支持 stdio 传输')
  })
})
