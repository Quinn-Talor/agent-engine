// stdio MCP 适配器（方案 D3）：服务器作为独立进程运行（设计 §5.5），经官方 SDK 的 stdio 传输连接。

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpConnect } from '../../api.js'
import { CLIENT_INFO, wrapClient } from './mcp-client.js'

export const stdioConnect: McpConnect = async (server, { signal }) => {
  const t = server.transport
  if (t.kind !== 'stdio') throw new Error(`stdio 适配器不支持 ${t.kind} 传输`)
  const transport = new StdioClientTransport({
    command: t.command,
    args: t.args ?? [],
    env: { ...getDefaultEnvironment(), ...t.env },
    ...(t.cwd ? { cwd: t.cwd } : {}),
    stderr: 'ignore',
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
