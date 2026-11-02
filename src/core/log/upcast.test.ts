import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../../contracts/events.js'
import { upcastEvent } from './upcast.js'

const event: RunEvent = { seq: 1, at: 0, t: 'steer_received', text: 'hi' }

describe('upcastEvent', () => {
  it('AC-003 returns events of the current version unchanged', () => {
    expect(upcastEvent(event, 1)).toBe(event)
  })

  it.each([2, 0])('AC-003 rejects unsupported version %s', (version) => {
    expect(() => upcastEvent(event, version)).toThrow(`不支持的事件版本 ${version}`)
  })
})
