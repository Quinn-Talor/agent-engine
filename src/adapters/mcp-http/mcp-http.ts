// Streamable HTTP MCP 适配器（方案 D3）：经官方 SDK 的 Streamable HTTP 传输连接远程服务器，
// 请求头里带上解析后的凭据。客户端封装与 stdio 适配器共用。

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpConnect } from '../../sdk.js'
import { CLIENT_INFO, wrapClient } from '../mcp-stdio/mcp-client.js'

export const httpConnect: McpConnect = async (server, { signal }) => {
  const t = server.transport
  if (t.kind !== 'http') throw new Error(`HTTP 适配器不支持 ${t.kind} 传输`)
  const transport = new StreamableHTTPClientTransport(new URL(t.url), {
    ...(t.headers ? { requestInit: { headers: t.headers } } : {}),
  })
  const client = new Client(CLIENT_INFO)
  try {
    await client.connect(transport, { signal })
  } catch (error) {
    await client.close().catch(() => undefined)
    throw error
  }
  return wrapClient(client)
}
