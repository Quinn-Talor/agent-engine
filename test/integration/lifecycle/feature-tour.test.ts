// 功能全流程：应用从包入口装配引擎，跑通一个 Claude Code 插件（skill、子 agent、MCP、四种 hook）驱动的
// 多步循环，以及多模态输入从受理、组装到 AI SDK 请求体的整条路径。hook 是真实子进程。

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adaptHooks,
  createEngine,
  createMcpHost,
  defineAgent,
  defineTask,
  hookRunner,
  mcp,
  memoryArchive,
  modelHub,
  parsePlugin,
  riskApproval,
  skill,
  subagent,
  text,
  toolContent,
  tools,
  type ModelMessage,
  type ParsedPlugin,
  type RunEvent,
} from '../../../src/index.js'
import {
  assertInvariants,
  fakeMcpServer,
  fakeModel,
  fakeTool,
  runToEnd,
} from '../../../src/testing.js'
import { aiSdkProvider } from '../../../src/adapters/ai-sdk/ai-sdk-provider.js'

const quiet = { log: () => {} }
const noChecks = { output: text(), checks: [] }

/** 一条消息里的全部文字（字符串内容、文本片段、工具结果）。 */
const textOf = (messages: readonly ModelMessage[]): string =>
  messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content
            .map((p) => (p.type === 'text' ? p.text : p.type === 'tool-result' ? p.output : ''))
            .join('\n'),
    )
    .join('\n')

async function script(path: string, body: string) {
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
}

describe('feature tour: a plugin drives a full run', () => {
  let dir: string
  let plugin: ParsedPlugin

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-engine-plugin-'))
    for (const sub of ['.claude-plugin', 'skills/weekly-report', 'agents', 'hooks', 'commands']) {
      await mkdir(join(dir, sub), { recursive: true })
    }
    await writeFile(
      join(dir, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'ops', version: '1.2.0', description: '运营工具箱' }),
    )
    await writeFile(
      join(dir, 'skills/weekly-report/SKILL.md'),
      '---\nname: weekly-report\ndescription: 写运营周报\n---\n周报格式：先结论后数据，末尾注明数据来源。\n',
    )
    await writeFile(
      join(dir, 'agents/analyst.md'),
      '---\nname: analyst\ndescription: 分析运营数据\n---\n你是数据分析师，只回答数据结论。\n',
    )
    await writeFile(
      join(dir, 'commands/report.md'),
      '---\ndescription: 生成周报\n---\n生成本周运营周报。\n',
    )
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { crm: { command: '${CLAUDE_PLUGIN_ROOT}/bin/crm' } } }),
    )
    const hook = (file: string, matcher?: string) => [
      {
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: 'command', command: `\${CLAUDE_PLUGIN_ROOT}/hooks/${file}` }],
      },
    ]
    await writeFile(
      join(dir, 'hooks/hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: hook('start.sh'),
          PreToolUse: hook('deny.sh', 'delete_record'),
          PostToolUse: hook('post.sh', 'metrics'),
          Stop: hook('stop.sh'),
        },
      }),
    )
    await script(join(dir, 'hooks/start.sh'), 'cat >/dev/null\necho "今天是周报日"')
    await script(
      join(dir, 'hooks/deny.sh'),
      'cat >/dev/null\necho "删除记录需要人工处理" >&2\nexit 2',
    )
    await script(
      join(dir, 'hooks/post.sh'),
      'cat >/dev/null\nprintf \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"指标口径：周环比"}}\'',
    )
    await script(
      join(dir, 'hooks/stop.sh'),
      'input=$(cat)\ncase "$input" in *\'"stop_hook_active":true\'*) exit 0;; esac\necho "周报缺少数据来源" >&2\nexit 2',
    )
    plugin = await parsePlugin(dir)
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('parses every part of the plugin', () => {
    expect(plugin).toMatchObject({ name: 'ops', version: '1.2.0', description: '运营工具箱' })
    expect(plugin.skills.map((s) => s.name)).toEqual(['weekly-report'])
    expect(plugin.agents).toMatchObject([{ def: { id: 'analyst' }, description: '分析运营数据' }])
    expect(plugin.mcpServers).toMatchObject([
      { name: 'crm', transport: { kind: 'stdio', command: `${dir}/bin/crm` } },
    ])
    expect(plugin.hooks.map((h) => [h.event, h.matcher, h.source])).toEqual([
      ['SessionStart', undefined, 'plugin:ops'],
      ['PreToolUse', 'delete_record', 'plugin:ops'],
      ['PostToolUse', 'metrics', 'plugin:ops'],
      ['Stop', undefined, 'plugin:ops'],
    ])
    expect(plugin.commands).toEqual([
      { name: 'report', description: '生成周报', content: '生成本周运营周报。' },
    ])
  })

  it('loads a skill, runs MCP, local and denied tools in one step, delegates, and is sent back once by the Stop hook', async () => {
    const server = fakeMcpServer({
      tools: [
        {
          name: 'lookup',
          annotations: { readOnlyHint: true },
          handler: () => '本周新增客户 42 家',
        },
      ],
    })
    const main = fakeModel({
      model: 'main',
      replies: [
        { toolCalls: [{ id: 's1', name: 'activate_skill', input: { name: 'weekly-report' } }] },
        {
          toolCalls: [
            { id: 'p1', name: 'crm__lookup', input: { week: 46 } },
            { id: 'p2', name: 'metrics', input: {} },
            { id: 'p3', name: 'delete_record', input: { id: 7 } },
          ],
        },
        {
          toolCalls: [
            { id: 'd1', name: 'delegate', input: { agent: 'analyst', task: '分析增长' } },
          ],
        },
        { text: '结论：本周增长 5%。' },
        { text: '结论：本周增长 5%。数据来源：CRM 与指标看板。' },
      ],
    })
    const child = fakeModel({ provider: 'child', model: 'analyst', replies: [{ text: '增长 5%' }] })
    const archive = memoryArchive()
    const engine = createEngine({
      services: {
        models: modelHub({ providers: [main, child], default: main.ref }),
        hosts: [createMcpHost({ connect: server.connect }), hookRunner()],
        archive,
        logger: quiet,
      },
    })
    const hooks = adaptHooks(plugin.hooks)
    const env = engine.environment({
      name: 'ops',
      principal: { reachable: true },
      notice: hooks.notice,
      permissions: hooks.permissions,
      guards: hooks.guards,
      checks: hooks.checks,
    })
    const metrics = fakeTool({ name: 'metrics', result: '周活 1.2 万' })
    const deleteRecord = fakeTool({ name: 'delete_record', effect: 'side_effect' })
    const analyst = defineAgent({
      ...plugin.agents[0]!.def,
      model: { prefer: child.ref },
      deliverable: noChecks,
    })
    const agent = defineAgent({
      id: 'ops-assistant',
      instructions: [{ role: 'system', parts: [{ type: 'text', text: '你是运营助理' }] }],
      capabilities: [
        ...plugin.skills.map(skill),
        ...plugin.mcpServers.map((s) => mcp({ ...s, exposure: 'eager' })),
        tools([metrics, deleteRecord]),
        subagent(analyst, { description: plugin.agents[0]!.description }),
      ],
      deliverable: noChecks,
    })
    const task = defineTask({
      input: [{ role: 'user', parts: [{ type: 'text', text: '写本周运营周报' }] }],
    })

    const { result, events } = await runToEnd(env.start(agent, task))

    expect(result).toMatchObject({
      status: 'completed',
      text: '结论：本周增长 5%。数据来源：CRM 与指标看板。',
      steps: 5,
    })
    assertInvariants(events)
    const inputs = main.inputs.map((i) => textOf(i.messages))
    // SessionStart hook 的输出成为须知。
    expect(inputs[0]).toContain('今天是周报日')
    // skill 的完整说明作为 activate_skill 的结果进入下一步。
    expect(inputs[1]).toContain('先结论后数据')
    // 同一步里的三个调用：MCP、本地工具、被 PreToolUse hook 拒绝的调用。
    const finished = events.filter(
      (e): e is Extract<RunEvent, { t: 'tool_finished' }> => e.t === 'tool_finished',
    )
    const byCall = new Map(finished.map((e) => [e.callId, e]))
    expect(byCall.get('p1')).toMatchObject({ capability: 'mcp:crm', isError: false })
    expect(byCall.get('p2')).toMatchObject({ isError: false })
    expect(byCall.get('p3')).toMatchObject({ isError: true, errorCode: 'PERMISSION_DENIED' })
    expect(server.calls).toEqual([{ name: 'lookup', args: { week: 46 } }])
    expect(deleteRecord.calls).toHaveLength(0)
    expect(inputs[2]).toContain('本周新增客户 42 家')
    expect(inputs[2]).toContain('删除记录需要人工处理')
    // PostToolUse hook 的补充说明作为提示进入下一步。
    expect(inputs[2]).toContain('指标口径：周环比')
    // 委托给插件里的子 agent。
    expect(byCall.get('d1')).toMatchObject({ isError: false, childRunId: expect.any(String) })
    const [childRun] = await archive.query({ parentRunId: result.runId })
    expect(childRun).toMatchObject({ agentId: 'analyst', status: 'completed', model: child.ref })
    expect(inputs[3]).toContain('增长 5%')
    // Stop hook 退回第一版答复，第二版带上数据来源后放行。
    expect(inputs[4]).toContain('周报缺少数据来源')
    const hookCalls = events.filter((e) => e.t === 'external_call' && e.kind === 'hook')
    expect(hookCalls.map((e) => (e as { source: string }).source)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('hook:SessionStart'),
        expect.stringContaining('hook:PreToolUse'),
        expect.stringContaining('hook:PostToolUse'),
        expect.stringContaining('hook:Stop'),
      ]),
    )
    await engine.shutdown()
  })
})

describe('feature tour: multimodal input end to end', () => {
  ;(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString(
    'base64',
  )

  it('turns a JSON file into text, sends the image, and refuses a PDF the model cannot take', async () => {
    const usage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    }
    const model = new MockLanguageModelV4({
      provider: 'openai.chat',
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: '看过了' },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ]),
      }),
    })
    const engine = createEngine({
      services: {
        models: modelHub({
          providers: [
            aiSdkProvider({
              id: 'acme',
              models: {
                eye: { model, capabilities: { contextLimit: 100_000, inputs: ['image'] } },
              },
            }),
          ],
          default: 'acme:eye',
        }),
        logger: quiet,
      },
    })
    const env = engine.environment({ name: 'i', principal: { reachable: true } })
    const agent = defineAgent({
      id: 'reader',
      instructions: [{ role: 'system', parts: [{ type: 'text', text: '你是助手' }] }],
      deliverable: noChecks,
    })
    const json = Buffer.from('{"订单":3}').toString('base64')
    const task = defineTask({
      input: [
        {
          role: 'user',
          parts: [
            { type: 'text', text: '看看附件' },
            { type: 'file', data: json, mediaType: 'application/json', filename: 'orders.json' },
            { type: 'image', image: png, mediaType: 'image/png' },
          ],
        },
      ],
    })
    expect(await env.start(agent, task).result).toMatchObject({
      status: 'completed',
      text: '看过了',
    })
    const user = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'user')!
    expect(user.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: '[文件 orders.json（application/json）]\n{"订单":3}',
        }),
        expect.objectContaining({ type: 'file', mediaType: 'image/png' }),
      ]),
    )

    const pdf = defineTask({
      input: [
        {
          role: 'user',
          parts: [
            { type: 'file', data: 'JVBERi0x', mediaType: 'application/pdf', filename: 'a.pdf' },
          ],
        },
      ],
    })
    expect(await env.start(agent, pdf).result).toMatchObject({
      status: 'failed',
      code: 'model_unsuitable',
    })
    expect(() =>
      defineTask({
        input: [{ role: 'user', parts: [{ type: 'image', image: 'https://example.com/a.png' }] }],
      }),
    ).toThrow()
  })

  it('keeps only the most recent screenshots in the view while the log keeps them all', async () => {
    const shots = 7
    const replies = [
      ...Array.from({ length: shots }, (_, i) => ({
        toolCalls: [{ id: `c${i + 1}`, name: 'screenshot', input: {} }],
      })),
      { text: '截完了' },
    ]
    const model = fakeModel({ model: 'main', replies, capabilities: { inputs: ['image'] } })
    const engine = createEngine({
      services: {
        models: modelHub({ providers: [model], default: model.ref }),
        logger: quiet,
      },
      guards: [],
    })
    const env = engine.environment({ name: 'i', principal: { reachable: true } })
    const screenshot = fakeTool({
      name: 'screenshot',
      result: toolContent([
        { type: 'text', text: '截图' },
        { type: 'image', image: png, mediaType: 'image/png' },
      ]),
    })
    const agent = defineAgent({
      id: 'browser',
      instructions: [{ role: 'system', parts: [{ type: 'text', text: '你操作浏览器' }] }],
      capabilities: [tools([screenshot])],
      model: { settings: { keepRecentImages: 3 } },
      deliverable: noChecks,
    })
    const task = defineTask({
      input: [{ role: 'user', parts: [{ type: 'text', text: '连续截图' }] }],
    })
    const { result, events } = await runToEnd(env.start(agent, task))
    expect(result).toMatchObject({ status: 'completed', text: '截完了' })
    const imagesIn = (messages: readonly ModelMessage[]) =>
      messages.reduce(
        (n, m) =>
          n + (m.role === 'tool' ? m.content.reduce((k, r) => k + (r.images?.length ?? 0), 0) : 0),
        0,
      )
    const last = model.inputs.at(-1)!.messages
    expect(imagesIn(last)).toBe(4)
    expect(textOf(last)).toContain('较早的图片 1 张已从视图省略')
    const logged = events.filter((e) => e.t === 'tool_finished' && (e.images?.length ?? 0) > 0)
    expect(logged).toHaveLength(shots)
  })
})

describe('feature tour: claims are checked against what was executed', () => {
  it('sends back a claim that no turn executed, and passes the corrected answer', async () => {
    const verdicts: string[] = []
    const model = fakeModel({
      model: 'main',
      replies: [
        { toolCalls: [{ id: 'r1', name: 'refund', input: { orderId: 'O1' } }] },
        { text: '订单 O1 退款完成。' },
        { text: '您的退款已办理，收货地址也已修改。' },
        (input) => {
          verdicts.push(String(input.messages.at(-1)!.content))
          return {
            text: '{"complete": false, "confidence": 0.9, "missing": ["声称已修改地址，但没有执行"]}',
          }
        },
        { text: '您的退款已办理，地址还没有修改。' },
        (input) => {
          verdicts.push(String(input.messages.at(-1)!.content))
          return { text: '{"complete": true, "confidence": 0.9, "missing": []}' }
        },
      ],
    })
    const engine = createEngine({
      services: { models: modelHub({ providers: [model], default: model.ref }), logger: quiet },
    })
    const env = engine.environment({ name: 'shop', principal: { reachable: true } })
    const refund = fakeTool({ name: 'refund', effect: 'side_effect', result: '已退款' })
    const agent = defineAgent({
      id: 'clerk',
      instructions: [{ role: 'system', parts: [{ type: 'text', text: '你是客服' }] }],
      capabilities: [tools([refund])],
    })
    const say = (text: string) =>
      defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text }] }] })
    expect(await env.start(agent, say('给 O1 退款'), { session: 's' }).result).toMatchObject({
      status: 'completed',
    })
    const second = await env.start(agent, say('都办好了吗'), { session: 's' }).result
    expect(second).toMatchObject({ status: 'completed', text: '您的退款已办理，地址还没有修改。' })
    expect(verdicts).toHaveLength(2)
    expect(JSON.parse(verdicts[0]!)).toMatchObject({
      executed: ['第 1 轮已执行 refund {"orderId":"O1"}'],
    })
    expect(refund.calls).toHaveLength(1)
  })

  it('sends back a refund claimed in a roundabout way after the approver turned it down', async () => {
    const verdicts: string[] = []
    const model = fakeModel({
      model: 'main',
      replies: [
        { toolCalls: [{ id: 'r1', name: 'refund', input: { orderId: 'O1' } }] },
        { text: '订单 O1 已为您退款。' },
        (input) => {
          verdicts.push(String(input.messages.at(-1)!.content))
          return {
            text: '{"complete": false, "confidence": 0.9, "missing": ["声称已退款，但审批被拒，没有执行"]}',
          }
        },
        { text: '退款审批没有通过，订单 O1 还没有退款。' },
      ],
    })
    const engine = createEngine({
      services: { models: modelHub({ providers: [model], default: model.ref }), logger: quiet },
    })
    const env = engine.environment({
      name: 'shop',
      principal: { reachable: true, approver: { approve: async () => ({ approved: false }) } },
      permissions: [riskApproval({ mode: 'ask-high' })],
    })
    const refund = fakeTool({
      name: 'refund',
      risk: 'high',
      effect: 'side_effect',
      result: '已退款',
    })
    const agent = defineAgent({
      id: 'clerk',
      instructions: [{ role: 'system', parts: [{ type: 'text', text: '你是客服' }] }],
      capabilities: [tools([refund])],
    })
    const { result, events } = await runToEnd(
      env.start(
        agent,
        defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text: '给 O1 退款' }] }] }),
      ),
    )
    expect(result).toMatchObject({
      status: 'completed',
      text: '退款审批没有通过，订单 O1 还没有退款。',
    })
    expect(refund.calls).toHaveLength(0)
    expect(verdicts).toHaveLength(1)
    expect(JSON.parse(verdicts[0]!)).toMatchObject({ answer: '订单 O1 已为您退款。', executed: [] })
    expect(events.filter((e) => e.t === 'delivery_checked').map((e) => e.outcome)).toEqual([
      'returned',
      'delivered',
    ])
  })
})
