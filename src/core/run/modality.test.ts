import { describe, expect, it } from 'vitest'
import { mediaByteLength } from './media-tokens.js'
import { modalityOf } from './modality.js'

describe('modalityOf', () => {
  it.each([
    ['text/markdown', 'text'],
    ['application/json; charset=utf-8', 'text'],
    ['image/png', 'image'],
    ['image', 'image'],
    ['IMAGE/PNG', 'image'],
    ['application/pdf', 'pdf'],
    ['audio/mpeg', 'audio'],
    ['audio', 'audio'],
    ['video/mp4', 'video'],
    ['application/zip', undefined],
    ['', undefined],
  ])('AC-001 %s → %s', (mediaType, expected) => {
    expect(modalityOf(mediaType)).toBe(expected)
  })
})

describe('mediaByteLength', () => {
  it.each([
    ['bytes', new Uint8Array(7), 7],
    ['base64', Buffer.alloc(10).toString('base64'), 10],
    ['a base64 data URL', `data:image/png;base64,${Buffer.alloc(5).toString('base64')}`, 5],
    ['a URL', 'https://example.com/a.png', undefined],
    ['a data URL that is not base64', 'data:text/plain,hello', undefined],
  ])('AC-001 reads the size of %s', (_name, data, expected) => {
    expect(mediaByteLength(data)).toBe(expected)
  })
})
