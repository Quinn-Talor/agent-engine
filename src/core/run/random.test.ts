import { describe, expect, it } from 'vitest'
import { seededRandom } from './random.js'

describe('seededRandom', () => {
  it('repeats the same sequence for the same seed and stays in [0, 1)', () => {
    const a = seededRandom(7)
    const b = seededRandom(7)
    const xs = Array.from({ length: 50 }, () => a())
    expect(Array.from({ length: 50 }, () => b())).toEqual(xs)
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
    expect(seededRandom(8)()).not.toBe(xs[0])
  })
})
