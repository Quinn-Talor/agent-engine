// 聊天端点的场景测试：脚本化模型，不联网。断言前端（useChat）拿到的消息，以及断线续流与审批续轮。

import { isToolUIPart, readUIMessageStream } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import type { RunUIMessage, RunUIMessageChunk } from 'agent-engine/adapters/ai-sdk'
import { FakeClock } from 'agent-engine/testing'
import { createChatApp } from './chat.ts'
import { clerkModel } from './clerk-model.ts'

type App = ReturnType<typeof createChatApp>
interface Frame {
  id?: number
  chunk: RunUIMessageChunk
}

const user = (text: string): RunUIMessage => ({
  id: 'u1',
  role: 'user',
  parts: [{ type: 'text', text }],
})
const post = (app: App, id: string, messages: RunUIMessage[]) =>
  app.handle(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, messages }),
    }),
  )
const resume = (app: App, id: string, lastEventId?: number) =>
  app.handle(
    new Request(`http://localhost/api/chat/${id}/stream`, {
      ...(lastEventId === undefined ? {} : { headers: { 'last-event-id': String(lastEventId) } }),
    }),
  )

/** 边读边拆 SSE：随时可以看已经收到的帧。 */
function read(res: Response) {
  const frames: Frame[] = []
  const done = (async () => {
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      buffer += r.value
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop()!
      for (const block of blocks) {
        const lines = block.split('\n')
        const id = lines.find((l) => l.startsWith('id: '))
        const data = lines.find((l) => l.startsWith('data: '))!.slice(6)
        if (data === '[DONE]') continue
        frames.push({
          ...(id ? { id: Number(id.slice(4)) } : {}),
          chunk: JSON.parse(data) as RunUIMessageChunk,
        })
      }
    }
  })()
  return { frames, done }
}

async function build(frames: Frame[]): Promise<RunUIMessage> {
  const stream = new ReadableStream<RunUIMessageChunk>({
    start(c) {
      for (const f of frames) c.enqueue(f.chunk)
      c.close()
    },
  })
  let last: RunUIMessage | undefined
  for await (const m of readUIMessageStream<RunUIMessage>({ stream })) last = m
  return last!
}

/** 委托人在页面上答复审批（useChat 的 addToolApprovalResponse）。 */
const answer = (m: RunUIMessage, approved: boolean): RunUIMessage => ({
  ...m,
  parts: m.parts.map((p) =>
    isToolUIPart(p) && p.state === 'approval-requested'
      ? { ...p, state: 'approval-responded' as const, approval: { id: p.approval.id, approved } }
      : p,
  ),
})

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('chat endpoint', () => {
  it('AC-015 streams a turn that waits for approval, and resumes nothing once it ended', async () => {
    const model = clerkModel()
    const app = createChatApp({ providers: [model], model: model.ref })
    const res = await post(app, 'c1', [user('给星河科技发律师函')])
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const turn = read(res)
    await turn.done
    const message = await build(turn.frames)
    expect(message.metadata).toMatchObject({ status: 'awaiting_input', code: 'approval_pending' })
    expect(message.parts.find(isToolUIPart)).toMatchObject({
      type: 'tool-send_letter',
      state: 'approval-requested',
      input: { to: '星河科技' },
    })
    await vi.waitFor(async () => expect((await resume(app, 'c1')).status).toBe(204))
    expect((await app.handle(new Request('http://localhost/nope'))).status).toBe(404)
  })

  it('AC-015 resumes a running turn from the start or from Last-Event-ID', async () => {
    const clock = new FakeClock()
    const model = clerkModel({ clock, delayMs: 1000 })
    const app = createChatApp({ providers: [model], model: model.ref })
    const live = read(await post(app, 'c2', [user('给星河科技发律师函')]))
    // 模型在等时钟：这一轮还在跑。
    while (clock.pending() === 0) await tick()
    await tick()
    const cursor = live.frames.findLast((f) => f.id !== undefined)!.id!
    const prefix = live.frames.slice(0, live.frames.findLastIndex((f) => f.id === cursor) + 1)
    const replay = read(await resume(app, 'c2'))
    const continued = read(await resume(app, 'c2', cursor))
    expect((await resume(app, 'c2', Number.NaN)).status).toBe(400)
    await clock.tick(1000)
    await Promise.all([live.done, replay.done, continued.done])

    const expected = await build(live.frames)
    expect(expected.parts.find(isToolUIPart)).toMatchObject({ state: 'approval-requested' })
    expect(await build(replay.frames)).toEqual(expected)
    expect(continued.frames.some((f) => f.chunk.type === 'start')).toBe(false)
    expect(await build([...prefix, ...continued.frames])).toEqual(expected)
  })

  it('AC-015 sends the letter in the next turn once the client approves it', async () => {
    const model = clerkModel()
    const app = createChatApp({ providers: [model], model: model.ref })
    const ask = user('给星河科技发律师函')
    const first = read(await post(app, 'c3', [ask]))
    await first.done
    const waiting = await build(first.frames)
    expect(app.outbox).toEqual([])

    const second = read(await post(app, 'c3', [ask, answer(waiting, true)]))
    await second.done
    const message = await build(second.frames)
    expect(app.outbox).toEqual(['星河科技'])
    expect(message.metadata).toMatchObject({ status: 'completed' })
    expect(message.parts.find(isToolUIPart)).toMatchObject({
      state: 'output-available',
      output: '已发给星河科技',
      approval: { approved: true },
    })
    expect(message.parts.filter((p) => p.type === 'text').at(-1)).toMatchObject({
      text: '律师函已发给星河科技。',
    })
  })
})
