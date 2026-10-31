// F21：MCP 工具声明的错误类别在运行中生效——确定性的失败第一次就封路，同样的输入不再执行第二次。

import { describe, expect, it } from 'vitest'
import {
  createEngine,
  createMcpHost,
  defineAgent,
  defineTask,
  fakeMcpServer,
  fakeModel,
  mcp,
  memoryArchive,
  modelHub,
  type McpServerSpec,
  type RunEvent,
} from './index.js'

const quiet = { log: () => {} }

async function runTwice(spec: McpServerSpec) {
  const server = fakeMcpServer({
    tools: [
      {
        name: 'send',
        handler: () => ({ content: [{ type: 'text', text: '订单不存在' }], isError: true }),
      },
    ],
  })
  const call = { toolCalls: [{ name: 'crm__send', input: { order: 'A1' } }] }
  const model = fakeModel({
    model: 'main',
    replies: [call, call, { text: '订单 A1 不存在' }],
    repeatLast: true,
  })
  const archive = memoryArchive()
  const engine = createEngine({
    services: {
      models: modelHub({ providers: [model], default: model.ref }),
      hosts: [createMcpHost({ connect: server.connect })],
      archive,
      logger: quiet,
    },
  })
  const agent = defineAgent({
    id: 'clerk',
    instructions: [{ role: 'system', parts: [{ type: 'text', text: '处理订单' }] }],
    capabilities: [mcp(spec)],
  })
  const task = defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text: '发货 A1' }] }] })
  const run = engine.environment({ name: 'i', principal: { reachable: true } }).start(agent, task)
  await run.result
  const events: RunEvent[] = []
  for await (const e of archive.read(run.runId)) events.push(e)
  await engine.shutdown()
  const finished = events.filter((e) => e.t === 'tool_finished')
  return { server, codes: finished.map((e) => ('errorCode' in e ? e.errorCode : undefined)) }
}

const base: McpServerSpec = {
  name: 'crm',
  transport: { kind: 'stdio', command: 'crm-server' },
  exposure: 'eager',
}

describe('MCP error class (F21)', () => {
  it('AC-004 blocks a deterministic failure after the first call', async () => {
    const { server, codes } = await runTwice({ ...base, errorClass: { send: 'deterministic' } })

    expect(server.calls).toHaveLength(1)
    expect(codes).toEqual(['TOOL_EXCEPTION', 'TOOL_BLOCKED'])
  })

  it('AC-004 still lets an undeclared failure run twice', async () => {
    const { server, codes } = await runTwice(base)

    expect(server.calls).toHaveLength(2)
    expect(codes.slice(0, 2)).toEqual(['TOOL_EXCEPTION', 'TOOL_EXCEPTION'])
  })
})
