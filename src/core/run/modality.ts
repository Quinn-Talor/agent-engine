// 输入的模态（设计 §1.8、§2）：mediaType 归为文本或某个模态。文本所有模型都接收；图片、PDF、音频、
// 视频要模型声明了才发。媒体上限在定义期校验，工具结果里的图片用同一个单张上限。

import type { Modality } from '../../contracts/model.js'

export const MODALITIES: readonly Modality[] = ['image', 'pdf', 'audio', 'video']
/** 单张图片的字节上限。 */
export const MAX_IMAGE_BYTES = 5_242_880
/** 单个文件的字节上限：各厂商 PDF 上限里偏低的一档。 */
export const MAX_FILE_BYTES = 33_554_432
/** 一个定义里图片与文件合计的个数上限。 */
export const MAX_MEDIA_PARTS = 20

const TEXT_TYPES =
  /^(?:text\/|application\/(?:json|xml|x-yaml|yaml)$|application\/[\w.+-]*\+(?:json|xml)$)/

const isType = (t: string, top: string) => t === top || t.startsWith(`${top}/`)

/** mediaType 归类：文本、某个模态，或归不了（不支持的类型）。 */
export function modalityOf(mediaType: string): 'text' | Modality | undefined {
  const t = mediaType.split(';')[0]!.trim().toLowerCase()
  if (TEXT_TYPES.test(t)) return 'text'
  if (isType(t, 'image')) return 'image'
  if (t === 'application/pdf') return 'pdf'
  if (isType(t, 'audio')) return 'audio'
  if (isType(t, 'video')) return 'video'
  return undefined
}
