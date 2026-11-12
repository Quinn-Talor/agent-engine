// 聊天端点：把会话每一轮的运行转成 AI SDK 的 UI message stream，前端用 useChat 直接接上（设计 §2）。
// POST /api/chat 开会话的一轮；GET /api/chat/:id/stream 续流：useChat 的 resume 从头回放，
// 带 Last-Event-ID 的 SSE 重连从断点续上。处理函数是 Request → Response，Next.js、Hono 等都能直接挂。
// 发函要委托人审批：审批人稍后答复，这一轮停在待审批；委托人在页面上答复后，下一次 POST 带回答复、开下一轮。

import { getToolName, isToolUIPart } from 'ai'
import { z } from 'zod'
import {
  createEngine,
  defineAgent,
  defineTask,
  memoryArchive,
  modelHub,
  text,
  tools,
  type Approver,
  type ModelProvider,
  type ModelRef,
  type PermissionRule,
  type Run,
  type ToolDef,
} from '@talor/agent-engine'
import {
  runToUIMessageStreamResponse,
  type RunUIMessage,
} from '@talor/agent-engine/adapters/ai-sdk'

const instructions = [
  { role: 'system' as const, parts: [{ type: 'text' as const, text: '你是律所的文书助理。' }] },
]

/** 委托人的答复按"会话 + 工具 + 参数"记。 */
const keyOf = (session: string | undefined, tool: string, input: string | undefined) =>
  `${session}|${tool}|${input}`

export function createChatApp(opts: { providers: ModelProvider[]; model: ModelRef }) {
  const archive = memoryArchive()
  const engine = createEngine({
    services: { models: modelHub({ providers: opts.providers, default: opts.model }), archive },
  })

  const decisions = new Map<string, boolean>()
  const approver: Approver = {
    // 会话的一轮，subject 缺省就是会话 id。
    approve: async (req, run) => {
      const decided = decisions.get(keyOf(run.task.subject, req.toolName, req.detail?.input))
      return decided === undefined ? { defer: '等委托人在页面上确认' } : { approved: decided }
    },
  }
  const needsApproval: PermissionRule = {
    id: 'letters',
    version: '1',
    permit: async (call) =>
      call.toolName === 'send_letter'
        ? {
            ask: {
              summary: `发律师函给 ${(call.input as { to: string }).to}`,
              risk: 'high',
              detail: { input: JSON.stringify(call.input) },
            },
          }
        : 'allow',
  }

  /** 发出的律师函（收件方）。 */
  const outbox: string[] = []
  const sendLetter: ToolDef = {
    name: 'send_letter',
    description: '给对方发出律师函。',
    inputSchema: z.object({ to: z.string().min(1) }),
    execution: { effect: 'side_effect' },
    async execute(input) {
      const { to } = input as { to: string }
      outbox.push(to)
      return `已发给${to}`
    },
  }

  const env = engine.environment({
    name: 'web',
    principal: { reachable: true, approver },
    permissions: [needsApproval],
  })
  const agent = defineAgent({
    id: 'clerk',
    instructions,
    capabilities: [tools([sendLetter])],
    deliverable: { output: text() },
  })

  /** 每个会话正在跑的那一轮：续流用。 */
  const active = new Map<string, Run>()

  async function post(req: Request): Promise<Response> {
    const { id, messages } = (await req.json()) as { id?: string; messages?: RunUIMessage[] }
    const last = messages?.at(-1)
    if (!id || !last) return new Response('需要 id 与 messages', { status: 400 })
    let input: string
    if (last.role === 'assistant') {
      // 审批续轮：记下委托人在页面上的答复（useChat 的 addToolApprovalResponse）。
      for (const part of last.parts) {
        if (isToolUIPart(part) && part.state === 'approval-responded') {
          const key = keyOf(id, getToolName(part), JSON.stringify(part.input))
          decisions.set(key, part.approval.approved)
        }
      }
      input = '（委托人已答复审批）'
    } else {
      input = last.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n')
    }
    if (!input.trim()) return new Response('消息为空', { status: 400 })

    const task = defineTask({ input: [{ role: 'user', parts: [{ type: 'text', text: input }] }] })
    const run = env.start(agent, task, { session: id })
    active.set(id, run)
    void run.result.then(() => {
      if (active.get(id) === run) active.delete(id)
    })
    return runToUIMessageStreamResponse(run, { archive })
  }

  function resume(req: Request, id: string): Response {
    const run = active.get(id)
    if (!run) return new Response(null, { status: 204 })
    const lastEventId = req.headers.get('last-event-id')
    if (lastEventId !== null && !/^\d+$/.test(lastEventId)) {
      return new Response('Last-Event-ID 不合法', { status: 400 })
    }
    const fromSeq = lastEventId === null ? 1 : Number(lastEventId) + 1
    return runToUIMessageStreamResponse(run, { archive, fromSeq })
  }

  return {
    outbox,
    async handle(req: Request): Promise<Response> {
      const { pathname } = new URL(req.url)
      if (req.method === 'POST' && pathname === '/api/chat') return post(req)
      const stream = /^\/api\/chat\/([^/]+)\/stream$/.exec(pathname)
      if (req.method === 'GET' && stream) return resume(req, decodeURIComponent(stream[1]!))
      return new Response('not found', { status: 404 })
    },
  }
}
