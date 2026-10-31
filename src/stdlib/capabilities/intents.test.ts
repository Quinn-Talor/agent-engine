import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import type { ToolCtx } from '../../contracts/tool.js'
import { intents } from './intents.js'
import { prepareCtx, runInfo } from './prepare.fixture.js'

describe('intents', () => {
  it('AC-004 provides the four intent tools when the principal is reachable', async () => {
    const cap = intents()
    expect(cap).toMatchObject({ id: 'intents', version: '2', kind: 'intents' })
    const prepared = await cap.prepare(prepareCtx())
    expect(prepared.tools.map((t) => [t.name, t.semantics?.intent, t.execution?.effect])).toEqual([
      ['finish', { kind: 'complete', code: 'finish' }, 'none'],
      ['ask_user', { kind: 'await_input', code: 'ask_user' }, 'none'],
      ['propose', { kind: 'await_input', code: 'propose' }, 'none'],
      ['report_blocked', { kind: 'stop', code: 'blocked' }, 'none'],
    ])
    const notes = (prepared.description![0]!.parts[0] as { text: string }).text
    expect(notes).toContain('ask_user')
    expect(notes).toContain('单独调用')
  })

  it('AC-005 drops ask_user and propose when the principal cannot be reached', async () => {
    const prepared = await intents().prepare(prepareCtx({ run: runInfo(false) }))
    expect(prepared.tools.map((t) => t.name)).toEqual(['finish', 'report_blocked'])
    const notes = (prepared.description![0]!.parts[0] as { text: string }).text
    expect(notes).not.toContain('ask_user')
    expect(notes).toContain(
      '- 委托人联系不上，不会回答提问：不要在回答里向委托人提问；缺少关键信息无法继续时，调用 report_blocked 说明缺什么。',
    )
  })

  it('confirms briefly and validates the arguments', async () => {
    const { tools } = await intents().prepare(prepareCtx())
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    const ctx = {} as ToolCtx
    expect(await byName.finish!.execute({ summary: 'done' }, ctx)).toBe('已记录')
    expect(await byName.ask_user!.execute({ question: '?' }, ctx)).toBe('问题已发送给委托人')
    expect(
      await byName.propose!.execute({ summary: 's', actions: [{ tool: 'x', input: {} }] }, ctx),
    ).toBe('提议已发送给委托人')
    expect(await byName.report_blocked!.execute({ reason: 'no access' }, ctx)).toBe('已报告受阻')
    const propose = byName.propose!.inputSchema as ZodType
    expect(propose.safeParse({ summary: 's', actions: [] }).success).toBe(false)
    expect(
      propose.safeParse({ summary: 's', preview: 'p', actions: [{ tool: 'x', input: 1 }] }).success,
    ).toBe(true)
  })

  it('fingerprints the tools it actually provides', async () => {
    const reachable = await intents().prepare(prepareCtx())
    const unreachable = await intents().prepare(prepareCtx({ run: runInfo(false) }))
    expect(reachable.snapshot.fingerprint).not.toBe(unreachable.snapshot.fingerprint)
  })
})
