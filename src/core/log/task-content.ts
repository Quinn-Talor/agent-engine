// 任务内容（设计 §6.2、BR-005）：运行开始时把任务输入与前文存成一个 blob。其中的图片与文件数据单独存成
// blob，内容里只留 `{ $blob: 引用 }`：会话每一轮都带着前文，同一张图因此只存一份。纯函数：读写 blob 由调用方做。

import type { ModelMessage, Segment } from '../../contracts/common.js'
import type { BlobRef } from '../../contracts/events.js'
import { canonicalJson } from '../definition/hash.js'

export interface TaskContent {
  input: Segment[]
  history: ModelMessage[]
}

export type MediaData = string | Uint8Array

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** 媒体引用的样子；图片与文件的数据只会是字符串或字节，不会和它混淆。 */
const isMediaRef = (v: unknown): v is { $blob: BlobRef } =>
  isObject(v) && !(v instanceof Uint8Array) && typeof v.$blob === 'string'

/**
 * 按固定顺序访问每个媒体字段并换成 `visit` 的返回值：任务输入各段的图片与文件，前文里 user 消息的图片与
 * 文件、工具结果的图片。不是这些位置、不是这个形状的值原样保留。
 */
function mapMedia(content: unknown, visit: (data: unknown) => unknown): unknown {
  if (!isObject(content)) return content
  const part = (p: unknown) => {
    if (!isObject(p)) return p
    if (p.type === 'image') return { ...p, image: visit(p.image) }
    if (p.type === 'file') return { ...p, data: visit(p.data) }
    return p
  }
  const parts = (list: unknown) => (Array.isArray(list) ? list.map(part) : list)
  const input = Array.isArray(content.input)
    ? content.input.map((s) => (isObject(s) ? { ...s, parts: parts(s.parts) } : s))
    : content.input
  const history = Array.isArray(content.history)
    ? content.history.map((m) => {
        if (!isObject(m) || !Array.isArray(m.content)) return m
        if (m.role === 'user') return { ...m, content: parts(m.content) }
        if (m.role !== 'tool') return m
        return {
          ...m,
          content: m.content.map((r) => (isObject(r) ? { ...r, images: parts(r.images) } : r)),
        }
      })
    : content.history
  return { ...content, input, history }
}

/** 内容里的媒体数据，按访问顺序（可能重复）。 */
export function contentMedia(content: TaskContent): MediaData[] {
  const media: MediaData[] = []
  mapMedia(content, (data) => {
    if (typeof data === 'string' || data instanceof Uint8Array) media.push(data)
    return data
  })
  return media
}

/** 媒体换成引用后的规范 JSON；`refs` 与 `contentMedia` 的结果按下标一一对应。 */
export function packContent(content: TaskContent, refs: readonly BlobRef[]): string {
  if (refs.length !== contentMedia(content).length) {
    throw new Error('packContent: 引用个数与媒体个数不一致')
  }
  let i = 0
  return canonicalJson(
    mapMedia(content, (data) =>
      typeof data === 'string' || data instanceof Uint8Array ? { $blob: refs[i++] } : data,
    ),
  )
}

/** 存储的内容（`parseCanonical` 之后）引用的媒体 blob：去重，按首次出现的顺序。 */
export function contentMediaRefs(stored: unknown): BlobRef[] {
  const refs = new Set<BlobRef>()
  mapMedia(stored, (data) => {
    if (isMediaRef(data)) refs.add(data.$blob)
    return data
  })
  return [...refs]
}

/** 引用换回媒体数据；`blobs` 里缺某个引用时抛错。 */
export function unpackContent(
  stored: unknown,
  blobs: ReadonlyMap<BlobRef, MediaData>,
): TaskContent {
  return mapMedia(stored, (data) => {
    if (!isMediaRef(data)) return data
    const media = blobs.get(data.$blob)
    if (media === undefined) throw new Error(`内容引用的媒体 ${data.$blob} 没有读出`)
    return media
  }) as TaskContent
}
