import { describe, expect, it } from 'vitest'
import { emptyRunUsage, type RunRetrospective } from '../../api.js'
import { retrospect } from './brief.js'

const retro = (patch: Partial<RunRetrospective> = {}): RunRetrospective => ({
  runId: 'r1',
  end: { status: 'finalized', code: 'failure_streak' },
  timeline: [
    { step: 2, kind: 'signal', source: 'engine:failure-streak', signal: 'warn', detail: '计数 2' },
    { step: 3, kind: 'intervention', intervention: 'hint', source: 'steering' },
    { step: 3, kind: 'signal', source: 'task:policy', signal: 'awaitInput' },
    { step: 4, kind: 'signal', source: 'engine:failure-streak', signal: 'end', detail: '计数 3' },
    { step: 4, kind: 'signal', source: 'engine:silent-progress', signal: 'warn' },
  ],
  steps: [
    {
      step: 1,
      tools: [
        { name: 'search', ok: true },
        { name: 'search', ok: true },
        { name: 'fetch', ok: false, errorCode: 'TOOL_TIMEOUT' },
      ],
    },
    { step: 2, tools: [] },
  ],
  deliveries: [],
  sideEffects: [
    {
      callId: 'c9',
      toolName: 'write',
      capability: 'fs',
      effect: 'side_effect',
      step: 1,
      input: { path: 'a.txt' },
      status: 'executed',
    },
    {
      callId: 'c10',
      toolName: 'send',
      capability: 'mail',
      effect: 'side_effect',
      step: 2,
      input: { to: 'x' },
      status: 'possibly_executed',
    },
  ],
  children: [],
  usage: emptyRunUsage(),
  toolCalls: 3,
  ...patch,
})

describe('retrospect.brief', () => {
  it('AC-035 writes a fixed-format summary with the last signal of each guard', () => {
    expect(retrospect.brief(retro())).toBe(
      [
        '【上次运行的复盘】',
        '结局：finalized（failure_streak）；2 步，3 次工具调用。',
        '试过的做法：',
        '- 第 1 步：search ×2、fetch（失败：TOOL_TIMEOUT）',
        '- 第 2 步：只回复了文本',
        '卡住的地方：',
        '- task:policy（第 3 步，等待输入）',
        '- engine:failure-streak（第 4 步，终止）：计数 3',
        '- engine:silent-progress（第 4 步，告知）',
        '已执行的副作用：',
        '- write {"path":"a.txt"}',
        '- send {"to":"x"}（可能已执行）',
        '接着做时先核实"可能已执行"的操作，不要重复已经完成的副作用。',
      ].join('\n'),
    )
    expect(retrospect.brief(retro())).toBe(retrospect.brief(retro()))
  })

  it('covers unfinished runs without triggers or side effects, keeping the last 10 steps', () => {
    const steps = Array.from({ length: 12 }, (_, i) => ({
      step: i + 1,
      tools: [{ name: 'read', ok: true }],
    }))
    const text = retrospect.brief(retro({ end: undefined, timeline: [], sideEffects: [], steps }))
    expect(text).toContain('结局：未结束；12 步，3 次工具调用。')
    expect(text).toContain('- 没有守卫发出信号')
    expect(text).toContain('已执行的副作用：\n- 无')
    expect(text).not.toContain('第 2 步')
    expect(text).toContain('- 第 3 步：read')
    expect(text).toContain('- 第 12 步：read')
  })
})
