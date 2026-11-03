// 案例库 MCP 服务器（stdio，由 Node 直接执行）：演示外部系统经 MCP 接入。
// 访问令牌经环境变量传入：引擎从凭据库按引用解析，令牌值不进运行日志。案例为虚构示例。

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const CASES = [
  '（虚构示例）某劳动人事争议仲裁委员会裁决：用人单位连续三个月未足额支付工资，劳动者据此解除劳动合同，支持经济补偿请求。',
  '（虚构示例）某区人民法院判决：用人单位以经营困难为由拖欠工资，不构成免责事由，应补发工资并支付经济补偿。',
]

const server = new Server({ name: 'case-law', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search_cases',
      description: '按关键词检索劳动争议类案的裁判要旨',
      inputSchema: {
        type: 'object',
        properties: { keyword: { type: 'string' } },
        required: ['keyword'],
      },
      annotations: { readOnlyHint: true },
    },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (process.env.CASE_LAW_TOKEN !== 'demo-case-law-token') {
    return { content: [{ type: 'text', text: '未授权：令牌无效' }], isError: true }
  }
  const keyword = String(request.params.arguments?.keyword ?? '')
  const hits = CASES.filter((c) => keyword.split(/\s+/).some((w) => w && c.includes(w)))
  return { content: [{ type: 'text', text: hits.join('\n') || '没有找到类案' }] }
})
await server.connect(new StdioServerTransport())
