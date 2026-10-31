// 脱敏（设计 §6.2、§6.6）：写入运行日志和诊断日志前替换凭据与敏感模式。

export const REDACTED = '[REDACTED]'

/** 短于此长度的凭据不替换：太短的值会在日志里大面积误伤（凭据一般至少 8 位）。 */
const MIN_SECRET_LENGTH = 8
const SK_KEY = /\bsk-[A-Za-z0-9_-]{8,}/g
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi

export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text
  const ordered = secrets
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
  for (const secret of ordered) {
    out = out.split(secret).join(REDACTED)
    // 先编码成 JSON 再脱敏的文本里，凭据中的引号、反斜杠、换行已被转义，按转义后的形式再替换一次。
    const escaped = JSON.stringify(secret).slice(1, -1)
    if (escaped !== secret) out = out.split(escaped).join(REDACTED)
  }
  return out.replace(SK_KEY, REDACTED).replace(BEARER, `$1 ${REDACTED}`)
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** blob 引用（内容哈希）与 id、哈希、指纹字段不含凭据，原样保留：改写会破坏引用与成对。 */
const BLOB_REF = /^sha256:[0-9a-f]{64}$/
const STRUCTURAL_KEYS = new Set([
  'id',
  'callId',
  'toolCallId',
  'runId',
  'rootRunId',
  'parentRunId',
  'childRunId',
  'childRunIds',
  'fingerprint',
  'inputHash',
  'outputHash',
  'schemaHash',
])

const isIds = (v: unknown): boolean =>
  typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'))

export function redactValue<T>(value: T, secrets: readonly string[] = []): T {
  if (typeof value === 'string') {
    return (BLOB_REF.test(value) ? value : redactText(value, secrets)) as T
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets)) as T
  if (typeof value === 'object' && value !== null && isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        STRUCTURAL_KEYS.has(k) && isIds(v) ? v : redactValue(v, secrets),
      ]),
    ) as T
  }
  return value
}
