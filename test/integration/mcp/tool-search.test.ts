// F23：搜索后只加载命中的 MCP 工具；每步可见工具记录在 context_built，与模型实际收到的一致。
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
  type RunEvent,
} from '../../../src/index.js'

const quiet = { log: () => {} }

describe('F23 tool search', () => {
  it('AC-009 loads only the matching MCP tools after a search', async () => {
    const tools = [
      { name: 'daily', description: '日线行情', handler: () => 'ok' },
      ...Array.from({ length: 29 }, (_, i) => ({ name: `misc${i}`, description: `杂项工具 ${i}` })),
    ]
    const server = fakeMcpServer({ tools })
    const model = fakeModel({
      model: 'main',
      replies: [
        { toolCalls: [{ id: 's1', name: 'search_tool', input: { query: '日线' } }] },
        { toolCalls: [{ id: 'c1', name: 'crm__daily', input: {} }] },
        { text: 'done' },
      ],
    })
    const archive = memoryArchive()
    const engine = createEngine({
      services: {
        models: modelHub({ providers: [model], default: model.ref }),
        archive,
        hosts: [createMcpHost({ connect: server.connect })],
        logger: quiet,
      },
    })
    const agent = defineAgent({
      id: 'lead',
      instructions: [{ role: 'system', parts: [{ type: 'text', text: '查行情' }] }],
      capabilities: [mcp({ name: 'crm', transport: { kind: 'stdio', command: 'crm-server' } })],
    })
    const task = defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text: '日线' }] }] })

    const result = await engine
      .environment({ name: 'i', principal: { reachable: true } })
      .start(agent, task).result

    expect(result.status).toBe('completed')
    expect(server.calls.map((c) => c.name)).toEqual(['daily'])
    const second = model.inputs[1]!.tools.map((t) => t.name)
    const mcpTools = second.filter((n) => n.startsWith('crm__'))
    expect(mcpTools).toContain('crm__daily')
    expect(mcpTools.length).toBeLessThanOrEqual(8)
    const events: RunEvent[] = []
    for await (const e of archive.read(result.runId)) events.push(e)
    const built = events.filter(
      (e): e is Extract<RunEvent, { t: 'context_built' }> => e.t === 'context_built',
    )
    expect(built[1]!.tools).toEqual(second)
    await engine.shutdown()
  })
})
