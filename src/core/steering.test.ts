import { describe, expect, it } from 'vitest'
import type { CallBlock } from '../contracts/component.js'
import { MAX_STEERING_CHARS, renderFinding, renderSteering } from './steering.js'

const block = (tool: string, reason = '已失败 2 次（TOOL_TIMEOUT）'): CallBlock => ({
  tool,
  inputHash: `h-${tool}`,
  code: 'failure_streak',
  reason,
})

describe('renderFinding', () => {
  it('renders the problem, the detail and the suggestion', () => {
    expect(renderFinding({ problem: '连续 2 步失败', suggest: '换个做法' }, '计数 2')).toBe(
      '- 连续 2 步失败（计数 2）\n  建议：换个做法',
    )
    expect(renderFinding({ problem: '连续 2 步失败' })).toBe('- 连续 2 步失败')
  })

  it('caps one finding at 400 characters so one guard cannot crowd out the others', () => {
    const text = renderFinding({ problem: 'p'.repeat(1000), suggest: '换个做法' })
    expect(text).toHaveLength(400)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('renderSteering', () => {
  it('AC-016 renders goal, findings, blocks, budget, the reflection request and the exits in order', () => {
    const text = renderSteering({
      step: 3,
      goal: '订一张去东京的机票',
      findings: ['- 连续 2 步工具调用全部失败\n  建议：换一种做法'],
      blocks: [block('fetch')],
      stepsLeft: 7,
      timeLeftMs: 30_500,
      askTool: 'ask_user',
      stopTool: 'report_blocked',
    })
    expect(text.split('\n')).toEqual([
      '[纠偏 · 第 3 步]',
      '目标：订一张去东京的机票',
      '发现：',
      '- 连续 2 步工具调用全部失败',
      '  建议：换一种做法',
      '已封住（再调用将收尾）：',
      '- fetch：已失败 2 次（TOOL_TIMEOUT）',
      '剩余：步数 7，时间 30 秒',
      '继续之前，请先用一两句话写明：已经确认了什么、还缺什么、下一步打算怎么做。',
      '出口：现有信息已经足够就直接给出结果；缺少关键信息可以用 ask_user 询问委托人；确实无法完成，用 report_blocked 说明原因。',
    ])
  })

  it('AC-017 leaves out the goal, blocks, time and missing exits', () => {
    const text = renderSteering({ step: 1, findings: ['- 问题'], blocks: [], stepsLeft: 5 })
    expect(text.split('\n')).toEqual([
      '[纠偏 · 第 1 步]',
      '发现：',
      '- 问题',
      '剩余：步数 5',
      '继续之前，请先用一两句话写明：已经确认了什么、还缺什么、下一步打算怎么做。',
      '出口：现有信息已经足够就直接给出结果。',
    ])
    const noBudget = renderSteering({ step: 1, findings: [], blocks: [], timeLeftMs: 0 })
    expect(noBudget).not.toContain('剩余')
    const late = renderSteering({ step: 1, findings: [], blocks: [], stepsLeft: 2, timeLeftMs: 0 })
    expect(late).toContain('剩余：步数 2\n')
  })

  it('puts each block next to its own suggestion', () => {
    const lines = renderSteering({
      step: 2,
      findings: ['- 1 个调用不会再有不同结果，已封住'],
      blocks: [
        { ...block('fetch'), suggest: '改用其他工具' },
        block('read', '连续 2 次返回相同结果'),
      ],
    }).split('\n')
    const start = lines.indexOf('已封住（再调用将收尾）：')
    expect(lines.slice(start + 1, start + 3)).toEqual([
      '- fetch：已失败 2 次（TOOL_TIMEOUT）；建议：改用其他工具',
      '- read：连续 2 次返回相同结果',
    ])
  })

  it('AC-017 lists at most 5 blocks and trims long reasons', () => {
    const blocks = Array.from({ length: 7 }, (_, i) => block(`t${i}`, 'x'.repeat(100)))
    const lines = renderSteering({ step: 2, findings: [], blocks }).split('\n')
    const start = lines.indexOf('已封住（再调用将收尾）：')
    expect(lines.slice(start + 1, start + 7)).toEqual([
      ...[0, 1, 2, 3, 4].map((i) => `- t${i}：${'x'.repeat(80)}`),
      '- 另有 2 个',
    ])
  })

  it('AC-017 caps the whole message at 2000 characters and keeps the budget, reflection and exits', () => {
    const blocks = Array.from({ length: 5 }, (_, i) =>
      block(`mcp__crm_server_with_a_long_name__lookup_customer_records_${i}`, 'r'.repeat(80)),
    )
    const text = renderSteering({
      step: 9,
      goal: 'g'.repeat(200),
      findings: ['y'.repeat(1200), 'z'.repeat(500)],
      blocks,
      stepsLeft: 3,
      askTool: 'ask_user',
    })
    expect(text.length).toBeLessThanOrEqual(MAX_STEERING_CHARS)
    expect(text.startsWith('[纠偏 · 第 9 步]')).toBe(true)
    const lines = text.split('\n')
    expect(lines.slice(-3)).toEqual([
      '剩余：步数 3',
      '继续之前，请先用一两句话写明：已经确认了什么、还缺什么、下一步打算怎么做。',
      '出口：现有信息已经足够就直接给出结果；缺少关键信息可以用 ask_user 询问委托人。',
    ])
    expect(lines.at(-4)!.endsWith('…')).toBe(true)
  })

  it('trims the goal to 200 characters', () => {
    const text = renderSteering({ step: 1, goal: 'g'.repeat(300), findings: [], blocks: [] })
    expect(text.split('\n')[1]).toBe(`目标：${'g'.repeat(200)}`)
  })
})
