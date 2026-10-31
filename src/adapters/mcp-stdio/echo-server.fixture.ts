// 测试用 stdio MCP 服务器：由 Node 直接执行（类型擦除）。工具 echo 返回参数里的 text；
// grow 新增一个工具并发送 tools/list_changed；只用 SDK 的低层 Server 与 JSON Schema。

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const tools: Array<{
  name: string
  description?: string
  inputSchema: { type: 'object'; [k: string]: unknown }
  annotations?: { readOnlyHint?: boolean }
}> = [
  {
    name: 'echo',
    description: 'echo the text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  { name: 'grow', description: 'add a tool', inputSchema: { type: 'object' } },
]

const server = new Server(
  { name: 'echo', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
)
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  if (name === 'echo') return { content: [{ type: 'text', text: String(args?.text ?? '') }] }
  if (name === 'grow') {
    tools.push({ name: `extra${tools.length}`, inputSchema: { type: 'object' } })
    await server.sendToolListChanged()
    return { content: [{ type: 'text', text: 'grown' }] }
  }
  return { content: [{ type: 'text', text: `unknown ${name}` }], isError: true }
})
await server.connect(new StdioServerTransport())
