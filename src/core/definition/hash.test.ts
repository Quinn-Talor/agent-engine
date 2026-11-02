import { describe, expect, it } from 'vitest'
import { canonicalJson, hashOf, inputHash, sha256Hex } from './hash.js'

describe('canonicalJson', () => {
  it.each([
    ['sorts object keys', { b: 1, a: [2, 1] }, '{"a":[2,1],"b":1}'],
    ['ignores key insertion order', { a: [2, 1], b: 1 }, '{"a":[2,1],"b":1}'],
    ['drops undefined properties', { a: undefined, b: 1 }, '{"b":1}'],
    ['encodes bytes as base64', new Uint8Array([1, 2]), '{"$bytes":"AQI="}'],
    ['writes undefined array items as null', [undefined, 1], '[null,1]'],
    ['accepts null-prototype objects', Object.assign(Object.create(null), { a: 1 }), '{"a":1}'],
    ['writes empty objects', {}, '{}'],
    ['writes primitives', [null, true, 'x', 1.5], '[null,true,"x",1.5]'],
  ])('AC-004 %s', (_name, value, expected) => {
    expect(canonicalJson(value)).toBe(expected)
  })

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['Map', new Map()],
    ['Date', new Date(0)],
    ['object holding a function', { f() {} }],
    ['bigint', 10n],
    ['symbol', Symbol('s')],
  ])('AC-004 rejects %s', (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError)
  })

  it('AC-004 never encodes bytes like an object with the same keys', () => {
    expect(canonicalJson(new Uint8Array([1]))).not.toBe(canonicalJson({ $bytes: 'AQ==' }))
    expect(hashOf(new Uint8Array([1]))).not.toBe(hashOf({ $bytes: 'AQ==' }))
    expect(canonicalJson({ $bytes: 'AQ==', $$bytes: 1, $ref: 'x' })).toBe(
      '{"$$$bytes":1,"$$bytes":"AQ==","$ref":"x"}',
    )
  })

  it('names the unsupported type in the error', () => {
    expect(() => canonicalJson(new Map())).toThrow('unsupported type Map')
  })
})

describe('hashes', () => {
  it('sha256Hex hashes strings and bytes identically for the same content', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'))
  })

  it('hashOf is insensitive to key order', () => {
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }))
  })

  it('AC-005 inputHash normalises whitespace inside strings', () => {
    const a = inputHash({ b: 1, a: '  x   y ' })
    const b = inputHash({ a: 'x y', b: 1 })
    const c = inputHash({ a: 'xy', b: 1 })
    expect(a).toBe(b)
    expect(c).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('inputHash normalises nested arrays', () => {
    expect(inputHash({ q: [' a ', { r: 'b\n c' }] })).toBe(inputHash({ q: ['a', { r: 'b c' }] }))
  })

  it('inputHash treats a missing input as null', () => {
    expect(inputHash(undefined)).toBe(inputHash(null))
  })
})
