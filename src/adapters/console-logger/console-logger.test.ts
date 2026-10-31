import { describe, expect, it } from 'vitest'
import { consoleLogger } from './console-logger.js'

function recordingSink() {
  const lines: Array<[string, unknown[]]> = []
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      lines.push([level, args])
  return {
    lines,
    sink: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
  }
}

describe('consoleLogger', () => {
  it('AC-015 filters by level and redacts secrets', () => {
    const { lines, sink } = recordingSink()
    const logger = consoleLogger({ level: 'warn', sink })
    logger.log({ level: 'info', message: 'hidden' })
    logger.log({
      level: 'warn',
      message: 'key sk-abcdefgh1234 leaked',
      runId: 'r1',
      detail: { header: 'Bearer abcdef123456' },
    })
    expect(lines).toEqual([
      [
        'warn',
        [
          '[agent-engine] warn key [REDACTED] leaked',
          { runId: 'r1', detail: { header: 'Bearer [REDACTED]' } },
        ],
      ],
    ])
  })

  it('defaults to info and omits empty context', () => {
    const { lines, sink } = recordingSink()
    const logger = consoleLogger({ sink })
    logger.log({ level: 'debug', message: 'noise' })
    logger.log({ level: 'error', message: 'boom', step: 0, source: 'engine' })
    logger.log({ level: 'info', message: 'plain' })
    expect(lines).toEqual([
      ['error', ['[agent-engine] error boom', { step: 0, source: 'engine' }]],
      ['info', ['[agent-engine] info plain']],
    ])
  })
})
