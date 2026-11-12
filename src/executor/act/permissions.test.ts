import { describe, expect, it } from 'vitest'
import type {
  ApprovalAnswer,
  Approver,
  AskRequest,
  ComponentCtx,
  PermissionRule,
  PermitResult,
  RunInfo,
} from '../../contracts/component.js'
import type { ToolCallView } from '../../contracts/tool.js'
import { FakeClock } from '../../testing/fake-clock.js'
import { Mutex } from '../mutex.js'
import { checkPermission, type PermissionDeps } from './permissions.js'

const run: RunInfo = {
  runId: 'r1',
  rootRunId: 'r1',
  environment: { name: 'env', principalReachable: true, approver: false },
  agent: { id: 'a' },
  task: {},
  model: { ref: 'fake:m', contextLimit: 1000 },
}
const call: ToolCallView = {
  callId: 'c1',
  toolName: 'write',
  capability: 'files',
  input: { path: '/x' },
  risk: 'low',
  effect: 'side_effect',
}
const logs: string[] = []
const ctx = {
  log: (_level: string, message: string) => logs.push(message),
} as unknown as ComponentCtx

const rule = (
  id: string,
  result: PermitResult | (() => Promise<PermitResult>),
  mode?: 'shadow',
): PermissionRule => ({
  id,
  version: '1',
  ...(mode ? { mode } : {}),
  permit: typeof result === 'function' ? result : async () => result,
})
const ask = (summary: string, risk: AskRequest['risk'], paths?: string[]): PermitResult => ({
  ask: { summary, risk, detail: { ...(paths ? { paths } : {}), reason: `${summary} reason` } },
})

function deps(patch: Partial<PermissionDeps> = {}): PermissionDeps & { clock: FakeClock } {
  return {
    rules: [],
    principalReachable: true,
    approvalTimeoutMs: 300_000,
    run,
    ctxFor: () => ctx,
    clock: new FakeClock(),
    approvals: new Mutex(),
    ...patch,
  } as PermissionDeps & { clock: FakeClock }
}

const approver = (answer: ApprovalAnswer, seen: unknown[] = []): Approver => ({
  approve: async (req) => {
    seen.push(req)
    return answer
  },
})

describe('checkPermission', () => {
  it('allows without events when there are no rules', async () => {
    expect(await checkPermission(call, deps())).toEqual({ allowed: true, events: [] })
  })

  it('AC-006 denies when any rule denies', async () => {
    const result = await checkPermission(
      call,
      deps({ rules: [rule('a', 'allow'), rule('b', { deny: '敏感路径' })] }),
    )
    expect(result).toMatchObject({
      allowed: false,
      error: { code: 'PERMISSION_DENIED', message: '权限拒绝：敏感路径' },
    })
    expect(result.events).toEqual([
      { t: 'permission_decided', callId: 'c1', verdict: 'allow', source: 'a' },
      { t: 'permission_decided', callId: 'c1', verdict: { deny: '敏感路径' }, source: 'b' },
    ])
  })

  it('AC-007 merges asks into one approval', async () => {
    const seen: unknown[] = []
    const result = await checkPermission(
      call,
      deps({
        rules: [
          rule('a', ask('写文件', 'low', ['/x'])),
          rule('b', ask('高风险', 'high', ['/x', '/y'])),
        ],
        approver: approver({ approved: true, remember: { scope: 'session' } }, seen),
      }),
    )
    expect(seen).toEqual([
      {
        summary: '写文件；高风险',
        risk: 'high',
        detail: { paths: ['/x', '/y'], reason: '写文件 reason；高风险 reason' },
        callId: 'c1',
        toolName: 'write',
      },
    ])
    expect(result.allowed).toBe(true)
    expect(result.events.at(-1)).toEqual({
      t: 'approval_answered',
      callId: 'c1',
      approved: true,
      remember: { scope: 'session' },
      waitedMs: 0,
    })
  })

  it('AC-011 reports a deferred answer as APPROVAL_PENDING and records it', async () => {
    const result = await checkPermission(
      call,
      deps({
        rules: [rule('a', ask('发律师函', 'high'))],
        approver: approver({ defer: '等律师复核' }),
      }),
    )
    expect(result).toMatchObject({ allowed: false, error: { code: 'APPROVAL_PENDING' } })
    expect(result.allowed || result.error.message).toContain('等律师复核')
    expect(result.allowed || result.error.hint).toContain('委托人答复后会接着做')
    expect(result.events.at(-1)).toEqual({
      t: 'approval_answered',
      callId: 'c1',
      approved: false,
      deferred: true,
      waitedMs: 0,
    })
  })

  it('AC-011 does not take an empty deferral as one', async () => {
    const result = await checkPermission(
      call,
      deps({ rules: [rule('a', ask('写文件', 'low'))], approver: approver({ defer: ' ' }) }),
    )
    expect(result).toMatchObject({ allowed: false, error: { code: 'USER_DENIED' } })
    expect(result.events.at(-1)).not.toHaveProperty('deferred')
  })

  it('reports a user rejection as USER_DENIED', async () => {
    const result = await checkPermission(
      call,
      deps({ rules: [rule('a', ask('写文件', 'low'))], approver: approver({ approved: false }) }),
    )
    expect(result).toMatchObject({ allowed: false, error: { code: 'USER_DENIED' } })
    expect(result.allowed || result.error.hint).toContain('不要换工具或换写法')
  })

  it('F24 AC-001 tells the model not to work around a rule that denies', async () => {
    const denied = await checkPermission(call, deps({ rules: [rule('b', { deny: '插件不允许' })] }))
    expect(denied).toMatchObject({ allowed: false, error: { code: 'PERMISSION_DENIED' } })
    expect(denied.allowed || denied.error.hint).toContain('不要换工具或换写法')
    const failing = await checkPermission(
      call,
      deps({ rules: [rule('b', { deny: '出错', unavailable: true })] }),
    )
    expect(failing).toMatchObject({ allowed: false, error: { code: 'PERMISSION_UNAVAILABLE' } })
    expect(failing.allowed || failing.error.hint).toBeUndefined()
  })

  it.each([
    [
      'AC-008 the principal cannot be reached',
      { principalReachable: false, approver: approver({ approved: true }) },
    ],
    ['no approver is configured', {}],
  ])('denies an ask when %s', async (_name, patch) => {
    const result = await checkPermission(
      call,
      deps({ rules: [rule('a', ask('写文件', 'low'))], ...patch }),
    )
    expect(result).toMatchObject({
      allowed: false,
      error: {
        code: 'PERMISSION_DENIED',
        message: '需要委托人审批，但委托人联系不上或没有配置审批',
      },
    })
  })

  it('AC-009 refuses the call when the approval times out, without calling it a user denial', async () => {
    const d = deps({
      rules: [rule('a', ask('写文件', 'low'))],
      approver: { approve: () => new Promise(() => {}) },
    })
    const pending = checkPermission(call, d)
    await d.clock.tick(300_000)
    const result = await pending
    expect(result).toMatchObject({
      allowed: false,
      error: { code: 'APPROVAL_TIMEOUT', message: '委托人没有在时限内回应审批' },
    })
    expect(result.events.at(-1)).toEqual({
      t: 'approval_answered',
      callId: 'c1',
      approved: false,
      waitedMs: 300_000,
    })
  })

  it('refuses the call when the approver fails, as a temporary failure', async () => {
    const result = await checkPermission(
      call,
      deps({
        rules: [rule('a', ask('写文件', 'low'))],
        approver: { approve: async () => Promise.reject(new Error('ui closed')) },
      }),
    )
    expect(result).toMatchObject({
      allowed: false,
      error: { code: 'APPROVAL_UNAVAILABLE', message: '审批出错：ui closed' },
    })
  })

  it('AC-010 records shadow rules without applying them', async () => {
    const result = await checkPermission(
      call,
      deps({ rules: [rule('strict', { deny: 'no' }, 'shadow')] }),
    )
    expect(result).toEqual({
      allowed: true,
      events: [
        { t: 'permission_decided', callId: 'c1', verdict: { deny: 'no' }, source: 'shadow:strict' },
      ],
    })
  })

  it('denies when a rule throws and logs a warning', async () => {
    logs.length = 0
    const result = await checkPermission(
      call,
      deps({
        rules: [
          rule('broken', async () => {
            throw new Error('boom')
          }),
        ],
      }),
    )
    expect(result).toMatchObject({
      allowed: false,
      error: { code: 'PERMISSION_UNAVAILABLE', message: '权限拒绝：权限规则 broken 出错' },
    })
    expect(logs).toEqual(['权限规则 broken 出错'])
  })

  it('denies a malformed result as a temporary failure instead of crashing', async () => {
    const malformed = [undefined, 'deny', {}, { deny: 1 }, { ask: { summary: 's' } }]
    for (const value of malformed) {
      logs.length = 0
      const result = await checkPermission(
        call,
        deps({ rules: [rule('odd', async () => value as unknown as PermitResult)] }),
      )
      expect(result).toMatchObject({
        allowed: false,
        error: { code: 'PERMISSION_UNAVAILABLE', message: '权限拒绝：权限规则 odd 出错' },
      })
      expect(result.events).toEqual([
        expect.objectContaining({ verdict: { deny: '权限规则 odd 出错', unavailable: true } }),
      ])
      expect(logs[0]).toMatch(/^权限规则 odd 出错：返回值不合格：/)
    }
  })

  it('keeps a real denial deterministic when another rule could not decide', async () => {
    const result = await checkPermission(
      call,
      deps({
        rules: [
          rule('hook', { deny: 'hook 超时', unavailable: true }),
          rule('policy', { deny: '禁止写入' }),
        ],
      }),
    )
    expect(result).toMatchObject({
      allowed: false,
      error: { code: 'PERMISSION_DENIED', message: '权限拒绝：禁止写入' },
    })
  })

  it('serialises approvals across calls', async () => {
    const clock = new FakeClock()
    const order: string[] = []
    const slowApprover: Approver = {
      approve: (req) =>
        new Promise((resolve) => {
          order.push(`start ${req.callId}`)
          clock.setTimer(100, () => {
            order.push(`end ${req.callId}`)
            resolve({ approved: true })
          })
        }),
    }
    const d = deps({ clock, rules: [rule('a', ask('写', 'low'))], approver: slowApprover })
    const first = checkPermission(call, d)
    const second = checkPermission({ ...call, callId: 'c2' }, d)
    await clock.tick(200)
    await Promise.all([first, second])
    expect(order).toEqual(['start c1', 'end c1', 'start c2', 'end c2'])
  })

  it('ends a pending approval and the queued ones when the run is aborted', async () => {
    const controller = new AbortController()
    const asked: string[] = []
    const d = deps({
      rules: [rule('a', ask('写', 'low'))],
      approver: { approve: (req) => (asked.push(req.callId), new Promise(() => {})) },
      signal: controller.signal,
    })
    const first = checkPermission(call, d)
    const second = checkPermission({ ...call, callId: 'c2' }, d)
    await d.clock.tick(10)
    controller.abort()
    const results = await Promise.all([first, second])
    expect(d.clock.now()).toBe(10)
    expect(asked).toEqual(['c1'])
    for (const [i, result] of results.entries()) {
      expect(result).toMatchObject({ allowed: false, error: { code: 'TOOL_ABORTED' } })
      expect(result.events.at(-1)).toMatchObject({
        t: 'approval_answered',
        callId: `c${i + 1}`,
        approved: false,
      })
    }
  })
})
