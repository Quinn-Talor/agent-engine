// 稳定哈希：规范化 JSON（键排序、无空白）再取 sha256。指纹、输入哈希、blob 去重共用。

import { createHash } from 'node:crypto'

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function typeName(value: unknown): string {
  if (typeof value !== 'object' || value === null) return typeof value
  return (value as { constructor?: { name?: string } }).constructor?.name ?? 'Object'
}

function unsupported(value: unknown): TypeError {
  return new TypeError(`canonicalJson: unsupported type ${typeName(value)}`)
}

/** 与字节编码同形的键（`$bytes`、`$$bytes`……）多加一个 `$`，普通对象因此不会编码成字节的样子。 */
const BYTES_KEY = /^\$+bytes$/
const escapeKey = (key: string): string => (BYTES_KEY.test(key) ? `$${key}` : key)

/**
 * 确定性序列化：对象键排序，跳过 undefined 属性，字节编码为 `{"$bytes":"<base64>"}`；
 * 普通对象的 `$bytes` 键写成 `$$bytes`，两者不会混淆。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number')
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'object':
      break
    default:
      throw unsupported(value)
  }
  if (value instanceof Uint8Array) {
    return `{"$bytes":"${Buffer.from(value).toString('base64')}"}`
  }
  if (Array.isArray(value)) {
    const items = value.map((item) =>
      item === undefined || typeof item === 'function' ? 'null' : canonicalJson(item),
    )
    return `[${items.join(',')}]`
  }
  if (!isPlainObject(value)) throw unsupported(value)
  const entries: string[] = []
  for (const key of Object.keys(value).sort()) {
    const item = value[key]
    if (item === undefined) continue
    if (typeof item === 'function' || typeof item === 'symbol') throw unsupported(item)
    entries.push(`${JSON.stringify(escapeKey(key))}:${canonicalJson(item)}`)
  }
  return `{${entries.join(',')}}`
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 任意 JSON 值的内容哈希。 */
export function hashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

function normalizeWhitespace(value: unknown): unknown {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ')
  if (Array.isArray(value)) return value.map(normalizeWhitespace)
  if (typeof value === 'object' && value !== null && isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeWhitespace(v)]))
  }
  return value
}

/** 工具输入哈希：键排序、去掉多余空白，再取 sha256（设计 §10.3 匹配）。没有输入按 null 算。 */
export function inputHash(input: unknown): string {
  return hashOf(normalizeWhitespace(input ?? null))
}
