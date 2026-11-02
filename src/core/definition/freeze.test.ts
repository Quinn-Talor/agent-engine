import { describe, expect, it } from 'vitest'
import { copyData, freezeData, freezeList } from './freeze.js'

describe('freezeData', () => {
  it('freezes plain objects and arrays at every level and returns the same reference', () => {
    const value = { a: [{ b: 1 }], c: { d: 'x' } }
    expect(freezeData(value)).toBe(value)
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.a)).toBe(true)
    expect(Object.isFrozen(value.a[0])).toBe(true)
    expect(Object.isFrozen(value.c)).toBe(true)
    expect(() => {
      ;(value.a as unknown[]).push(2)
    }).toThrow(TypeError)
  })

  it('leaves functions, binary data and class instances alone', () => {
    const fn = () => 1
    const bytes = new Uint8Array([1, 2])
    const date = new Date(0)
    const value = { fn, bytes, date }
    freezeData(value)
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(fn)).toBe(false)
    expect(Object.isFrozen(bytes)).toBe(false)
    expect(Object.isFrozen(date)).toBe(false)
  })

  it('handles cycles and primitives', () => {
    const value: Record<string, unknown> = {}
    value.self = value
    expect(freezeData(value)).toBe(value)
    expect(freezeData(3)).toBe(3)
    expect(freezeData(undefined)).toBeUndefined()
  })
})

describe('copyData', () => {
  it('copies plain objects and arrays so later changes to the original do not leak', () => {
    const original = { list: [{ text: 'a' }], nested: { n: 1 } }
    const copy = copyData(original)
    original.list.push({ text: 'b' })
    original.nested.n = 2
    expect(copy).toEqual({ list: [{ text: 'a' }], nested: { n: 1 } })
  })

  it('keeps binary data and functions by reference', () => {
    const bytes = new Uint8Array([1])
    const fn = () => 1
    const copy = copyData({ bytes, fn })
    expect(copy.bytes).toBe(bytes)
    expect(copy.fn).toBe(fn)
  })
})

describe('freezeList', () => {
  it('copies the list one level and freezes it, keeping the items', () => {
    const item = { id: 'g' }
    const list = [item]
    const frozen = freezeList(list)!
    list.push({ id: 'h' })
    expect(frozen).toEqual([{ id: 'g' }])
    expect(frozen[0]).toBe(item)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(item)).toBe(false)
    expect(freezeList(undefined)).toBeUndefined()
  })
})
