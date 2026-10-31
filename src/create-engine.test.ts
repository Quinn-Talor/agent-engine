import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  adaptHooks,
  aiSdkProvider,
  compactingMemory,
  createEngine,
  createHookRunner,
  fakeTool,
  hookRunner,
  tools,
  createMcpHost,
  fakeMcpServer,
  mcp,
  mcpHost,
  parseMcpConfig,
  runToEnd,
  defineAgent,
  defineTask,
  engineFingerprint,
  fakeModel,
  memoryArchive,
  modelHub,
  skill,
  standardGuards,
  subagent,
  completionReview,
  searchExposure,
  standardFallback,
  structured,
  text,
  type FakeReply,
  type CapabilityHost,
  type RunEvent,
} from './index.js'

const quiet = { log: () => {} }

describe('createEngine', () => {
  it('AC-023 runs with the standard components when nothing else is configured', async () => {
    const model = fakeModel({ model: 'main', replies: [{ text: '你好，我是助手。' }] })
    const engine = createEngine({
      services: { models: modelHub({ providers: [model], default: model.ref }), logger: quiet },
    })
    const env = engine.environment({ name: 'interactive', principal: { reachable: true } })
    const agent = defineAgent({
      id: 'helper',
      instructions: [{ role: 'system', parts: [{ type: 'text', text: '你是助手' }] }],
    })
    const task = defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text: '你好' }] }] })
    const result = await env.start(agent, task).result
    expect(result).toMatchObject({ status: 'completed', text: '你好，我是助手。' })
  })

  it('AC-023 reviews completion by default and sends back a reply that only announces an action', async () => {
    const model = fakeModel({
      model: 'main',
      replies: [
        { text: '好的，我先查一下北京明天的天气。' },
        { text: '{"complete": false, "confidence": 0.9, "missing": ["没有查询天气"]}' },
        { toolCalls: [{ name: 'weather', input: { city: '北京' } }] },
        { text: '北京明天晴。' },
      ],
    })
    const engine = createEngine({
      services: { models: modelHub({ providers: [model], default: model.ref }), logger: quiet },
    })
    const env = engine.environment({ name: 'interactive', principal: { reachable: true } })
    const agent = defineAgent({
      id: 'helper',
      instructions: [{ role: 'system', parts: [{ type: 'text', text: '你是助手' }] }],
      capabilities: [tools([fakeTool({ name: 'weather', result: '晴' })])],
    })
    const task = defineTask({
      input: [{ role: 'user', parts: [{ type: 'text', text: '北京明天天气怎么样？' }] }],
    })
    const { result, events } = await runToEnd(env.start(agent, task))
    expect(result).toMatchObject({ status: 'completed', text: '北京明天晴。' })
    const checked = events.flatMap((e) => (e.t === 'delivery_checked' ? [e.outcome] : []))
    expect(checked).toEqual(['returned', 'delivered'])
    expect(model.inputs).toHaveLength(4)
  })

  describe('structured delivery', () => {
    const report = z.object({ city: z.string(), high: z.number() })
    const submit = (input: unknown) => ({ toolCalls: [{ name: 'submit', input }] })
    const start = (replies: FakeReply[], maxRepairs: number) => {
      const model = fakeModel({ model: 'main', replies, repeatLast: true })
      const engine = createEngine({
        services: { models: modelHub({ providers: [model], default: model.ref }), logger: quiet },
      })
      const agent = defineAgent({
        id: 'reporter',
        instructions: [{ role: 'system', parts: [{ type: 'text', text: '你是助手' }] }],
        deliverable: { output: structured(report, { maxRepairs }), checks: [] },
      })
      const task = defineTask({
        input: [{ role: 'user', parts: [{ type: 'text', text: '给出北京明天的天气' }] }],
      })
      return engine.environment({ name: 'i', principal: { reachable: true } }).start(agent, task)
    }

    it('counts a submit that does not match the schema as a repair, not a tool failure', async () => {
      const wrong = submit({ city: '北京', high: '二十度' })
      const run = start([wrong, wrong, wrong, submit({ city: '北京', high: 20 })], 6)
      expect(await run.result).toMatchObject({
        status: 'completed',
        output: { city: '北京', high: 20 },
      })
    })

    it('fails with output_invalid once the repairs are used up', async () => {
      const wrong = submit({ city: '北京' })
      const { result, events } = await runToEnd(start([wrong], 2))
      expect(result).toMatchObject({ status: 'failed', code: 'output_invalid' })
      const checked = events.filter((e) => e.t === 'delivery_checked')
      expect(checked).toHaveLength(3)
      expect(JSON.stringify(checked[0])).toContain('high')
    })
  })

  it('AC-023 fingerprints the default memory and guards stably', () => {
    const models = modelHub({ providers: [] })
    const a = createEngine({ services: { models, logger: quiet } })
    const b = createEngine({ services: { models, logger: quiet } })
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.fingerprint).toBe(
      engineFingerprint({
        memory: compactingMemory(),
        guards: standardGuards(),
        deliverable: { output: text(), checks: [completionReview()], fallback: standardFallback() },
        exposure: searchExposure(),
      }),
    )
  })

  const lead = (capabilities: Parameters<typeof defineAgent>[0]['capabilities']) =>
    defineAgent({
      id: 'lead',
      instructions: [{ role: 'system', parts: [{ type: 'text', text: '你是负责人' }] }],
      capabilities,
    })
  const researcher = defineAgent({
    id: 'researcher',
    instructions: [{ role: 'system', parts: [{ type: 'text', text: '你负责查资料' }] }],
  })
  const valuation = { name: 'valuation', description: '估值方法', content: '# 估值', hash: 'h1' }
  const task = defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text: '估一下' }] }] })
  const read = async (archive: ReturnType<typeof memoryArchive>, runId: string) => {
    const out: RunEvent[] = []
    for await (const e of archive.read(runId)) out.push(e)
    return out
  }

  it('AC-012 always provides the skill and delegation hosts; given hosts are added', async () => {
    const capabilities = [
      skill(valuation),
      subagent(researcher, { budget: { maxTotalMs: 600_000 } }),
    ]
    const started = async (hosts?: CapabilityHost[]) => {
      const model = fakeModel({ model: 'main', replies: [{ text: 'ok' }] })
      const archive = memoryArchive()
      const engine = createEngine({
        services: {
          models: modelHub({ providers: [model], default: model.ref }),
          archive,
          logger: quiet,
          ...(hosts ? { hosts } : {}),
        },
      })
      const run = engine
        .environment({ name: 'i', principal: { reachable: true } })
        .start(lead(capabilities), task)
      await run.result
      return { first: (await read(archive, run.runId))[0], model }
    }
    const withDefaults = await started()
    expect(withDefaults.first).toMatchObject({ t: 'run_started', unavailable: [] })
    expect(withDefaults.model.inputs[0]!.tools.map((t) => t.name)).toEqual([
      'activate_skill',
      'delegate',
    ])
    // 传了别的宿主（例如 MCP 连接池）也不会让 skill 和委托悄悄失效。
    const withMcp = await started([{ kind: 'mcp' }])
    expect(withMcp.first).toMatchObject({ t: 'run_started', unavailable: [] })
    expect(withMcp.model.inputs[0]!.tools.map((t) => t.name)).toEqual([
      'activate_skill',
      'delegate',
    ])
  })

  it('AC-013 delegates to a subagent through the shared delegate tool', async () => {
    const model = fakeModel({
      model: 'main',
      replies: [
        {
          toolCalls: [
            { id: 'd1', name: 'delegate', input: { agent: 'researcher', task: '查可比公司' } },
          ],
        },
        { text: '三家可比公司' },
        // 子任务要求"查"却没调用工具：默认的完成审查多调一次模型。
        { text: '{"complete": true, "confidence": 0.9, "missing": []}' },
        { text: '估值完成' },
      ],
    })
    const archive = memoryArchive()
    const engine = createEngine({
      services: {
        models: modelHub({ providers: [model], default: model.ref }),
        archive,
        logger: quiet,
      },
    })
    const run = engine
      .environment({ name: 'i', principal: { reachable: true } })
      .start(lead([subagent(researcher, { budget: { maxTotalMs: 600_000 } })]), task)
    expect(await run.result).toMatchObject({ status: 'completed', text: '估值完成' })
    const finished = (await read(archive, run.runId)).find((e) => e.t === 'tool_finished')
    expect(finished).toMatchObject({ isError: false, childRunId: expect.any(String) })
    const [child] = await archive.query({ parentRunId: run.runId })
    expect(child).toMatchObject({ agentId: 'researcher', status: 'completed' })
    expect(model.inputs[1]!.messages.at(-1)).toMatchObject({ role: 'user' })
  })

  const crm = {
    name: 'crm',
    transport: { kind: 'stdio' as const, command: 'crm-server' },
    exposure: 'eager' as const,
  }

  it('AC-021 calls MCP tools through the connection pool', async () => {
    const server = fakeMcpServer({
      tools: [{ name: 'lookup', annotations: { readOnlyHint: true }, handler: () => '客户 A' }],
    })
    const model = fakeModel({
      model: 'main',
      replies: [
        { toolCalls: [{ id: 'm1', name: 'crm__lookup', input: { id: 1 } }] },
        { text: '客户是 A' },
      ],
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
    const run = engine
      .environment({ name: 'i', principal: { reachable: true } })
      .start(lead([mcp(crm)]), task)
    expect(await run.result).toMatchObject({ status: 'completed', text: '客户是 A' })
    expect(server.calls).toEqual([{ name: 'lookup', args: { id: 1 } }])
    const finished = (await read(archive, run.runId)).find((e) => e.t === 'tool_finished')
    expect(finished).toMatchObject({ capability: 'mcp:crm', effect: 'none', isError: false })
    expect(engine.health().breakers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringMatching(/^mcp:crm@[0-9a-f]{12}$/),
          state: 'closed',
        }),
      ]),
    )
    await engine.shutdown()
  })

  it('AC-022 leaves out an MCP server that cannot connect', async () => {
    const server = fakeMcpServer({ tools: [], failConnects: 1 })
    const model = fakeModel({ model: 'main', replies: [{ text: 'ok' }] })
    const archive = memoryArchive()
    const engine = createEngine({
      services: {
        models: modelHub({ providers: [model], default: model.ref }),
        hosts: [createMcpHost({ connect: server.connect })],
        archive,
        logger: quiet,
      },
    })
    const run = engine
      .environment({ name: 'i', principal: { reachable: true } })
      .start(lead([mcp(crm)]), task)
    expect(await run.result).toMatchObject({ status: 'completed' })
    expect((await read(archive, run.runId))[0]).toMatchObject({
      unavailable: [
        { capability: 'mcp:crm', reason: 'MCP 服务器 crm 连接失败：fake mcp: connect failed' },
      ],
    })
  })

  it('wires the stdio and HTTP adapters into mcpHost', () => {
    const host = mcpHost({})
    expect(host.kind).toBe('mcp')
    expect(parseMcpConfig({ mcpServers: { a: { command: 'a' } } })).toHaveLength(1)
  })

  it('AC-016 denies a tool through an adapted PreToolUse hook', async () => {
    const exec = async () => ({
      exitCode: 2,
      stdout: '',
      stderr: '危险操作被策略禁止',
      timedOut: false,
    })
    const hooks = adaptHooks([{ event: 'PreToolUse', matcher: 'danger', command: 'policy.sh' }])
    const model = fakeModel({
      model: 'main',
      replies: [{ toolCalls: [{ id: 'd1', name: 'danger' }] }, { text: '换了做法' }],
    })
    const archive = memoryArchive()
    const engine = createEngine({
      services: {
        models: modelHub({ providers: [model], default: model.ref }),
        hosts: [createHookRunner({ exec })],
        archive,
        logger: quiet,
      },
    })
    const danger = fakeTool({ name: 'danger' })
    const run = engine
      .environment({ name: 'i', principal: { reachable: true }, permissions: hooks.permissions })
      .start(lead([tools([danger])]), task)
    expect(await run.result).toMatchObject({ status: 'completed', text: '换了做法' })
    const events = await read(archive, run.runId)
    expect(events.find((e) => e.t === 'tool_finished')).toMatchObject({
      isError: true,
      errorCode: 'PERMISSION_DENIED',
    })
    expect(events.find((e) => e.t === 'external_call')).toMatchObject({
      kind: 'hook',
      source: 'permission:hook:PreToolUse:0/hook:PreToolUse',
    })
    expect(danger.calls).toHaveLength(0)
    expect(hookRunner().kind).toBe('hook')
  })

  it('AC-022 exports persistence, observability and replay from the package entry', async () => {
    const entry = await import('./index.js')
    for (const name of [
      'sqliteArchive',
      'otelExporter',
      'langfuseExporter',
      'strictReplay',
      'regressionReplay',
    ]) {
      expect(typeof (entry as Record<string, unknown>)[name]).toBe('function')
    }
  })

  it('AC-019 runs through the AI SDK adapter', async () => {
    ;(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false
    const usage = {
      inputTokens: { total: 40, noCache: 30, cacheRead: 10, cacheWrite: 0 },
      outputTokens: { total: 4, text: 4, reasoning: 0 },
    }
    const replies = [
      [
        { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"id":1}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'x' }, usage },
      ],
      [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: '查到了' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'x' }, usage },
      ],
    ]
    let n = 0
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: convertArrayToReadableStream(replies[n++] as never[]) }),
    })
    const archive = memoryArchive()
    const engine = createEngine({
      services: {
        models: modelHub({
          providers: [
            aiSdkProvider({
              id: 'acme',
              models: { big: { model, capabilities: { contextLimit: 100_000 } } },
            }),
          ],
          default: 'acme:big',
        }),
        archive,
        logger: quiet,
      },
    })
    const lookup = fakeTool({ name: 'lookup', result: '客户 A' })
    const run = engine
      .environment({ name: 'i', principal: { reachable: true } })
      .start(lead([tools([lookup])]), task)
    expect(await run.result).toMatchObject({
      status: 'completed',
      text: '查到了',
      model: 'acme:big',
    })
    const responded = (await read(archive, run.runId)).find((e) => e.t === 'model_responded')
    expect(responded).toMatchObject({
      response: { usage: { input: 30, output: 4, cacheRead: 10, cacheWrite: 0 } },
    })
    expect(lookup.calls).toHaveLength(1)
  })
})
