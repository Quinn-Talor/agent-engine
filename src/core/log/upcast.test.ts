import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, type RunEvent } from '../../contracts/events.js'
import { modelFingerprint } from '../definition/fingerprint.js'
import { runEnded, runStarted, sequence } from './events.fixture.js'
import { upcastEvent } from './upcast.js'

const event: RunEvent = { seq: 1, at: 0, t: 'steer_received', text: 'hi' }

describe('upcastEvent', () => {
  it('AC-003 returns events of the current version unchanged', () => {
    expect(SCHEMA_VERSION).toBe(2)
    expect(upcastEvent(event, SCHEMA_VERSION)).toBe(event)
  })

  it.each([3, 0])('AC-003 rejects unsupported version %s', (version) => {
    expect(() => upcastEvent(event, version)).toThrow(`不支持的事件版本 ${version}`)
  })

  it('AC-023 fills the fields version 2 made required into version 1 events', () => {
    const [started, ended] = sequence([runStarted(), runEnded()])
    const { modelFingerprint: _dropped, ...oldStarted } = started as Extract<
      RunEvent,
      { t: 'run_started' }
    >
    const oldEnded = structuredClone(ended) as Extract<RunEvent, { t: 'run_ended' }>
    delete (oldEnded.result.usage as { tools?: unknown }).tools
    expect(upcastEvent(oldStarted as RunEvent, 1)).toMatchObject({
      t: 'run_started',
      modelFingerprint: modelFingerprint(undefined),
    })
    expect(upcastEvent(oldEnded, 1)).toMatchObject({
      result: { usage: { tools: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } },
    })
    expect(upcastEvent(event, 1)).toEqual(event)
  })
})
