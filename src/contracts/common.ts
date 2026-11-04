// 通用契约：JSON 值、消息与片段、作业范围、凭据引用、时钟与诊断日志。

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** JSON Schema 对象；引擎只传递，不解释其结构。 */
export type JsonSchema = { [key: string]: unknown }

export interface TextPart {
  type: 'text'
  text: string
}

export interface ImagePart {
  type: 'image'
  image: string | Uint8Array
  mediaType?: string
}

export interface FilePart {
  type: 'file'
  data: string | Uint8Array
  mediaType: string
  filename?: string
}

export type ContentPart = TextPart | ImagePart | FilePart

/** 指令、须知、任务输入的片段（设计 §2）。 */
export type Segment = { role: 'system' | 'user'; parts: ContentPart[] }

export interface ReasoningPart {
  type: 'reasoning'
  text: string
  /** 厂商签名等数据；回放时原样带回（设计 §8.1）。 */
  providerData?: unknown
}

export interface ToolCallPart {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: unknown
  /** 厂商私有数据（例如 Gemini 的 thoughtSignature），回放时原样带回。 */
  providerData?: unknown
}

export interface ToolResultPart {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  /** 模型实际看到的内容（设计 §6.2 `shown`）。 */
  output: string
  isError?: boolean
  /** 结果里展示给模型的图片（base64），紧跟在文本之后。 */
  images?: ImagePart[]
}

/** 引擎自有的消息类型，结构与 AI SDK 兼容，由适配器互转（方案 D11）。 */
export type ModelMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | Array<TextPart | ReasoningPart | ToolCallPart> }
  | { role: 'tool'; content: ToolResultPart[] }

export interface TaskScope {
  /** 工作区绝对路径。 */
  workspace?: string
}

/** 凭据引用：只按引用解析，解析结果不进业务对象和日志（设计 §5.1）。 */
export interface SecretRef {
  secret: string
  /** 值里嵌着凭据时的模板，例如 `Bearer ${TOKEN}`：解析时把 `${<secret>}` 换成凭据。 */
  template?: string
}

export interface SecretResolver {
  resolve(ref: SecretRef): Promise<string>
}

/** 统一时间来源（设计 §3.14"所有时间都取自时钟"）。 */
export interface Clock {
  now(): number
  /** 到时调用 `fn`；返回取消函数。 */
  setTimer(ms: number, fn: () => void): () => void
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  level: LogLevel
  message: string
  runId?: string
  step?: number
  source?: string
  detail?: unknown
}

/** 诊断日志端口：不进运行日志，不参与回放（设计 §6.6）。 */
export interface Logger {
  log(entry: LogEntry): void
}
