import { APICallError, NoOutputGeneratedError, RetryError } from 'ai'
import { describe, expect, it } from 'vitest'
import { classifyError } from './errors.js'

const api = (
  statusCode: number,
  message = 'failed',
  extra: { responseBody?: string; isRetryable?: boolean } = {},
) => new APICallError({ message, url: 'https://x', requestBodyValues: {}, statusCode, ...extra })
const attempts = [{ startedAt: 1, durationMs: 2, error: 'x' }]

describe('classifyError', () => {
  it.each([
    ['401', api(401, 'bad key'), 'AUTH_FAILED', false],
    ['403', api(403), 'AUTH_FAILED', false],
    ['429', api(429), 'RATE_LIMITED', true],
    ['408', api(408), 'MODEL_TIMEOUT', true],
    ['413 too long', api(413, 'prompt is too long: 210000 tokens'), 'CONTEXT_TOO_LONG', false],
    [
      '400 context in body',
      api(400, 'invalid', { responseBody: '{"error":"maximum context length is 128000"}' }),
      'CONTEXT_TOO_LONG',
      false,
    ],
    ['400 policy', api(400, 'blocked by content policy'), 'CONTENT_FILTER', false],
    ['503', api(503), 'MODEL_ERROR', true],
    ['400 other', api(400, 'bad request', { isRetryable: false }), 'MODEL_ERROR', false],
  ])('AC-005 classifies an API error %s', (_name, error, code, retryable) => {
    const d = classifyError(error, attempts)
    expect(d).toMatchObject({ code, retryable, status: error.statusCode, attempts })
  })

  it.each([
    ['fetch failed', new TypeError('fetch failed'), 'MODEL_CONNECTION', true],
    ['ECONNRESET', new Error('read ECONNRESET'), 'MODEL_CONNECTION', true],
    ['timeout', new Error('request timed out'), 'MODEL_TIMEOUT', true],
    ['context', new Error('input is too long for this model'), 'CONTEXT_TOO_LONG', false],
    ['other', new Error('weird'), 'MODEL_ERROR', false],
    ['not an error', 'boom', 'MODEL_ERROR', false],
  ])('AC-005 classifies %s', (_name, error, code, retryable) => {
    const d = classifyError(error, [])
    expect(d).toMatchObject({ code, retryable, attempts: [] })
    expect(d).not.toHaveProperty('status')
  })

  // provider-utils 的 handleFetchError 把建连失败、DNS、undici 超时包成没有状态码、可重试的 APICallError。
  const coded = (message: string, code: string) => Object.assign(new Error(message), { code })
  const unreachable = (cause: Error) =>
    new APICallError({
      message: `Cannot connect to API: ${cause.message}`,
      cause,
      url: 'https://x',
      requestBodyValues: {},
      isRetryable: true,
    })

  it.each([
    [
      'ECONNREFUSED',
      coded('connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED'),
      'MODEL_CONNECTION',
    ],
    ['DNS', coded('getaddrinfo ENOTFOUND api.x', 'ENOTFOUND'), 'MODEL_CONNECTION'],
    ['socket closed', coded('other side closed', 'UND_ERR_SOCKET'), 'MODEL_CONNECTION'],
    ['connect timeout', coded('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT'), 'MODEL_TIMEOUT'],
    ['headers timeout', coded('Headers Timeout Error', 'UND_ERR_HEADERS_TIMEOUT'), 'MODEL_TIMEOUT'],
    ['unknown cause', new Error('weird'), 'MODEL_CONNECTION'],
  ])('classifies a network failure wrapped in APICallError: %s', (_name, cause, code) => {
    const error = unreachable(cause)
    expect(classifyError(error, [])).toMatchObject({ code, retryable: true })
    expect(classifyError(error, [])).not.toHaveProperty('status')
    const retried = new RetryError({
      message: 'gave up',
      reason: 'maxRetriesExceeded',
      errors: [error, error, error],
    })
    expect(classifyError(retried, [])).toMatchObject({ code, retryable: true })
  })

  it('classifies a mid-stream socket drop as a retryable connection error', () => {
    const dropped = new TypeError('terminated', {
      cause: coded('other side closed', 'UND_ERR_SOCKET'),
    })
    expect(classifyError(dropped, [])).toMatchObject({
      code: 'MODEL_CONNECTION',
      retryable: true,
    })
  })

  it('keeps a status-less, non-retryable APICallError as MODEL_ERROR', () => {
    const odd = new APICallError({ message: 'odd', url: 'https://x', requestBodyValues: {} })
    expect(classifyError(odd, [])).toMatchObject({ code: 'MODEL_ERROR', retryable: false })
  })

  it.each([
    [
      'Anthropic',
      'input length and `max_tokens` exceed context limit: 195000 + 8192 > 200000, decrease input length or `max_tokens` and try again',
    ],
    [
      'Gemini',
      'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
    ],
    ['OpenAI', "This model's maximum context length is 128000 tokens."],
  ])('recognises a %s context overflow', (_vendor, message) => {
    expect(classifyError(api(400, message), [])).toMatchObject({
      code: 'CONTEXT_TOO_LONG',
      retryable: false,
    })
    expect(
      classifyError(api(400, 'invalid', { responseBody: JSON.stringify({ message }) }), []),
    ).toMatchObject({ code: 'CONTEXT_TOO_LONG' })
  })

  it.each([
    ['OpenAI safety system', 'Your request was rejected as a result of our safety system.'],
    ['Azure content filter', '{"error":{"code":"content_filter","message":"filtered"}}'],
    ['Azure policy', "triggering Azure OpenAI's content management policy"],
    ['Anthropic', 'Output blocked by content filtering policy'],
    ['Gemini block', 'Candidate was blocked due to SAFETY'],
  ])('recognises a content filter: %s', (_name, message) => {
    expect(classifyError(api(400, message), [])).toMatchObject({ code: 'CONTENT_FILTER' })
  })

  it.each([
    ['safety_settings', "Invalid value at 'safety_settings[0].threshold' (HarmBlockThreshold)"],
    ['safetySettings', 'Invalid JSON payload received. Unknown name "safetySettings"'],
    ['safety settings', 'Invalid safety settings: threshold BLOCK_NONE_X is not supported'],
    ['safety_identifier', 'safety_identifier must be at most 64 characters'],
  ])('does not treat the %s parameter error as a content filter', (_name, message) => {
    expect(classifyError(api(400, message, { isRetryable: false }), [])).toMatchObject({
      code: 'MODEL_ERROR',
      retryable: false,
    })
  })

  it('AC-006 classifies by the last error behind retries and missing output', () => {
    const retried = new RetryError({
      message: 'gave up',
      reason: 'maxRetriesExceeded',
      errors: [api(503), api(429)],
    })
    expect(classifyError(retried, [])).toMatchObject({ code: 'RATE_LIMITED', status: 429 })
    const wrapped = new NoOutputGeneratedError({ cause: retried })
    expect(classifyError(wrapped, [])).toMatchObject({ code: 'RATE_LIMITED' })
    expect(classifyError(new NoOutputGeneratedError(), [])).toMatchObject({ code: 'MODEL_ERROR' })
  })
})
