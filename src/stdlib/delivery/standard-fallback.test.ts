import { describe, expect, it } from 'vitest'
import { FINALIZE_CODES, standardFallback } from './standard-fallback.js'

describe('standardFallback', () => {
  const fallback = standardFallback()

  it('AC-003 covers every finalize code from the design plus a default', () => {
    expect(FINALIZE_CODES).toEqual([
      'repeat',
      'failure_streak',
      'stall',
      'no_progress',
      'max_steps',
      'timeout',
      'empty_output',
      'user_denied',
      'spawn_failed',
      'external_failure',
      'truncated',
    ])
    expect(Object.keys(fallback.instructions).sort()).toEqual([...FINALIZE_CODES, '*'].sort())
  })

  it.each([...FINALIZE_CODES, '*'])('AC-003 has both versions for %s', (code) => {
    const entry = fallback.instructions[code]!
    expect(entry.reachable).toContain('以问号结尾')
    expect(entry.unreachable.length).toBeGreaterThan(0)
    expect(entry.unreachable).not.toContain('问题')
  })

  it('explains the reason before the instruction', () => {
    expect(fallback.instructions.repeat!.unreachable).toBe(
      '运行反复执行相同的操作，没有进展。请报告已经完成的部分、卡点，以及已执行的操作。',
    )
  })

  it('asks for a shorter answer after repeated truncation', () => {
    expect(fallback.instructions.truncated!.unreachable).toBe(
      '回答多次超出长度被截断，请精简篇幅，只写结论和关键依据。请报告已经完成的部分、卡点，以及已执行的操作。',
    )
  })

  it('AC-003 has a fixed text for the last degradation level', () => {
    expect(fallback.fixedText).toBe(
      '任务未能完成，已停止。请查看运行记录了解已完成的部分和已执行的操作。',
    )
  })
})
