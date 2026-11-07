import { describe, expect, it } from 'vitest'
import { canonicalJson, parseCanonical } from '../definition/hash.js'
import {
  contentMedia,
  contentMediaRefs,
  packContent,
  unpackContent,
  type MediaData,
  type TaskContent,
} from './task-content.js'

const bytes = new Uint8Array([1, 2, 3])
const content: TaskContent = {
  input: [
    {
      role: 'user',
      parts: [
        { type: 'text', text: '看图' },
        { type: 'image', image: 'AQID', mediaType: 'image/png' },
        { type: 'file', data: bytes, mediaType: 'application/pdf', filename: 'a.pdf' },
      ],
    },
  ],
  history: [
    { role: 'user', content: [{ type: 'image', image: 'AQID' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'c', toolName: 's', input: {} }],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c',
          toolName: 's',
          output: 'ok',
          images: [{ type: 'image', image: 'BAUG', mediaType: 'image/png' }],
        },
      ],
    },
    { role: 'user', content: '纯文本' },
  ],
}
const refOf = (data: MediaData) => `sha256:${typeof data === 'string' ? data : 'bytes'}`

describe('task content', () => {
  it('AC-011 lists the media in order, packs them as references and restores them', () => {
    const media = contentMedia(content)
    expect(media).toEqual(['AQID', bytes, 'AQID', 'BAUG'])
    const packed = packContent(content, media.map(refOf))
    expect(packed).not.toMatch(/"(image|data)":"/)
    expect(packed).toContain('{"$blob":"sha256:AQID"}')
    const stored = parseCanonical(packed)
    expect(contentMediaRefs(stored)).toEqual(['sha256:AQID', 'sha256:bytes', 'sha256:BAUG'])
    const blobs = new Map<string, MediaData>([
      ['sha256:AQID', 'AQID'],
      ['sha256:bytes', bytes],
      ['sha256:BAUG', 'BAUG'],
    ])
    const restored = unpackContent(stored, blobs)
    expect(canonicalJson(restored)).toBe(canonicalJson(content))
    expect((restored.input[0]!.parts[2] as { data: unknown }).data).toBeInstanceOf(Uint8Array)
  })

  it('AC-011 leaves content without media as it was', () => {
    const plain: TaskContent = {
      input: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }],
      history: [],
    }
    expect(contentMedia(plain)).toEqual([])
    expect(packContent(plain, [])).toBe(canonicalJson(plain))
    expect(contentMediaRefs(parseCanonical(canonicalJson(plain)))).toEqual([])
  })

  it('AC-011 fails on a missing blob or a reference count that does not match', () => {
    const stored = parseCanonical(packContent(content, contentMedia(content).map(refOf)))
    expect(() => unpackContent(stored, new Map())).toThrow('内容引用的媒体 sha256:AQID 没有读出')
    expect(() => packContent(content, [])).toThrow('引用个数与媒体个数不一致')
  })
})
