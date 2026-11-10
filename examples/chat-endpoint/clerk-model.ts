// 演示用的文书助理模型：不联网、每次结果一样。像真实模型一样只看请求里的对话：
// 最后一条是工具结果就汇报，否则起草并发函。换成真实模型见 README。

import type { Clock } from 'agent-engine'
import { fakeModel } from 'agent-engine/testing'

export function clerkModel(opts: { clock?: Clock; delayMs?: number } = {}) {
  return fakeModel({
    provider: 'demo',
    model: 'clerk',
    repeatLast: true,
    ...(opts.clock ? { clock: opts.clock } : {}),
    replies: [
      (input) => ({
        ...(opts.delayMs ? { delayMs: opts.delayMs } : {}),
        ...(input.messages.at(-1)?.role === 'tool'
          ? { text: '律师函已发给星河科技。' }
          : {
              text: '我来起草并发出律师函。',
              toolCalls: [{ name: 'send_letter', input: { to: '星河科技' } }],
            }),
      }),
    ],
  })
}
