import { describe, expect, it, vi } from 'vitest'
import type {
  Candidate,
  ComponentCtx,
  HookResult,
  HookRunner,
  HookSpec,
  RunInfo,
  ToolCallView,
} from '../../api.js'
import { runInfo } from '../capabilities/prepare.fixture.js'
import { obs, tool } from '../supervision/observations.fixture.js'
import { adaptHooks } from './adapt-hooks.js'

const ok = (stdout = '', json?: Record<string, unknown>): HookResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  timedOut: false,
  ...(json ? { json } : {}),
})
const exit = (exitCode: number, stderr = ''): HookResult => ({
  exitCode,
  stdout: '',
  stderr,
  timedOut: false,
})

function setup(reply: HookResult | ((input: Record<string, unknown>) => HookResult)) {
  const records: Array<[string, string | undefined]> = []
  const logs: string[] = []
  const inputs: Array<Record<string, unknown>> = []
  const runner: HookRunner = {
    kind: 'hook',
    run: vi.fn(async (_spec: HookSpec, input: Record<string, unknown>) => {
      inputs.push(input)
      return typeof reply === 'function' ? reply(input) : reply
    }),
  }
  const ctx = {
    host: <T>(kind: string) => {
      if (kind !== 'hook') throw new Error(`no host ${kind}`)
      return runner as T
    },
    record: async <T>(name: string, fn: () => Promise<T>, opts?: { kind?: string }) => {
      records.push([name, opts?.kind])
      return fn()
    },
    log: (_l: string, m: string) => logs.push(m),
  } as unknown as ComponentCtx
  return { ctx, runner, records, logs, inputs }
}

const run = (patch: Partial<RunInfo> = {}): RunInfo => ({
  ...runInfo(),
  task: { subject: 'session-1', input: '帮我整理报告', scope: { workspace: '/ws' } },
  ...patch,
})
const call = (toolName: string, input: unknown = { cmd: 'ls' }): ToolCallView => ({
  callId: 'c1',
  toolName,
  capability: 'core',
  input,
  risk: 'low',
  effect: 'side_effect',
})
const candidate = (text: string): Candidate => ({ step: 2, text, observation: obs(2) })

describe('adaptHooks', () => {
  const specs: HookSpec[] = [
    { event: 'SessionStart', command: 'start.sh' },
    {
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'guard.sh',
      timeoutMs: 2000,
      source: 'plugin:safe',
    },
    { event: 'PreToolUse', command: 'audit.sh' },
    { event: 'PostToolUse', command: 'lint.sh' },
    { event: 'Stop', command: 'verify.sh' },
    { event: 'SubagentStop', command: 'child.sh' },
    { event: 'UserPromptSubmit', command: 'prompt.sh' },
    { event: 'PreCompact', command: 'compact.sh' },
    { event: 'Notification', command: 'notify.sh' },
  ]

  it('AC-012 identifies each component by event and order', () => {
    const adapted = adaptHooks(specs)
    expect(adapted.permissions.map((p) => p.id)).toEqual(['hook:PreToolUse:0', 'hook:PreToolUse:1'])
    expect(adapted.permissions[0]).toMatchObject({
      version: '1',
      config: { command: 'guard.sh', matcher: 'Bash', timeoutMs: 2000, source: 'plugin:safe' },
    })
    expect(adapted.permissions[1]!.config).toEqual({
      command: 'audit.sh',
      matcher: null,
      timeoutMs: 10_000,
      source: null,
    })
    expect(adapted.notice.map((n) => n.id)).toEqual([
      'hook:SessionStart:0',
      'hook:UserPromptSubmit:0',
    ])
    expect(adapted.guards.map((g) => g.id)).toEqual(['hook:PostToolUse:0'])
    expect(adapted).not.toHaveProperty('rules')
    expect(adapted.checks.map((c) => [c.id, c.mode])).toEqual([
      ['hook:Stop:0', 'gate'],
      ['hook:SubagentStop:0', 'gate'],
    ])
  })

  it('AC-010 hands PreCompact and Notification hooks back to the application', () => {
    expect(adaptHooks(specs).notifications.map((s) => s.event)).toEqual([
      'PreCompact',
      'Notification',
    ])
  })

  it('AC-005 turns session hooks into notice', async () => {
    const [start, prompt] = adaptHooks(specs).notice
    const a = setup(ok('今天是周五\n'))
    expect(await start!.provide(run(), a.ctx)).toEqual([
      { role: 'system', parts: [{ type: 'text', text: '今天是周五' }] },
    ])
    expect(a.inputs[0]).toEqual({
      session_id: 'session-1',
      transcript_path: '',
      cwd: '/ws',
      hook_event_name: 'SessionStart',
      source: 'startup',
    })
    const b = setup(ok('{}', { hookSpecificOutput: { additionalContext: '用户偏好简体中文' } }))
    expect(await prompt!.provide(run(), b.ctx)).toEqual([
      { role: 'system', parts: [{ type: 'text', text: '用户偏好简体中文' }] },
    ])
    expect(b.inputs[0]).toMatchObject({
      hook_event_name: 'UserPromptSubmit',
      prompt: '帮我整理报告',
    })
    const c = setup(exit(1, 'boom'))
    expect(await start!.provide(run(), c.ctx)).toEqual([])
    expect(c.logs).toEqual(['hook SessionStart 退出码 1'])
    expect(await start!.provide(run(), setup(ok('  ')).ctx)).toEqual([])
  })

  it('follows Claude Code semantics for session hook output', async () => {
    const [start, prompt] = adaptHooks(specs).notice
    const provide = (p: typeof start, reply: HookResult) => p!.provide(run(), setup(reply).ctx)
    const blockJson = { decision: 'block', reason: 'contains secret' }
    // JSON 输出只取 additionalContext，不把原文注入须知。
    expect(await provide(prompt, ok(JSON.stringify(blockJson), blockJson))).toEqual({
      block: 'contains secret',
    })
    expect(await provide(prompt, ok('{"suppressOutput":true}', { suppressOutput: true }))).toEqual(
      [],
    )
    expect(
      await provide(start, ok('{"hookSpecificOutput":{}}', { hookSpecificOutput: {} })),
    ).toEqual([])
    // exit 2 拦下 UserPromptSubmit；理由取 stderr。
    expect(await provide(prompt, exit(2, '含有密钥\n'))).toEqual({ block: '含有密钥' })
    expect(await provide(prompt, exit(2))).toEqual({ block: 'hook 拦下了这次运行' })
    expect(await provide(prompt, ok('', { decision: 'block' }))).toEqual({
      block: 'hook 拦下了这次运行',
    })
    // continue: false 对两种 hook 都生效。
    expect(await provide(start, ok('', { continue: false, stopReason: '维护中' }))).toEqual({
      block: '维护中',
    })
    // SessionStart 不能拦截：exit 2 只记日志，decision 无效。
    const s = setup(exit(2, 'nope'))
    expect(await start!.provide(run(), s.ctx)).toEqual([])
    expect(s.logs).toEqual(['hook SessionStart 退出码 2'])
    expect(await provide(start, ok('', { decision: 'block', reason: 'x' }))).toEqual([])
  })

  it('blocks the prompt when a UserPromptSubmit hook cannot run, as PreToolUse denies', async () => {
    const [start, prompt] = adaptHooks(specs).notice
    const broken = setup(ok())
    broken.runner.run = async () => {
      throw new Error('能力宿主不存在：hook')
    }
    expect(await prompt!.provide(run(), broken.ctx)).toEqual({
      block: 'UserPromptSubmit hook 没能运行，拦下这次运行：能力宿主不存在：hook',
    })
    const timedOut = setup({ exitCode: null, stdout: '', stderr: '', timedOut: true })
    expect(await prompt!.provide(run(), timedOut.ctx)).toEqual({
      block: 'UserPromptSubmit hook 超时，拦下这次运行',
    })
    // SessionStart 只提供须知：跑不起来只记日志。
    const quiet = setup(ok())
    quiet.runner.run = async () => {
      throw new Error('spawn ENOENT')
    }
    expect(await start!.provide(run(), quiet.ctx)).toEqual([])
    expect(quiet.logs).toEqual(['hook SessionStart 没能运行：spawn ENOENT'])
  })

  it('AC-005 falls back to the run id and process directory', async () => {
    const [start] = adaptHooks(specs).notice
    const a = setup(ok('x'))
    await start!.provide({ ...runInfo(), task: {} }, a.ctx)
    expect(a.inputs[0]).toMatchObject({ session_id: 'r1', cwd: process.cwd() })
  })

  it('AC-006 maps PreToolUse outcomes to permissions', async () => {
    const [guard] = adaptHooks(specs).permissions
    const permit = (reply: HookResult, toolName = 'Bash') => {
      const s = setup(reply)
      return guard!.permit(call(toolName), run(), s.ctx).then((v) => ({ v, s }))
    }
    expect((await permit(exit(2, '禁止删除\n'))).v).toEqual({ deny: '禁止删除' })
    expect((await permit(exit(2))).v).toEqual({ deny: 'hook 拒绝了 Bash' })
    const asked = await permit(
      ok('', {
        hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: '确认一下' },
      }),
    )
    expect(asked.v).toEqual({
      ask: { summary: '确认一下', risk: 'high', detail: { input: '{"cmd":"ls"}' } },
    })
    expect(
      (
        await permit(
          ok('', {
            hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: '不行' },
          }),
        )
      ).v,
    ).toEqual({ deny: '不行' })
    expect((await permit(ok('', { decision: 'block', reason: '旧格式' }))).v).toEqual({
      deny: '旧格式',
    })
    expect(
      (await permit(ok('', { hookSpecificOutput: { permissionDecision: 'ask' } }))).v,
    ).toMatchObject({ ask: { summary: 'Bash 需要确认' } })
    expect((await permit(ok('', { hookSpecificOutput: { permissionDecision: 'allow' } }))).v).toBe(
      'allow',
    )
    const failed = await permit(exit(1, 'crash'))
    expect(failed.v).toBe('allow')
    expect(failed.s.logs).toEqual(['hook PreToolUse 退出码 1'])
    const timedOut = await permit({ exitCode: null, stdout: '', stderr: '', timedOut: true })
    expect(timedOut.v).toEqual({ deny: 'hook 超时，拒绝 Bash', unavailable: true })
    const killed = await permit({ exitCode: null, stdout: '', stderr: '', timedOut: false })
    expect(killed.v).toEqual({ deny: 'hook 没有正常结束，拒绝 Bash', unavailable: true })
    const other = await permit(exit(2), 'Read')
    expect(other.v).toBe('allow')
    expect(other.s.runner.run).not.toHaveBeenCalled()
    expect((await permit(ok())).s.inputs[0]).toMatchObject({
      tool_name: 'Bash',
      tool_input: { cmd: 'ls' },
    })
  })

  it('denies when the PreToolUse hook cannot be started', async () => {
    const [rule] = adaptHooks([{ event: 'PreToolUse', command: 'x' }]).permissions
    const s = setup(ok())
    s.runner.run = async () => {
      throw new Error('spawn ENOENT')
    }
    expect(await rule!.permit(call('Bash'), run(), s.ctx)).toEqual({
      deny: 'hook 执行失败，拒绝 Bash：spawn ENOENT',
      unavailable: true,
    })
  })

  it('matches and reports MCP tools as mcp__<server>__<tool>', async () => {
    const [rule] = adaptHooks([
      { event: 'PreToolUse', matcher: 'mcp__crm__.*', command: 'x' },
    ]).permissions
    const s = setup(exit(2, 'no'))
    const mcpCall = { ...call('crm__lookup', { id: 1 }), capability: 'mcp:crm' }
    expect(await rule!.permit(mcpCall, run(), s.ctx)).toEqual({ deny: 'no' })
    expect(s.inputs[0]).toMatchObject({ tool_name: 'mcp__crm__lookup' })
    // 非 MCP 能力的同名工具不改名。
    expect(await rule!.permit(call('crm__lookup'), run(), setup(exit(2, 'no')).ctx)).toBe('allow')

    const [guard] = adaptHooks([
      { event: 'PostToolUse', matcher: 'mcp__crm__lookup', command: 'y' },
    ]).guards
    const g = setup(exit(2, '检查结果'))
    const step = obs(1, { toolCalls: [tool({ name: 'crm__lookup', capability: 'mcp:crm' })] })
    expect(await guard!.start(run(), g.ctx).check(step)).toEqual({ warn: { problem: '检查结果' } })
    expect(g.inputs[0]).toMatchObject({ tool_name: 'mcp__crm__lookup' })
  })

  it.each([
    [undefined, 'Anything', true],
    ['', 'Anything', true],
    ['*', 'Anything', true],
    ['Edit|Write', 'Write', true],
    ['Edit|Write', 'WriteFile', false],
    ['mcp__.*', 'mcp__crm__lookup', true],
    ['(', '(', true],
    ['(', 'x', false],
  ])('matcher %s on %s → %s', async (matcher, toolName, hit) => {
    const [rule] = adaptHooks([
      { event: 'PreToolUse', command: 'x', ...(matcher !== undefined ? { matcher } : {}) },
    ]).permissions
    const s = setup(exit(2, 'no'))
    expect(await rule!.permit(call(toolName), run(), s.ctx)).toEqual(hit ? { deny: 'no' } : 'allow')
  })

  it('AC-007 AC-030 turns PostToolUse feedback into a guard warning', async () => {
    const [guard] = adaptHooks(specs).guards
    const replies = [
      exit(2, '格式不对'),
      ok('', { decision: 'block', reason: '缺少测试' }),
      ok('', { hookSpecificOutput: { additionalContext: '记得更新文档' } }),
      ok('fine'),
    ]
    const s = setup(() => replies.shift()!)
    const { check } = guard!.start(run(), s.ctx)
    const step = obs(3, {
      toolCalls: [
        tool({ name: 'edit', inputPreview: '{"path":"a"}', outputPreview: 'ok' }),
        tool({ name: 'edit' }),
        tool({ name: 'edit' }),
        tool({ name: 'edit' }),
      ],
    })
    expect(await check(step)).toEqual({ warn: { problem: '格式不对\n缺少测试\n记得更新文档' } })
    expect(s.inputs[0]).toMatchObject({
      hook_event_name: 'PostToolUse',
      tool_name: 'edit',
      tool_input: { path: 'a' },
      tool_response: 'ok',
    })
    expect(s.inputs[1]).toMatchObject({ tool_input: '', tool_response: '' })
    expect(await guard!.start(run(), setup(ok()).ctx).check(obs(1))).toBeUndefined()
  })

  it('runs PostToolUse only after successful calls, passing complete JSON previews parsed', async () => {
    const [guard] = adaptHooks([{ event: 'PostToolUse', command: 'lint.sh' }]).guards
    const s = setup(ok())
    const step = obs(1, {
      toolCalls: [
        tool({ name: 'edit', ok: false, errorCode: 'TOOL_EXCEPTION' }),
        tool({ name: 'edit', inputPreview: '{"path":"a"}', outputPreview: '{"written":true}' }),
        tool({ name: 'edit', inputPreview: '{"path":"a","text":"abc', outputPreview: 'plain' }),
      ],
    })
    expect(await guard!.start(run(), s.ctx).check(step)).toBeUndefined()
    expect(s.inputs).toHaveLength(2)
    expect(s.inputs[0]).toMatchObject({
      tool_input: { path: 'a' },
      tool_response: { written: true },
    })
    expect(s.inputs[1]).toMatchObject({
      tool_input: '{"path":"a","text":"abc',
      tool_response: 'plain',
    })
  })

  it('AC-030 warns with the stderr of a hook that exits with 2', async () => {
    const [guard] = adaptHooks([{ event: 'PostToolUse', command: 'test.sh' }]).guards
    const s = setup(exit(2, '请先运行测试\n'))
    expect(await guard!.start(run(), s.ctx).check(obs(1, { toolCalls: [tool()] }))).toEqual({
      warn: { problem: '请先运行测试' },
    })
  })

  it('AC-008 gates delivery on the Stop hook', async () => {
    const [stop] = adaptHooks(specs).checks
    const accept = (reply: HookResult) => {
      const s = setup(reply)
      return stop!
        .start(run(), s.ctx)
        .accept(candidate('报告写完了'), { sources: [] })
        .then((v) => ({ v, s }))
    }
    expect((await accept(exit(2, '还没跑测试'))).v).toEqual({
      pass: false,
      issues: ['还没跑测试'],
      hint: '还没跑测试',
    })
    expect((await accept(exit(2))).v).toEqual({
      pass: false,
      issues: ['hook 要求继续'],
      hint: 'hook 要求继续',
    })
    expect((await accept(ok('', { decision: 'block', reason: '缺结论' }))).v).toMatchObject({
      pass: false,
      hint: '缺结论',
    })
    expect((await accept(ok('', { decision: 'block' }))).v).toMatchObject({
      pass: false,
      hint: 'hook 要求继续',
    })
    const passed = await accept(ok())
    expect(passed.v).toEqual({ pass: true })
    expect(passed.s.inputs[0]).toMatchObject({
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_message: '报告写完了',
    })
    expect((await accept(exit(1))).v).toEqual({ pass: true })
  })

  it('runs Stop only for root runs', async () => {
    const [stop] = adaptHooks(specs).checks
    const s = setup(exit(2, 'keep going'))
    expect(
      await stop!.start(run({ parentRunId: 'p1' }), s.ctx).accept(candidate('a'), { sources: [] }),
    ).toEqual({ pass: true })
    expect(s.runner.run).not.toHaveBeenCalled()
  })

  it('marks stop_hook_active after a previous block in the same run', async () => {
    const [stop, child] = adaptHooks(specs).checks
    const replies = [exit(2, '再检查一遍'), ok()]
    const s = setup(() => replies.shift()!)
    const instance = stop!.start(run(), s.ctx)
    expect(await instance.accept(candidate('a'), { sources: [] })).toMatchObject({ pass: false })
    expect(await instance.accept(candidate('b'), { sources: [] })).toEqual({ pass: true })
    expect(s.inputs.map((i) => i.stop_hook_active)).toEqual([false, true])
    // 另一次运行从头算。
    const other = setup(ok())
    await stop!.start(run(), other.ctx).accept(candidate('c'), { sources: [] })
    expect(other.inputs[0]).toMatchObject({ stop_hook_active: false })
    const sub = setup(() => exit(2, 'x'))
    const childInstance = child!.start(run({ parentRunId: 'p1' }), sub.ctx)
    await childInstance.accept(candidate('a'), { sources: [] })
    await childInstance.accept(candidate('b'), { sources: [] })
    expect(sub.inputs.map((i) => i.stop_hook_active)).toEqual([false, true])
  })

  it('AC-009 runs SubagentStop only for child runs', async () => {
    const [, child] = adaptHooks(specs).checks
    const root = setup(exit(2, 'x'))
    expect(await child!.start(run(), root.ctx).accept(candidate('a'), { sources: [] })).toEqual({
      pass: true,
    })
    expect(root.runner.run).not.toHaveBeenCalled()
    const sub = setup(exit(2, '子任务没完成'))
    expect(
      await child!
        .start(run({ parentRunId: 'p1' }), sub.ctx)
        .accept(candidate('a'), { sources: [] }),
    ).toMatchObject({
      pass: false,
      issues: ['子任务没完成'],
    })
    expect(sub.inputs[0]).toMatchObject({ hook_event_name: 'SubagentStop' })
  })

  it('AC-011 records each hook execution as a hook call', async () => {
    const adapted = adaptHooks(specs)
    const s = setup(ok())
    await adapted.permissions[1]!.permit(call('Read'), run(), s.ctx)
    await adapted.notice[0]!.provide(run(), s.ctx)
    expect(s.records).toEqual([
      ['hook:PreToolUse', 'hook'],
      ['hook:SessionStart', 'hook'],
    ])
    expect(s.runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'audit.sh' }),
      expect.anything(),
      { cwd: '/ws' },
    )
  })
})
