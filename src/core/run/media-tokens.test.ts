import { describe, expect, it } from 'vitest'
import { fileTokens, imageTokens } from './media-tokens.js'

const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const u16be = (n: number) => [(n >>> 8) & 255, n & 255]
const u16le = (n: number) => [n & 255, (n >>> 8) & 255]
const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

const png = (w: number, h: number) =>
  new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...u32be(13),
    ...ascii('IHDR'),
    ...u32be(w),
    ...u32be(h),
    8,
    6,
    0,
    0,
    0,
  ])
const gif = (w: number, h: number) => new Uint8Array([...ascii('GIF89a'), ...u16le(w), ...u16le(h)])
/** 尺寸前面先放一段 1000 字节的 APP1（EXIF 一类），要按段长跳过才读得到 SOF。 */
const jpeg = (w: number, h: number) =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    ...u16be(1002),
    ...new Array<number>(1000).fill(0),
    0xff,
    0xc0,
    ...u16be(17),
    8,
    ...u16be(h),
    ...u16be(w),
    3,
  ])
const webpVp8x = (w: number, h: number) =>
  new Uint8Array([
    ...ascii('RIFF'),
    ...u32be(0),
    ...ascii('WEBPVP8X'),
    ...u32be(10),
    0,
    0,
    0,
    0,
    ...u24le(w - 1),
    ...u24le(h - 1),
  ])
const webpVp8 = (w: number, h: number) =>
  new Uint8Array([
    ...ascii('RIFF'),
    ...u32be(0),
    ...ascii('WEBPVP8 '),
    ...u32be(10),
    ...[0, 0, 0, 0x9d, 0x01, 0x2a],
    ...u16le(w),
    ...u16le(h),
  ])
const webpLossless = (w: number, h: number) => {
  const bits = (w - 1) | ((h - 1) << 14)
  return new Uint8Array([
    ...ascii('RIFF'),
    ...u32be(0),
    ...ascii('WEBPVP8L'),
    ...u32be(5),
    0x2f,
    bits & 255,
    (bits >>> 8) & 255,
    (bits >>> 16) & 255,
    (bits >>> 24) & 255,
  ])
}
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

describe('imageTokens', () => {
  it.each([
    ['PNG 1000×1000: pixels / 750', png(1000, 1000), 1334],
    ['JPEG with a segment before the size', jpeg(1200, 900), 1440],
    ['WebP extended', webpVp8x(800, 600), 640],
    ['WebP lossy', webpVp8(900, 600), 720],
    ['WebP lossless', webpLossless(600, 600), 480],
    ['a small image counts at least 258', gif(100, 100), 258],
    ['a long edge over 1568 is scaled down first', png(3136, 300), 314],
    ['a large image counts at most 1600', png(4000, 3000), 1600],
  ])('%s', (_name, bytes, expected) => {
    expect(imageTokens(bytes)).toBe(expected)
  })

  it('reads base64 and data URLs the same as bytes', () => {
    const bytes = jpeg(1200, 900)
    expect(imageTokens(base64(bytes))).toBe(1440)
    expect(imageTokens(`data:image/jpeg;base64,${base64(bytes)}`)).toBe(1440)
  })

  it.each([
    ['a URL', 'https://example.com/a.png'],
    ['an unknown format', base64(new Uint8Array(64).fill(7))],
    ['a cut-off header', base64(png(10, 10).subarray(0, 18))],
    ['a JPEG without a size segment', base64(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))],
    ['a data URL that is not base64', 'data:image/svg+xml,%3Csvg%3E'],
  ])('counts %s as 1600', (_name, image) => {
    expect(imageTokens(image)).toBe(1600)
  })
})

describe('fileTokens', () => {
  const text = (s: string) => s.length
  const pdf = (body: string) => Buffer.from(`%PDF-1.4\n${body}`).toString('base64')

  it('counts a text file by its content', () => {
    const data = Buffer.from('hello').toString('base64')
    expect(fileTokens({ type: 'file', data, mediaType: 'text/plain' }, text)).toBe(5)
    expect(
      fileTokens(
        { type: 'file', data: new TextEncoder().encode('{"a":1}'), mediaType: 'application/json' },
        text,
      ),
    ).toBe(7)
  })

  it('counts a PDF at 3000 per page', () => {
    const body = '<< /Type /Pages /Count 2 >> << /Type /Page >> << /Type/Page /Parent 1 0 R >>'
    expect(fileTokens({ type: 'file', data: pdf(body), mediaType: 'application/pdf' }, text)).toBe(
      6000,
    )
  })

  it('counts a PDF whose pages cannot be found as one page per 100KB', () => {
    const data = pdf('x'.repeat(250_000))
    expect(fileTokens({ type: 'file', data, mediaType: 'application/pdf' }, text)).toBe(9000)
  })

  it.each([
    ['a URL', { data: 'https://example.com/a.pdf', mediaType: 'application/pdf' }],
    ['another media type', { data: 'AAAA', mediaType: 'audio/mpeg' }],
  ])('counts %s as 1600', (_name, part) => {
    expect(fileTokens({ type: 'file', ...part }, text)).toBe(1600)
  })
})
