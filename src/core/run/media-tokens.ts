// 图片与文件的 token 估算（设计 §8.6）。图片按 Claude 的算法（几家厂商里偏高的一个）：长边超过 1568 先等比
// 缩小，像素数 / 750，至少按 Gemini 的单张价 258，最多 1600；读不出尺寸按 1600。文件：文本类按内容估算，
// PDF 每页 3000（找不到页时每 100KB 算一页），其他按 1600。宁可高估：压缩早一点，不会撞上窗口。

import type { FilePart } from '../../contracts/common.js'

const UNKNOWN_TOKENS = 1600
const IMAGE_MAX_TOKENS = 1600
const IMAGE_MIN_TOKENS = 258
const PIXELS_PER_TOKEN = 750
const MAX_LONG_EDGE = 1568
const PDF_PAGE_TOKENS = 3000
const PDF_BYTES_PER_PAGE = 100_000
const TEXT_TYPES =
  /^(?:text\/|application\/(?:json|xml|x-yaml|yaml)$|application\/[\w.+-]*\+(?:json|xml)$)/

/** 按需读字节：base64 只解码要读的那几个字节，不整段解码。 */
interface Bytes {
  length: number
  read(offset: number, n: number): Uint8Array | undefined
}

/** 字节、base64 或 base64 的 data URL；网址与非 base64 的 data URL 读不了，返回 undefined。 */
function bytesOf(data: string | Uint8Array): Bytes | undefined {
  if (typeof data !== 'string') {
    return {
      length: data.length,
      read: (o, n) => (o >= 0 && o + n <= data.length ? data.subarray(o, o + n) : undefined),
    }
  }
  let b64 = data
  if (data.startsWith('data:')) {
    const comma = data.indexOf(',')
    if (comma < 0 || !data.slice(0, comma).endsWith(';base64')) return undefined
    b64 = data.slice(comma + 1)
  } else if (data.includes(':')) {
    return undefined
  }
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  const length = Math.floor((b64.length * 3) / 4) - padding
  return {
    length,
    read(o, n) {
      if (o < 0 || o + n > length) return undefined
      const first = Math.floor(o / 3)
      const chunk = Buffer.from(b64.slice(first * 4, Math.ceil((o + n) / 3) * 4), 'base64')
      const skip = o - first * 3
      return chunk.length >= skip + n ? chunk.subarray(skip, skip + n) : undefined
    },
  }
}

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8)
const le24 = (b: Uint8Array, i: number) => le16(b, i) | (b[i + 2]! << 16)
const be32 = (b: Uint8Array, i: number) => be16(b, i) * 65536 + be16(b, i + 2)
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n))

type Size = { width: number; height: number }

/** JPEG 的尺寸在 SOF 段里：从头按段长逐段跳过（EXIF、ICC 等可能很长），最多看 256 段。 */
function jpegSize(src: Bytes): Size | undefined {
  let at = 2
  for (let i = 0; i < 256; i++) {
    const head = src.read(at, 4)
    if (!head || head[0] !== 0xff) return undefined
    const marker = head[1]!
    // 填充字节，或没有段长的独立标记。
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) return undefined
      at += 2
      continue
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const sof = src.read(at + 5, 4)
      return sof ? { height: be16(sof, 0), width: be16(sof, 2) } : undefined
    }
    at += 2 + be16(head, 2)
  }
  return undefined
}

function imageSize(src: Bytes): Size | undefined {
  const head = src.read(0, 30) ?? src.read(0, Math.min(src.length, 30))
  if (!head) return undefined
  if (head[0] === 0x89 && ascii(head, 1, 3) === 'PNG' && head.length >= 24) {
    return { width: be32(head, 16), height: be32(head, 20) }
  }
  if (ascii(head, 0, 4) === 'GIF8' && head.length >= 10) {
    return { width: le16(head, 6), height: le16(head, 8) }
  }
  if (head[0] === 0xff && head[1] === 0xd8) return jpegSize(src)
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') {
    const chunk = ascii(head, 12, 4)
    if (chunk === 'VP8X' && head.length >= 30) {
      return { width: le24(head, 24) + 1, height: le24(head, 27) + 1 }
    }
    if (chunk === 'VP8 ' && head.length >= 30) {
      return { width: le16(head, 26) & 0x3fff, height: le16(head, 28) & 0x3fff }
    }
    if (chunk === 'VP8L' && head.length >= 25) {
      const bits = le16(head, 21) + le16(head, 23) * 65536
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
  }
  return undefined
}

export function imageTokens(image: string | Uint8Array): number {
  const src = bytesOf(image)
  const size = src && imageSize(src)
  if (!size || size.width <= 0 || size.height <= 0) return UNKNOWN_TOKENS
  const scale = Math.min(1, MAX_LONG_EDGE / Math.max(size.width, size.height))
  const tokens = Math.ceil((size.width * scale * size.height * scale) / PIXELS_PER_TOKEN)
  return Math.min(IMAGE_MAX_TOKENS, Math.max(IMAGE_MIN_TOKENS, tokens))
}

export function fileTokens(file: FilePart, textTokens: (text: string) => number): number {
  const src = bytesOf(file.data)
  if (!src) return UNKNOWN_TOKENS
  const all = src.read(0, src.length)
  if (!all) return UNKNOWN_TOKENS
  const type = file.mediaType.split(';')[0]!.trim().toLowerCase()
  if (TEXT_TYPES.test(type)) return textTokens(new TextDecoder().decode(all))
  if (type === 'application/pdf') {
    const pages = Buffer.from(all)
      .toString('latin1')
      .match(/\/Type\s*\/Page(?![A-Za-z])/g)
    const count = pages?.length ?? Math.max(1, Math.ceil(src.length / PDF_BYTES_PER_PAGE))
    return count * PDF_PAGE_TOKENS
  }
  return UNKNOWN_TOKENS
}
