// F22：不符合厂商格式的 MCP 工具名在引擎里改用规整名字；模型看到的工具名都合规，调用仍到服务器原名。
import { describe, expect, it } from 'vitest'
import {
  createEngine,
  createMcpHost,
  defineAgent,
  defineTask,
  mcp,
  memoryArchive,
  modelHub,
} from '../../../src/index.js'
import { fakeMcpServer, fakeModel } from '../../../src/testing.js'
import { hashOf } from '../../../src/sdk.js'

const VALID_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
const quiet = { log: () => {} }

describe('F22 MCP tool names', () => {
  it('AC-006 runs a renamed MCP tool and only shows compliant names to the model', async () => {
    const server = fakeMcpServer({ tools: [{ name: 'files.read', handler: () => 'ok' }] })
    const renamed = `crm__files_read_${hashOf('crm__files.read').slice(0, 8)}`
    const model = fakeModel({
      model: 'main',
      replies: [{ toolCalls: [{ id: 'c1', name: renamed, input: {} }] }, { text: 'done' }],
    })
    const engine = createEngine({
      services: {
        models: modelHub({ providers: [model], default: model.ref }),
        archive: memoryArchive(),
        hosts: [createMcpHost({ connect: server.connect })],
        logger: quiet,
      },
    })
    const agent = defineAgent({
      id: 'lead',
      instructions: [{ role: 'system', parts: [{ type: 'text', text: '查文件' }] }],
      capabilities: [
        mcp({
          name: 'crm',
          transport: { kind: 'stdio', command: 'crm-server' },
          exposure: 'eager',
        }),
      ],
    })
    const task = defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text: '读' }] }] })

    const result = await engine
      .environment({ name: 'i', principal: { reachable: true } })
      .start(agent, task).result

    expect(result.status).toBe('completed')
    expect(server.calls).toEqual([{ name: 'files.read', args: {} }])
    const names = model.inputs.flatMap((input) => input.tools.map((t) => t.name))
    expect(names).toContain(renamed)
    for (const name of names) expect(name).toMatch(VALID_TOOL_NAME)
    await engine.shutdown()
  })
})
