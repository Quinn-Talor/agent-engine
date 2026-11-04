// 审批稍后答复（设计 §9.10）：这一轮以 approval_pending 结束，调用不执行；应用记下批准，
// 下一轮模型再次发起同一调用时审批人直接放行。引擎不代为执行（I15）。

import { describe, expect, it } from 'vitest'
import {
  createEngine,
  defineAgent,
  defineTask,
  memoryArchive,
  modelHub,
  subagent,
  tools,
  type ApprovalAnswer,
  type Approver,
  type ArchiveStore,
  type PermissionRule,
  type RunEvent,
} from '../../../src/index.js'
import { fakeModel, fakeTool, sessionLogIssues, type FakeReply } from '../../../src/testing.js'

const quiet = { log: () => {} }
const sys = { role: 'system' as const, parts: [{ type: 'text' as const, text: '你是律师助理' }] }
const ask = (text: string) =>
  defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text }] }] })
const letter = { toolCalls: [{ id: 'm1', name: 'send', input: { to: '星河科技' } }] }

/** 发函要审批。 */
const needsApproval: PermissionRule = {
  id: 'letters',
  version: '1',
  permit: async (call) =>
    call.toolName === 'send'
      ? { ask: { summary: `发函给 ${JSON.stringify(call.input)}`, risk: 'high' } }
      : 'allow',
}

/** 应用的审批人：按"会话 + 工具 + 输入"查一张表；没有记录时稍后答复并记下待审批。 */
function deskApprover() {
  const decisions = new Map<string, boolean>()
  const pending: string[] = []
  const keyOf = (subject: string | undefined, tool: string, input: string | undefined) =>
    `${subject}|${tool}|${input}`
  const approver: Approver = {
    approve: async (req, run): Promise<ApprovalAnswer> => {
      const key = keyOf(run.task.subject, req.toolName, req.summary)
      const decided = decisions.get(key)
      if (decided !== undefined) return { approved: decided }
      pending.push(key)
      return { defer: '等律师复核' }
    },
  }
  return { approver, pending, approve: (key: string) => decisions.set(key, true) }
}

const read = async (archive: ArchiveStore, runId: string) => {
  const out: RunEvent[] = []
  for await (const e of archive.read(runId)) out.push(e)
  return out
}

function setup(replies: FakeReply[]) {
  const model = fakeModel({ model: 'main', replies })
  const archive = memoryArchive()
  const desk = deskApprover()
  const engine = createEngine({
    services: {
      models: modelHub({ providers: [model], default: model.ref }),
      archive,
      logger: quiet,
    },
  })
  const env = engine.environment({
    name: 'firm',
    principal: { reachable: true, approver: desk.approver },
    permissions: [needsApproval],
  })
  return { model, archive, desk, env, engine }
}

describe('deferred approval', () => {
  it('AC-011 ends the run waiting for the approval without running the call', async () => {
    const send = fakeTool({ name: 'send', effect: 'side_effect', result: '已发出' })
    const { archive, env } = setup([letter, { text: '不会走到这里' }])
    const agent = defineAgent({ id: 'clerk', instructions: [sys], capabilities: [tools([send])] })
    const run = env.start(agent, ask('给星河科技发律师函'))
    expect(await run.result).toMatchObject({ status: 'awaiting_input', code: 'approval_pending' })
    expect(send.calls).toHaveLength(0)
    const events = await read(archive, run.runId)
    expect(events.find((e) => e.t === 'approval_answered')).toMatchObject({
      approved: false,
      deferred: true,
    })
    expect(events.find((e) => e.t === 'tool_finished')).toMatchObject({
      errorCode: 'APPROVAL_PENDING',
    })
  })

  it('AC-013 runs the call once in the next turn after the app records the approval', async () => {
    const send = fakeTool({ name: 'send', effect: 'side_effect', result: '已发出' })
    const { archive, env, desk, engine, model } = setup([letter, letter, { text: '函已发出' }])
    const agent = defineAgent({ id: 'clerk', instructions: [sys], capabilities: [tools([send])] })
    const first = env.start(agent, ask('给星河科技发律师函'), { session: 'case-7' })
    expect(await first.result).toMatchObject({ code: 'approval_pending' })
    expect(desk.pending).toHaveLength(1)
    desk.approve(desk.pending[0]!)

    const second = env.start(agent, ask('律师批准了，发吧'), { session: 'case-7' })
    expect(await second.result).toMatchObject({ status: 'completed', text: '函已发出' })
    expect(send.calls).toHaveLength(1)

    // 第 2 轮带入的窗口里，第 1 轮的调用与待审批的结果成对；第 1 轮没有执行任何副作用。
    const started = (await read(archive, second.runId)).find((e) => e.t === 'run_started')
    expect(started?.t === 'run_started' && started.session?.window.ledger).toEqual([])
    expect(JSON.stringify(model.inputs[1]!.messages)).toContain('APPROVAL_PENDING')
    const preview = await engine.previewWindow({ session: 'case-7' })
    expect(preview.ok && preview.ledger).toEqual([
      { turn: 2, tool: 'send', input: '{"to":"星河科技"}', status: 'executed' },
    ])
    const answers = (await read(archive, second.runId)).filter((e) => e.t === 'approval_answered')
    expect(answers).toEqual([expect.objectContaining({ approved: true })])
    expect(await sessionLogIssues(archive, 'case-7')).toEqual([])
  })

  it('AC-014 ends the parent waiting when its child is waiting for an approval', async () => {
    const send = fakeTool({ name: 'send', effect: 'side_effect', result: '已发出' })
    const clerk = defineAgent({ id: 'clerk', instructions: [sys], capabilities: [tools([send])] })
    const lead = defineAgent({ id: 'lead', instructions: [sys], capabilities: [subagent(clerk)] })
    const { env } = setup([
      {
        toolCalls: [
          { id: 'd1', name: 'delegate', input: { agent: 'clerk', task: '发函给星河科技' } },
        ],
      },
      letter,
      { text: '不会走到这里' },
    ])
    const run = env.start(lead, ask('发律师函'))
    expect(await run.result).toMatchObject({ status: 'awaiting_input', code: 'approval_pending' })
    expect(send.calls).toHaveLength(0)
  })
})
